// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local WSS hub: the reads really start, at 0, the interval and twice
// the interval, with a bounded number of timers; a standby leaves at once.
// The time is sped up 20 times (60 s of the interval are 3 s) but it is the
// real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NeoHubApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { ZONE } from './helpers/fakeHub.js';
import { wssHub } from './helpers/wssHub.js';

const SPEED = 20;
const INTERVAL = POLL_INTERVAL.default * 1000;
const TOKEN = 'tok-123456789';

test('real clock: reads at 0, the interval and twice the interval; a standby at once', async (t) => {
  const reads = [];
  const zone = ZONE();
  const hub = await wssHub({
    token: TOKEN,
    onCommand: (command) => {
      if (command === "{'GET_LIVE_DATA':0}") {
        return { HUB_AWAY: false, HUB_HOLIDAY: false, TIMESTAMP_SYSTEM: 1, devices: [zone] };
      }
      if (command === "{'GET_SYSTEM':0}") return { CORF: 'C' };
      if (command === "{'FROST_ON':['Living room']}") {
        zone.STANDBY = true;
        return { result: 'frost on' };
      }
      return { error: 'Invalid Json' };
    },
  });
  let timersSet = 0;
  const live = new Set();
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const id = setTimeout(
        () => {
          live.delete(id);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(id);
      return id;
    },
    clearTimeout: (id) => {
      live.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms) / SPEED),
    clearInterval: (id) => clearInterval(id),
  };
  const gladys = createFakeGladys({ selector: 'neohub-test', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new NeoHubApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: memoryStore(),
  });
  // The rounds of the polling (the reads after a command are not rounds).
  const succeeded = app.succeeded.bind(app);
  app.succeeded = (...args) => {
    reads.push(performance.now() * SPEED);
    return succeeded(...args);
  };
  t.after(async () => {
    app.stop();
    for (const id of live) clearTimeout(id);
    await hub.close();
  });
  const started = performance.now() * SPEED;
  registerHandlers(gladys, app, { error: quiet });
  await app.connected({
    host: `127.0.0.1:${hub.port}`,
    api_token: TOKEN,
    certificate_fingerprint: hub.fingerprint256,
  });
  const deadline = started + INTERVAL;
  while (reads.length === 0 && performance.now() * SPEED < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // A standby asked between two reads leaves at once (not at the next read).
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith('-1'));
  const asked = performance.now() * SPEED;
  const ack = await gladys.fake.setValue(
    device,
    { external_id: `${device.external_id}:mode` },
    'standby',
  );
  const answered = performance.now() * SPEED;
  assert.equal(ack.success, true, ack.error);
  assert.ok(answered - asked < 5000, `ack after ${Math.round(answered - asked)} simulated ms`);
  const until = (reads[0] ?? started) + 2.5 * INTERVAL;
  while (performance.now() * SPEED < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  app.stop();
  const polling = reads;
  const at = polling.map((r) => Math.round(r - started));
  assert.equal(polling.length, 3, `reads at ${at}`);
  assert.ok(polling[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < polling.length; i += 1) {
    const gap = polling[i] - polling[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 40, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
