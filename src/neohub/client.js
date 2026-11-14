// -----------------------------------------------------------------------------
// The connection to the hub: one WebSocket over a pinned TLS socket
// (src/neohub/tls.js), kept open between the commands as the PDF advises,
// one command at a time (never a pipeline), each awaited until its deadline.
//
// - A command waits its turn in the lane; a protective one (standby, away)
//   goes before every waiting one, and cuts a request of the polling that
//   has been in flight (or opening its connection) for 1 s without an answer:
//   that connection is closed, and the new one opens only once the old one is
//   closed (or 0.5 s later).
// - Only the answer to the command sent is taken (same command id, the answer
//   type of the PDF, the hub id readable); any other frame is ignored. The hub
//   id seen on a connection never changes on that connection.
// - A command that may have left (`send` returned) is never "not sent":
//   `sent: true` on every error after that point. `beforeSend()` runs right
//   before the first byte and may throw to cancel (nothing sent).
// - Frames are bounded (`maxPayload`, checked by ws before the frame is
//   complete). The token is never logged nor put in an error message.
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { API, LIMITS, TIMINGS } from '../constants.js';
import { NeoHubError } from './errors.js';
import { buildRequest, cleanText, encodeCommand, parseFrame, responseError } from './protocol.js';
import { connectPinned } from './tls.js';

export class NeoHubClient {
  constructor({
    host,
    port,
    pin,
    token,
    monotonic = () => performance.now(),
    timers = globalThis,
    connect = connectPinned,
  }) {
    this.host = host;
    this.port = port;
    this.pin = pin;
    this.token = token;
    this.monotonic = monotonic;
    this.timers = timers;
    this.connect = connect;
    this.ws = undefined;
    this.opening = undefined;
    this.closing = undefined;
    this.nextId = 0;
    /** The lane: the holder, and those waiting (protective ones first). */
    this.holder = undefined;
    this.high = [];
    this.low = [];
    this.inflight = undefined;
    this.sessionHub = undefined;
    this.answered = false;
    this.stopped = false;
    this.cutTimer = undefined;
  }

  // --- The lane ---------------------------------------------------------------

  /** The lane, waited for until `until` (monotonic) at most: past it, 'late' (nothing sent). */
  acquire(priority, until) {
    const holder = { priority, startedAt: undefined, onCut: undefined, cut: false };
    if (!this.holder) {
      this.holder = holder;
      holder.startedAt = this.monotonic();
      return Promise.resolve(holder);
    }
    if (priority) {
      this.armCut();
    }
    return new Promise((resolve, reject) => {
      const list = priority ? this.high : this.low;
      let timer;
      const turn = () => {
        this.timers.clearTimeout(timer);
        this.holder = holder;
        holder.startedAt = this.monotonic();
        resolve(holder);
      };
      list.push(turn);
      if (Number.isFinite(until)) {
        timer = this.timers.setTimeout(
          () => {
            const i = list.indexOf(turn);
            if (i >= 0) {
              list.splice(i, 1);
              reject(new NeoHubError('late', 'its turn did not come in time'));
            }
          },
          Math.max(0, until - this.monotonic()),
        );
      }
    });
  }

  release(holder) {
    if (this.holder !== holder) {
      return;
    }
    this.holder = undefined;
    this.timers.clearTimeout(this.cutTimer);
    this.cutTimer = undefined;
    const next = this.high.shift() ?? this.low.shift();
    if (next) {
      next();
      if (this.high.length > 0) {
        this.armCut();
      }
    }
  }

  /** A protective command waits: the request of the polling holding the lane is cut at 1 s. */
  armCut() {
    const holder = this.holder;
    if (!holder || holder.priority || this.cutTimer !== undefined) {
      return;
    }
    const wait = Math.max(0, holder.startedAt + TIMINGS.stuckRead - this.monotonic());
    this.cutTimer = this.timers.setTimeout(() => {
      this.cutTimer = undefined;
      if (this.holder === holder && !holder.priority) {
        holder.cut = true;
        holder.onCut?.();
      }
    }, wait);
  }

  // --- The connection ---------------------------------------------------------

