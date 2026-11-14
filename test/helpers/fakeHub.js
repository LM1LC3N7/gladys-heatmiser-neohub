// -----------------------------------------------------------------------------
// A fake neoHub behind a fake client with the contract of src/neohub/client.js
// (one command at a time, protective ones first, a request of the polling cut
// after 1 s for them, `beforeSend` / `onSent`, `sent` on every error after
// the send), on the virtual clock of the tests. The commands change the
// world as the PDF describes them; `world.apply = false` answers without
// doing anything.
// -----------------------------------------------------------------------------

import { TIMINGS } from '../../src/constants.js';
import { NeoHubError } from '../../src/neohub/errors.js';
import { encodeCommand } from '../../src/neohub/protocol.js';

export const HUB = 'd88039ad0df0';

export const ZONE = (over = {}) => ({
  DEVICE_ID: 1,
  ZONE_NAME: 'Living room',
  THERMOSTAT: true,
  ACTUAL_TEMP: '20.5',
  SET_TEMP: '21.0',
  STANDBY: false,
  AWAY: false,
  HOLIDAY: false,
  OFFLINE: false,
  WRITE_COUNT: 3,
  PIN_NUMBER: '4321',
  RECENT_TEMPS: ['20.1', '20.3'],
  ...over,
});

export function fakeHub({ zones = [ZONE()], hubId = HUB, unit = 'C' } = {}) {
  const world = {
    hubId,
    unit,
    zones,
    hubAway: false,
    hubHoliday: false,
    systemStamp: 100,
    latency: 20,
    /** (name) -> the latency of that command (ms), or undefined for `latency`. */
    delay: undefined,
    apply: true,
    /** (name, argument) -> { kind, sent, text } to fail that command, or undefined. */
    fail: undefined,
    /** (name) -> true: that command is never answered (until its deadline or a cut). */
    hang: undefined,
    sent: [],
    clients: [],
    clock: undefined,
  };
  world.count = (name) => world.sent.filter((s) => s.name === name).length;
  world.zone = (id) => world.zones.find((z) => z.DEVICE_ID === id);
  world.createClient = (options) => {
    const client = new FakeClient(world, options);
    world.clients.push(client);
    return client;
  };
  return world;
}

function effect(world, name, argument) {
  const byName = (n) => world.zones.find((z) => z.ZONE_NAME === n);
  switch (name) {
    case 'GET_LIVE_DATA':
      return {
        HUB_AWAY: world.hubAway,
        HUB_HOLIDAY: world.hubHoliday,
        TIMESTAMP_SYSTEM: world.systemStamp,
        devices: structuredClone(world.zones),
      };
    case 'GET_SYSTEM':
      return { CORF: world.unit, DEVICE_ID: 'neoHub', HUB_VERSION: 2153 };
    case 'SET_TEMP': {
      const zone = byName(argument[1][0]);
      if (!zone) return { error: 'Could not find device' };
      if (world.apply) zone.SET_TEMP = argument[0].toFixed(1);
      return { result: 'temperature was set' };
    }
    case 'FROST_ON':
    case 'FROST_OFF': {
      const zone = byName(argument[0]);
      if (!zone) return { error: 'Could not find device' };
      if (world.apply) zone.STANDBY = name === 'FROST_ON';
      return { result: name === 'FROST_ON' ? 'frost on' : 'frost off' };
    }
    case 'AWAY_ON':
    case 'AWAY_OFF':
      if (world.apply) {
        world.hubAway = name === 'AWAY_ON';
        for (const zone of world.zones) {
          zone.AWAY = world.hubAway;
          zone.STANDBY = world.hubAway;
        }
      }
      return { result: name === 'AWAY_ON' ? 'away on' : 'away off' };
    default:
      return { error: 'Invalid Json' };
  }
}

class FakeClient {
  constructor(world, options) {
    this.world = world;
    this.options = options;
    this.holder = undefined;
    this.high = [];
    this.low = [];
    this.stopped = false;
    this.inflight = 0;
  }

  get monotonic() {
    return this.options.monotonic;
  }

  acquire(priority) {
    const holder = { priority, startedAt: undefined, onCut: undefined, cut: false };
    if (!this.holder) {
      this.holder = holder;
      holder.startedAt = this.monotonic();
      return Promise.resolve(holder);
    }
    if (priority && !this.holder.priority) {
      const current = this.holder;
      const wait = Math.max(0, current.startedAt + TIMINGS.stuckRead - this.monotonic());
      this.options.timers.setTimeout(() => {
        if (this.holder === current) {
          current.cut = true;
          current.onCut?.();
        }
      }, wait);
    }
    return new Promise((resolve) => {
      (priority ? this.high : this.low).push(() => {
        this.holder = holder;
        holder.startedAt = this.monotonic();
        resolve(holder);
      });
    });
  }

  release(holder) {
    if (this.holder !== holder) return;
    this.holder = undefined;
    const next = this.high.shift() ?? this.low.shift();
    if (next) next();
  }

  async request(name, argument, { deadline, priority = false, beforeSend, onSent } = {}) {
    encodeCommand(name, argument);
    const holder = await this.acquire(priority);
    try {
      return await this.exchange(holder, name, argument, { deadline, beforeSend, onSent });
    } finally {
      this.release(holder);
    }
  }

  async exchange(holder, name, argument, { deadline, beforeSend, onSent }) {
    const { world } = this;
    if (this.stopped) throw new NeoHubError('stopped', 'stopped');
    if (holder.cut) throw new NeoHubError('cut', 'cut');
    if (!this.options.pin) throw new NeoHubError('nopin', 'certificate not pinned');
    if (this.monotonic() >= deadline) throw new NeoHubError('late', 'too late to send');
    const failure = world.fail?.(name, argument);
    if (failure && !failure.sent) {
      await world.clock.sleep(5);
      throw new NeoHubError(failure.kind, 'injected', failure);
    }
    beforeSend?.();
    world.sent.push({
      name,
      argument: structuredClone(argument),
      at: this.monotonic(),
      priority: holder.priority,
      token: this.options.token,
    });
    onSent?.();
    const hang = world.hang?.(name);
    const answer = await new Promise((resolve) => {
      const timers = this.options.timers;
      const t1 = hang
        ? undefined
        : timers.setTimeout(() => resolve('answer'), world.delay?.(name) ?? world.latency);
      const t2 = timers.setTimeout(
        () => resolve('timeout'),
        Math.max(0, deadline - this.monotonic()),
      );
      holder.onCut = () => {
        timers.clearTimeout(t1);
        timers.clearTimeout(t2);
        resolve('cut');
      };
    });
    holder.onCut = undefined;
    if (answer === 'cut') throw new NeoHubError('cut', 'cut', { sent: true });
    if (answer === 'timeout') throw new NeoHubError('timeout', 'no answer', { sent: true });
    if (failure) throw new NeoHubError(failure.kind, 'injected', { ...failure, sent: true });
    const response = effect(world, name, argument);
    if (typeof response.error === 'string') {
      throw new NeoHubError('hub', 'the hub answered an error', {
        sent: true,
        text: response.error,
      });
    }
    return { hubId: world.hubId, response };
  }

  stop() {
    this.stopped = true;
  }
}
