// -----------------------------------------------------------------------------
// The points of the first review (r1), one test each: zones addressed by
// their device number, a stop never sent after a newer "Schedule", no resend
// with a refused token, the ceiling rounded down, a change of unit, /data read
// before written, acks by ~3.4 s, scenes, and the guards its mutants proved
// untested.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, tokenTag } from '../src/config.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import {
  CONFIG,
  F,
  HUB,
  MINUTE,
  PIN,
  SECOND,
  ZONE,
  created,
  createdHub,
  settle,
  setup,
} from './helpers/app.js';
import { fakeHub } from './helpers/fakeHub.js';

const ON = { ...CONFIG, allow_heating: true };
const HUB_AWAY = `ext:neohub-test:neohub:${HUB}-hub:away`;
const two = () => [ZONE(), ZONE({ DEVICE_ID: 2, ZONE_NAME: 'Hall' })];

// --- B-1: zones by device number --------------------------------------------------

test('B-1 names swapped in the app: the standby goes to the zone by its number, never to the other', async () => {
  const world = fakeHub({ zones: two() });
  const devices = world.zones.map((z) => created(z));
  const { start, cmd, wait } = await setup({ world, devices });
  await start();
  world.zones[0].ZONE_NAME = 'Hall';
  world.zones[1].ZONE_NAME = 'Living room';
  await wait(MINUTE);
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.sent.find((s) => s.name === 'FROST_ON').argument, [1]);
  assert.equal(world.zone(1).STANDBY, true);
  assert.equal(world.zone(2).STANDBY, false);
});

test('B-1 a zone renamed since the last read: a setpoint refused, then accepted after a read', async () => {
  const world = fakeHub();
  const { start, cmd, wait } = await setup({ world, config: ON });
  await start();
  world.zones[0].ZONE_NAME = 'Lounge';
  let ack = await cmd(F('target-temperature'), 20);
  assert.match(ack.error, /renommée/);
  // The fresh read of that command is the last read now: the next command goes.
  await wait(SECOND);
  ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.sent.find((s) => s.name === 'SET_TEMP').argument, [20, [1]]);
});

// --- I-1: never a stop after a newer Schedule -------------------------------------

test('I-1 a standby retried while a newer "Schedule" leaves is never sent after it', async () => {
  const world = fakeHub({ zones: [ZONE({ STANDBY: false })] });
  const { gladys, clock, start, act } = await setup({ world, config: ON });
  await start();
  const t0 = clock.now;
  // The standby cannot leave for 200 ms (not sent, tried again every 50 ms).
  world.fail = (name) =>
    name === 'FROST_ON' && clock.now - t0 < 200 ? { kind: 'network', sent: false } : undefined;
  const device = gladys.devices[0];
  const standby = gladys.fake.setValue(device, { external_id: F('mode') }, 'standby');
  await settle();
  const schedule = gladys.fake.setValue(device, { external_id: F('mode') }, 'schedule');
  const [first, second] = await act(Promise.all([standby, schedule]));
  assert.equal(second.success, true, second.error);
  assert.equal(first.success, false);
  const frostOff = world.sent.findIndex((s) => s.name === 'FROST_OFF');
  assert.ok(frostOff >= 0);
  assert.ok(world.sent.slice(frostOff).every((s) => s.name !== 'FROST_ON'));
  assert.equal(world.zone(1).STANDBY, false);
});

test('I-1 the lift of a stop is written to /data before "Schedule" leaves; a failing /data refuses it', async () => {
  const store = memoryStore();
  const world = fakeHub();
  const { app, start, cmd, clock } = await setup({ store, world, config: ON });
  await start();
  world.fail = (name) => (name === 'FROST_ON' ? { kind: 'timeout', sent: true } : undefined);
  world.apply = false;
  await cmd(F('mode'), 'standby');
  assert.equal(store.data.guards.length, 1);
  world.fail = undefined;
  world.apply = true;
  const save = store.save.bind(store);
  store.save = async () => {
    throw new Error('EIO');
  };
  let ack = await cmd(F('mode'), 'schedule');
  assert.match(ack.error, /\/data n’a pas pu garder/);
  assert.equal(world.count('FROST_OFF'), 0);
  store.save = save;
  ack = await cmd(F('mode'), 'schedule');
  assert.ok(ack.success || /Envoyé/.test(ack.error), ack.error);
  assert.deepEqual(store.data.guards, [], 'the lifted guard is not kept in /data');
  app.stop();
  // A restart sends no stop.
  const sentBefore = world.count('FROST_ON');
  const next = await setup({ store, world, now: clock.now + SECOND, config: ON });
  await next.start();
  assert.equal(world.count('FROST_ON'), sentBefore);
  next.app.stop();
});