  /** Closes the socket; a new one opens only once it is closed (or 0.5 s later). */
  drop() {
    const ws = this.ws;
    this.ws = undefined;
    this.sessionHub = undefined;
    this.answered = false;
    if (!ws) {
      return;
    }
    this.closing = new Promise((resolve) => {
      const timer = this.timers.setTimeout(resolve, TIMINGS.closeWait);
      ws.once('close', () => {
        this.timers.clearTimeout(timer);
        resolve();
      });
      try {
        ws.terminate();
      } catch {
        resolve();
      }
    }).finally(() => {
      this.closing = undefined;
    });
  }

  /** The socket lost by itself: the command in flight fails (it may have been done). */
  lost(ws, kind) {
    if (this.ws !== ws) {
      return;
    }
    this.drop();
    const inflight = this.inflight;
    if (inflight) {
      inflight.fail(
        new NeoHubError(
          kind,
          kind === 'size' ? 'answer too large' : 'connection closed before the answer',
          { sent: true, first: inflight.first },
        ),
      );
    }
  }

  async open(holder, deadline) {
    if (this.ws) {
      return this.ws;
    }
    if (this.closing) {
      await this.closing;
    }
    if (this.stopped) {
      throw new NeoHubError('stopped', 'stopped');
    }
    let socket;
    const timeout = Math.max(1, Math.min(TIMINGS.connectTimeout, deadline - this.monotonic()));
    const cut = new Promise((_resolve, reject) => {
      holder.onCut = () => {
        socket?.destroy();
        reject(new NeoHubError('cut', 'cut for a protective command'));
      };
    });
    cut.catch(() => {});
    try {
      return await Promise.race([cut, this.openSocket(timeout, (s) => (socket = s))]);
    } catch (err) {
      socket?.destroy();
      throw err;
    } finally {
      holder.onCut = undefined;
    }
  }

