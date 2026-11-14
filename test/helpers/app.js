// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake hub and a virtual clock. The
// monotonic clock moves 1 µs per read of it, so that a decision reading the
// clock twice is caught (lesson of the lot 15).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NeoHubApp } from '../../src/app.js';
import { buildHubDevice, buildZoneDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { parseZone } from '../../src/neohub/model.js';
import { memoryStore } from '../../src/store.js';
import { HUB, ZONE, fakeHub } from './fakeHub.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'neohub-test';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
export const TOKEN = 'tok-3f9a1c2e-5b7d-4e1f-9a0b-c1d2e3f4a5b6';
export const PIN = Array.from({ length: 32 }, (_, i) =>
  (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0'),
).join(':');
export const CONFIG = { host: '192.168.1.40', api_token: TOKEN, certificate_fingerprint: PIN };
export { HUB, ZONE };

/** The external ids of a zone (default: zone 1) and of its features. */
export const DEV = (zone = 1) => `ext:${SELECTOR}:neohub:${HUB}-${zone}`;
export const F = (role, zone = 1) => `${DEV(zone)}:${role}`;

/** The device of a zone as the user created it from the Discovery list. */
export function created(over = {}, { language = 'fr' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const zone = parseZone(ZONE(over));
  return buildZoneDevice(gladys, { hub: HUB, id: zone.id }, { zone, language });
}

export function createdHub({ language = 'fr' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildHubDevice(gladys, HUB, { language });
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export async function setup({
  devices: known = [created()],
  store,
  now = NOW,
  world = fakeHub(),
  config = CONFIG,
  fingerprint = async () => PIN,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  world.clock = clock;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? memoryStore();
  const app = new NeoHubApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    createClient: world.createClient,
    fingerprint,
    now: () => clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store: kept,
  });
  registerHandlers(gladys, app, { error: log });
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  /** Awaits a promise while the virtual clock moves (100 ms steps). */
  const act = async (promise, max = 60_000) => {
    let done = false;
    const result = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error) => {
        done = true;
        return { error };
      },
    );
    await settle();
    for (let t = 0; !done && t < max; t += 50) {
      await advance(50);
      await settle();
    }
    if (!done) throw new Error('the promise did not settle');
    const { value, error } = await result;
    if (error) throw error;
    return value;
  };
  /** The first connection, as in production (Gladys already connected); the clock moves meanwhile. */
  const start = async (cfg = config) => {
    await act(app.connected(cfg));
    await settle();
  };
  /** A command through the fake Gladys, its ack awaited while the clock moves. */
  const cmd = (
    feature,
    value,
    device = gladys.devices.find((d) => feature.startsWith(`${d.external_id}:`)),
  ) => act(gladys.fake.setValue(device, { external_id: feature }, value));
  /** The last state published for a feature. */
  const state = (feature) => gladys.fake.lastState(feature);
  return { app, gladys, clock, store: kept, world, start, wait, advance, act, cmd, state, lines };
}