// --- I-2: no automatic resend with a refused token ----------------------------------

test('I-2 a refused token: a stop kept in /data is not sent by itself at restart', async () => {
  const store = memoryStore();
  const world = fakeHub();
  const { app, start, cmd, clock, act } = await setup({ store, world });
  await start();
  world.fail = (name) => (name === 'FROST_ON' ? { kind: 'network', sent: false } : undefined);
  await cmd(F('mode'), 'standby');
  world.fail = () => ({ kind: 'token', sent: true });
  app.lastReadAt = -Infinity;
  await act(app.tick());
  assert.equal(app.refused, true);
  assert.equal(store.data.guards[0].pending, true);
  app.stop();
  world.fail = undefined;
  const next = await setup({ store, world, now: clock.now + SECOND });
  await next.start();
  await next.wait(10 * MINUTE);
  assert.equal(world.count('FROST_ON'), 0);
  next.app.stop();
});

// --- I-3: the ceiling rounded down -----------------------------------------------------

test('I-3 the ceiling is rounded down to 0.5 °C: 22.7 and 22.5 give 22.5, 23 refused', async () => {
  assert.equal(normalizeConfig({ max_setpoint: 22.7 }).ceiling, 22.5);
  assert.equal(normalizeConfig({ max_setpoint: 22.5 }).ceiling, 22.5);
  assert.equal(normalizeConfig({ max_setpoint: '22.99' }).ceiling, 22.5);
  const { world, start, cmd } = await setup({ config: { ...ON, max_setpoint: 22.7 } });
  await start();
  const ack = await cmd(F('target-temperature'), 23);
  assert.equal(ack.success, false);
  assert.equal(world.count('SET_TEMP'), 0);
  assert.equal((await cmd(F('target-temperature'), 22.5)).success, true);
});

// --- I-4: a change of unit -----------------------------------------------------------

test('I-4 the hub switched to °F: seen by the fresh read, the setpoint refused, nothing published', async () => {
  const world = fakeHub();
  const { gladys, start, cmd, wait } = await setup({
    world,
    config: { ...ON, poll_interval: 600 },
  });
  await start();
  world.unit = 'F';
  world.systemStamp = 101;
  world.zones[0].ACTUAL_TEMP = '59.0';
  const ack = await cmd(F('target-temperature'), 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /unité du hub/);
  assert.equal(world.count('SET_TEMP'), 0);
  await wait(30 * SECOND);
  assert.notEqual(gladys.fake.lastState(F('temperature')), 59);
});

// --- I-5: /data read before written ----------------------------------------------------

test('I-5 a slow /data at start: a standby meanwhile never overwrites it, the pin is kept', async () => {
  const store = memoryStore({ pins: {}, guards: [] });
  const config = { host: '192.168.1.40', api_token: CONFIG.api_token };
  const { app, world, clock, act, gladys } = await setup({ store, config });
  // The pin learnt earlier, under the key of this address.
  const key = normalizeConfig(config).key;
  store.data.pins[key] = PIN;
  const load = store.load.bind(store);
  store.load = () => new Promise((resolve) => world.clock.sleep(1500).then(() => resolve(load())));
  const starting = app.connected(config);
  await settle();
  const ack = await act(
    gladys.fake.setValue(gladys.devices[0], { external_id: F('mode') }, 'standby'),
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /Pas envoyé pour l’instant/, 'the true reason during a restart (m-7)');
  assert.equal(store.saves, 0);
  await act(starting);
  assert.equal(store.data.pins[key], PIN);
  assert.equal(world.sent[0].name, 'FROST_ON', 'sent at the end of the start');
  assert.ok(clock.now > 0);
  app.stop();
});

// --- I-6, m-8: acks by ~3.4 s ------------------------------------------------------------

