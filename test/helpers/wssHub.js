// -----------------------------------------------------------------------------
// A neoHub on a real local WSS server (127.0.0.1, its own self-signed
// certificate): the envelope of the PDF, the token checked, one answer per
// command (or none). Counts the TCP connections, the bytes received on them
// (before and after the TLS handshake) and the WebSocket clients open at
// once.
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { selfSigned } from './certs.js';

let shared;
/** One certificate per test run (RSA generation is slow). */
export const certificate = () => (shared ??= selfSigned('neohub'));

export async function wssHub({
  token = 'tok-123456789',
  deviceId = 'D8:80:39:AD:0D:F0',
  cert = certificate(),
  onCommand = () => ({ result: 'ok' }),
} = {}) {
  const hub = {
    tcp: 0,
    commands: [],
    open: 0,
    peak: 0,
    inflight: 0,
    peakInflight: 0,
    tokens: [],
    fingerprint256: cert.fingerprint256,
  };
  const server = createServer({ key: cert.key, cert: cert.cert });
  server.on('connection', () => (hub.tcp += 1));
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    hub.open += 1;
    hub.peak = Math.max(hub.peak, hub.open);
    ws.on('close', () => (hub.open -= 1));
    ws.on('error', () => {});
    ws.on('message', async (raw) => {
      let outer;
      let inner;
      try {
        outer = JSON.parse(raw.toString());
        inner = JSON.parse(outer.message);
      } catch {
        return;
      }
      hub.tokens.push(inner.token);
      const { COMMAND: command, COMMANDID: id } = inner.COMMANDS[0];
      hub.commands.push({ command, id, at: performance.now() });
      hub.inflight += 1;
      hub.peakInflight = Math.max(hub.peakInflight, hub.inflight);
      let answer;
      try {
        answer =
          inner.token === token ? await onCommand(command, { id, ws }) : { error: 'Invalid token' };
      } finally {
        hub.inflight -= 1;
      }
      if (answer === undefined || ws.readyState !== ws.OPEN) return;
      ws.send(
        typeof answer === 'string' && answer.startsWith('RAW:')
          ? answer.slice(4)
          : JSON.stringify({
              command_id: id,
              device_id: deviceId,
              message_type: 'hm_set_command_response',
              response: JSON.stringify(answer),
            }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  hub.port = server.address().port;
  hub.close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return hub;
}