  async openSocket(timeout, onSocket) {
    const socket = await this.connect({
      host: this.host,
      port: this.port,
      pin: this.pin,
      timeout,
      timers: this.timers,
      onSocket,
    });
    return new Promise((resolve, reject) => {
      const shown = this.host.includes(':') ? `[${this.host}]` : this.host;
      let ws;
      try {
        ws = new WebSocket(`ws://${shown}:${this.port}/`, {
          createConnection: () => socket,
          maxPayload: LIMITS.frameBytes,
          handshakeTimeout: timeout,
          perMessageDeflate: false,
          followRedirects: false,
        });
      } catch {
        socket.destroy();
        reject(new NeoHubError('network', 'cannot open the socket'));
        return;
      }
      let open = false;
      const fail = (err) => {
        if (open) return;
        open = true;
        try {
          ws.terminate();
        } catch {
          // Already closed.
        }
        socket.destroy();
        reject(err);
      };
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode;
        res.resume();
        // The token is not sent on the upgrade: an HTTP refusal is never a refused token.
        fail(new NeoHubError('protocol', `WebSocket refused (HTTP ${status})`));
      });
      ws.on('open', () => {
        if (open) return;
        open = true;
        if (this.stopped) {
          ws.terminate();
          reject(new NeoHubError('stopped', 'stopped'));
          return;
        }
        this.ws = ws;
        this.sessionHub = undefined;
        this.answered = false;
        resolve(ws);
      });
      ws.on('message', (data, isBinary) => this.onMessage(ws, data, isBinary));
      ws.on('close', () => {
        fail(new NeoHubError('network', 'connection closed'));
        this.lost(ws, 'closed');
      });
      // The error of ws may quote the request: never its text.
      ws.on('error', (err) => {
        const kind = err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'size' : 'network';
        fail(new NeoHubError(kind, kind === 'size' ? 'answer too large' : 'connection lost'));
        this.lost(ws, kind);
      });
    });
  }

  onMessage(ws, data, isBinary) {
    const inflight = this.inflight;
    if (ws !== this.ws || !inflight || isBinary) {
      return;
    }
    const frame = parseFrame(data.toString('utf8'));
    if (frame.invalid || frame.commandId !== inflight.id) {
      // Not the answer to the command in flight: ignored.
      return;
    }
    if (frame.type !== API.responseType) {
      inflight.fail(new NeoHubError('protocol', 'unexpected answer type', { sent: true }));
      this.drop();
      return;
    }
    if (!frame.hubId || (this.sessionHub && frame.hubId !== this.sessionHub)) {
      inflight.fail(new NeoHubError('identity', 'hub identity unreadable', { sent: true }));
      this.drop();
      return;
    }
    this.sessionHub = frame.hubId;
    this.answered = true;
    const error = responseError(frame.response);
    if (error?.token) {
      inflight.fail(
        new NeoHubError('token', 'token refused by the hub', {
          sent: true,
          text: cleanText(error.text, this.token),
        }),
      );
      return;
    }
    if (error) {
      inflight.fail(
        new NeoHubError('hub', 'the hub answered an error', {
          sent: true,
          text: cleanText(error.text, this.token),
        }),
      );
      return;
    }
    inflight.done({ hubId: frame.hubId, response: frame.response });
  }

  // --- Commands ---------------------------------------------------------------

  /**
   * One command (a name of API.commands and its argument) -> `{ hubId,
   * response }`. Options: `deadline` (monotonic: the answer awaited until
   * it), `sendBy` (not sent past it, the turn in the lane awaited until it;
   * the deadline when absent), `priority` (a protective command),
   * `beforeSend()`, `onSent()` (the command left). `argument` may be a
   * function, called right before the first byte (after `beforeSend`).
   */
  async request(
    name,
    argument,
    { deadline, sendBy = deadline, priority = false, beforeSend, onSent } = {},
  ) {
    if (typeof argument !== 'function') {
      encodeCommand(name, argument);
    }
    const holder = await this.acquire(priority, sendBy);
    try {
      return await this.exchange(holder, name, argument, { deadline, sendBy, beforeSend, onSent });
    } finally {
      this.release(holder);
    }
  }

  async exchange(holder, name, argument, { deadline, sendBy, beforeSend, onSent }) {
    if (this.stopped) {
      throw new NeoHubError('stopped', 'stopped');
    }
    if (holder.cut) {
      throw new NeoHubError('cut', 'cut for a protective command');
    }
    if (this.monotonic() >= sendBy) {
      throw new NeoHubError('late', 'too late to send');
    }
    const ws = await this.open(holder, sendBy);
    if (holder.cut) {
      throw new NeoHubError('cut', 'cut for a protective command');
    }
    if (this.monotonic() >= sendBy) {
      throw new NeoHubError('late', 'too late to send');
    }
    // May throw: nothing sent.
    beforeSend?.();
    const command = encodeCommand(name, typeof argument === 'function' ? argument() : argument);
    this.nextId = this.nextId >= 1e9 ? 1 : this.nextId + 1;
    const id = this.nextId;
    const first = !this.answered;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        this.timers.clearTimeout(timer);
        if (this.inflight?.id === id) this.inflight = undefined;
        holder.onCut = undefined;
      };
      const inflight = {
        id,
        first,
        done: (value) => {
          if (settled) return;
          finish();
          resolve(value);
        },
        fail: (err) => {
          if (settled) return;
          finish();
          reject(err);
        },
      };
      const timer = this.timers.setTimeout(
        () => {
          // A late answer would come on this connection: closed, a new one for the next command.
          this.drop();
          inflight.fail(new NeoHubError('timeout', 'no answer in time', { sent: true, first }));
        },
        Math.max(0, deadline - this.monotonic()),
      );
      this.inflight = inflight;
      holder.onCut = () => {
        this.drop();
        inflight.fail(new NeoHubError('cut', 'cut for a protective command', { sent: true }));
      };
      try {
        ws.send(buildRequest(this.token, command, id));
      } catch {
        this.drop();
        inflight.fail(new NeoHubError('network', 'connection lost', { sent: false }));
        return;
      }
      onSent?.();
    });
  }

  /** Stops for good: the socket closed, every command waiting refused. */
  stop() {
    this.stopped = true;
    this.inflight?.fail(new NeoHubError('stopped', 'stopped', { sent: true }));
    this.drop();
    this.timers.clearTimeout(this.cutTimer);
    this.cutTimer = undefined;
  }
}