test('I-6 a setpoint behind a read that hangs: refused unsent by 3.4 s (Gladys waits 5 s)', async () => {
  const world = fakeHub();
  const { app, gladys, clock, start, act } = await setup({ world, config: ON });
  await start();
  world.hang = (name) => name === 'GET_LIVE_DATA';
  app.lastReadAt = -Infinity;
  app.tick();
  await settle();
  const asked = clock.now;
  const ack = await act(
    gladys.fake.setValue(gladys.devices[0], { external_id: F('target-temperature') }, 20),
  );
  assert.ok(clock.now - asked <= 3400, `ack after ${clock.now - asked} ms`);
  assert.match(ack.error, /^Pas envoyé/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('m-8 a standby the hub does not answer: acked by 3.4 s, then sent again by the reads', async () => {
  const world = fakeHub();
  const { gladys, clock, start, act } = await setup({ world });
  await start();
  world.hang = (name) => name === 'FROST_ON';
  const asked = clock.now;
  const ack = await act(
    gladys.fake.setValue(gladys.devices[0], { external_id: F('mode') }, 'standby'),
  );
  assert.ok(clock.now - asked <= 3450, `ack after ${clock.now - asked} ms`);
  assert.equal(ack.success, false);
  assert.match(ack.error, /En cours d’envoi/);
});

// --- I-7: scenes -----------------------------------------------------------------------

test('I-7 5 standbys of a scene on a slow hub (900 ms) leave together within the ack', async () => {
  const zones = [1, 2, 3, 4, 5].map((id) => ZONE({ DEVICE_ID: id, ZONE_NAME: `Room ${id}` }));
  const world = fakeHub({ zones });
  const devices = zones.map((z) => created(z));
  const { gladys, clock, start, act } = await setup({ world, devices });
  await start();
  world.latency = 900;
  const asked = clock.now;
  const acks = await act(
    Promise.all(
      devices.map((d, i) => gladys.fake.setValue(d, { external_id: F('mode', i + 1) }, 'standby')),
    ),
  );
  const frost = world.sent.filter((s) => s.name === 'FROST_ON');
  assert.ok(frost.length <= 2, `${frost.length} FROST_ON`);
  assert.deepEqual(frost.flatMap((s) => s.argument).sort(), [1, 2, 3, 4, 5]);
  assert.ok(frost.every((s) => s.at - asked < 3400));
  assert.ok(world.zones.every((z) => z.STANDBY === true));
  assert.equal(acks.filter((a) => a.success).length >= 1, true);
});

// --- I-8: the guards its mutants found untested ----------------------------------------

for (const [label, over] of [
  ['the zone away (R2)', { AWAY: true }],
  ['the zone on holiday (R4)', { HOLIDAY: true }],
]) {
  test(`I-8 a setpoint is refused with ${label}`, async () => {
    const world = fakeHub({ zones: [ZONE(over)] });
    const { start, cmd } = await setup({ world, config: ON });
    await start();
    const ack = await cmd(F('target-temperature'), 20);
    assert.match(ack.error, /veille, absente ou en vacances/);
    assert.equal(world.count('SET_TEMP'), 0);
  });
}

test('I-8 R1 a setpoint is refused while the unit is unknown', async () => {
  const world = fakeHub();
  world.fail = (name) => (name === 'GET_SYSTEM' ? { kind: 'network', sent: false } : undefined);
  const { start, cmd } = await setup({ world, config: ON });
  await start();
  const ack = await cmd(F('target-temperature'), 20);
  assert.match(ack.error, /unité du hub n’est pas encore lue/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('I-8 R5 an away the hub does not show yet still refuses setpoints; R31 "Home" is written', async () => {
  const world = fakeHub();
  const { start, cmd } = await setup({ world, config: ON, devices: [created(), createdHub()] });
  await start();
  world.apply = false;
  await cmd(HUB_AWAY, 'away');
  world.apply = true;
  const ack = await cmd(F('target-temperature'), 20);
  assert.match(ack.error, /mode absence a été demandé il y a moins de 10 minutes/);
  // The hub still says "home", but an away waits: "Home" is sent, never "already done".
  await cmd(HUB_AWAY, 'home');
  assert.equal(world.count('AWAY_OFF'), 1);
});

test('I-8 R9 a successful read clears the count of closed connections (no false refusal)', async () => {
  const world = fakeHub();
  let close = true;
  world.fail = (name) =>
    close && name === 'GET_LIVE_DATA' ? { kind: 'closed', sent: true, first: true } : undefined;
  const { app, start, wait } = await setup({ world });
  await start();
  close = false;
  await wait(MINUTE);
  close = true;
  await wait(MINUTE);
  assert.equal(app.pauseLeft(app.monotonic()) > 0, true, 'one closed connection after a success');
  assert.equal(app.refused, false);
});

test('I-8 R10 a read sent before the standby left never marks it shown', async () => {
  const { app, start, cmd, world } = await setup();
  await start();
  world.hang = (name) => name === 'FROST_ON';
  const pending = cmd(F('mode'), 'standby');
  await settle();
  const guard = app.guards.get(`${HUB}-1`);
  const live = { hubAway: false, hubHoliday: false, zones: [{ id: 1, standby: true }] };
  app.settleGuards(HUB, live, (guard.sentAt ?? app.monotonic()) - 1);
  assert.equal(guard.shown, false);
  app.settleGuards(HUB, live, app.monotonic() + 1);
  assert.equal(guard.shown, true);
  world.hang = undefined;
  await pending;
});

test('I-8 R11 R28 a stop of another hub is neither sent nor sent again', async () => {
  const other = 'aabbccddeeff';
  const store = memoryStore({
    guards: [
      {
        target: `${other}-1`,
        kind: 'standby',
        until: Date.UTC(2026, 10, 14, 12, 5),
        pending: true,
        resends: 3,
      },
    ],
  });
  const world = fakeHub();
  const { gladys, start, act, wait } = await setup({ store, world });
  await start();
  await wait(5 * MINUTE);
  assert.equal(world.count('FROST_ON'), 0, 'never: not the hub of the devices created');
  const ack = await act(
    gladys.fake.setValue(
      created(),
      { external_id: `ext:neohub-test:neohub:${other}-1:mode` },
      'standby',
    ),
  );
  assert.match(ack.error, /autre hub/);
  assert.equal(world.count('FROST_ON'), 0);
});

test('I-8 R16 after a failed read, a device created gets no stale values', async () => {
  const world = fakeHub();
  const { app, gladys, start, wait } = await setup({ world, devices: [] });
  await start();
  // A refused token: offline, without a pause, while the last read is still recent.
  await app.tokenRefused();
  const before = gladys.fake.states.length;
  await gladys.fake.deviceCreated(created());
  await wait(2 * SECOND);
  assert.equal(gladys.fake.states.length, before);
});

test('I-8 R39 the pause after a failure is never shorter than the interval', async () => {
  const world = fakeHub();
  const { start, wait } = await setup({ world, config: { ...CONFIG, poll_interval: 600 } });
  world.fail = () => ({ kind: 'network', sent: false });
  await start();
  await wait(5 * MINUTE);
  assert.equal(world.count('GET_LIVE_DATA'), 0, 'failed sends are not recorded');
  const tries = [];
  world.fail = (name) => {
    tries.push(name);
    return { kind: 'network', sent: false };
  };
  await wait(4 * MINUTE);
  assert.equal(tries.length, 0, 'no try before 10 min');
  await wait(2 * MINUTE);
  assert.ok(tries.length >= 1);
});

// --- m-3, m-4, m-5, m-6 ------------------------------------------------------------------

test('m-3 a standby the hub answered is not sent again, even if its data never shows it', async () => {
  const world = fakeHub();
  const { start, cmd, wait } = await setup({ world });
  await start();
  world.apply = false;
  const ack = await cmd(F('mode'), 'standby');
  assert.match(ack.error, /accepté par le hub/);
  await wait(10 * MINUTE);
  assert.equal(world.count('FROST_ON'), 1);
});

test('m-4 more than 4 pins: the one in use is kept, the oldest go', () => {
  const key = 'f'.repeat(32);
  const pins = {};
  for (const c of '01234') pins[c.repeat(32)] = PIN;
  pins[key] = PIN;
  const kept = normalizeMemory({ key, pins }).pins;
  assert.equal(Object.keys(kept).length, 4);
  assert.ok(kept[key]);
  assert.ok(!kept['0'.repeat(32)]);
});

test('m-5 a new token typed in the session is always tried, even if its tag collides', async () => {
  const store = memoryStore();
  const world = fakeHub();
  world.fail = () => ({ kind: 'token', sent: true });
  const { app, start, act, wait } = await setup({ store, world });
  await start();
  assert.equal(app.refused, true);
  // Make the tag of the new token collide with the refused one.
  const fresh = 'brand-new-token-0001';
  store.data.refused.tag = tokenTag(store.data.refused.salt, fresh);
  world.fail = undefined;
  await act(app.configUpdated({ ...CONFIG, api_token: fresh }));
  assert.equal(app.refused, false);
  await wait(MINUTE);
  assert.equal(world.sent.at(-1).token, fresh);
  app.stop();
});

test('m-6 follow-up reads are grouped: 8 setpoints, a bounded number of reads', async () => {
  const zones = Array.from({ length: 8 }, (_, i) =>
    ZONE({ DEVICE_ID: i + 1, ZONE_NAME: `Room ${i + 1}` }),
  );
  const world = fakeHub({ zones });
  const devices = zones.map((z) => created(z));
  const { gladys, start, act, wait } = await setup({ world, config: ON, devices });
  await start();
  await act(
    Promise.all(
      devices.map((d, i) =>
        gladys.fake.setValue(d, { external_id: F('target-temperature', i + 1) }, 18 + (i % 3)),
      ),
    ),
  );
  const before = world.count('GET_LIVE_DATA');
  await wait(25 * SECOND);
  assert.equal(world.count('GET_LIVE_DATA') - before, 2, 'one follow-up at 5 s, one at 20 s');
});
