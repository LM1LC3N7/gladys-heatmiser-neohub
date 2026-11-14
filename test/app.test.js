// -----------------------------------------------------------------------------
// The app end to end: the fake Gladys of the SDK, the exact handlers of the
// container, a fake hub, a virtual clock that moves at each read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import {
  CONFIG,
  F,
  HUB,
  MINUTE,
  PIN,
  SECOND,
  TOKEN,
  ZONE,
  created,
  createdHub,
  settle,
  setup,
} from './helpers/app.js';
import { fakeHub } from './helpers/fakeHub.js';

const ON = { ...CONFIG, allow_heating: true };
const HUB_AWAY = `ext:neohub-test:neohub:${HUB}-hub:away`;

test('start: one read at once, the zones discovered, their states published in °C', async () => {
  const { world, gladys, start, state } = await setup({ devices: [created(), createdHub()] });
  await start();
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  assert.equal(world.count('GET_SYSTEM'), 1);
  assert.equal(state(F('temperature')), 20.5);
  assert.equal(state(F('target-temperature')), 21);
  assert.equal(state(F('mode')), 'schedule');
  assert.equal(state(HUB_AWAY), 'home');
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids, [`ext:neohub-test:neohub:${HUB}-hub`, `ext:neohub-test:neohub:${HUB}-1`]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /Connected: 1 zone\./);
  // Nothing but reads was sent; the token went in each request, never anywhere else.
  assert.deepEqual(
    new Set(world.sent.map((s) => s.name)),
    new Set(['GET_LIVE_DATA', 'GET_SYSTEM']),
  );
});

test('pace: never two reads within the interval (reconnection, button, Discovery, restart)', async () => {
  const store = memoryStore();
  const { app, world, gladys, clock, start, wait, act } = await setup({ store });
  await start();
  await wait(5 * SECOND);
  await app.connected(CONFIG);
  await act(gladys.fake.action('test_connection'));
  await act(gladys.fake.scanRequest());
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  await wait(55 * SECOND);
  assert.equal(world.count('GET_LIVE_DATA'), 2);
  // A restart 10 s after the last read waits for the interval.
  await wait(10 * SECOND);
  const second = await setup({ store, world: fakeHub(), now: clock.now });
  await second.start();
  assert.equal(second.world.count('GET_LIVE_DATA'), 0);
  await second.wait(50 * SECOND);
  assert.equal(second.world.count('GET_LIVE_DATA'), 1);
  second.app.stop();
  app.stop();
});

test('failures back off 1, 2, 5 min and the status says so; a success clears it', async () => {
  const world = fakeHub();
  world.fail = () => ({ kind: 'network', sent: false });
  const { gladys, start, wait } = await setup({ world });
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /not reached .* new try in 1 min/);
  await wait(MINUTE);
  assert.match(gladys.fake.connectionStatus.message.en, /new try in 2 min/);
  world.fail = undefined;
  await wait(2 * MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the unit not read (GET_SYSTEM failing) never blocks the zones: modes published, temperatures wait', async () => {
  const world = fakeHub();
  world.fail = (name) => (name === 'GET_SYSTEM' ? { kind: 'timeout', sent: true } : undefined);
  const { gladys, start, state } = await setup({ world });
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(state(F('mode')), 'schedule');
  assert.equal(state(F('temperature')), undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /Unit of the hub not read yet/);
});

test('a hub in °F: no temperature published, setpoints refused, standby still sent', async () => {
  const world = fakeHub({ unit: 'F' });
  const { gladys, start, state, cmd } = await setup({ world, config: ON });
  await start();
  assert.equal(state(F('temperature')), undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /°F/);
  const ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, false);
  assert.match(ack.error, /°F/);
  assert.equal(world.count('SET_TEMP'), 0);
  const standby = await cmd(F('mode'), 'standby');
  assert.equal(standby.success, true);
  assert.equal(world.count('FROST_ON'), 1);
});

test('values that are not measurements are never published as 0', async () => {
  const world = fakeHub({
    zones: [
      ZONE({ ACTUAL_TEMP: '', SET_TEMP: null }),
      ZONE({ DEVICE_ID: 2, ZONE_NAME: 'Hall', ACTUAL_TEMP: '127' }),
    ],
  });
  const { start, state } = await setup({
    world,
    devices: [created(), created({ DEVICE_ID: 2, ZONE_NAME: 'Hall' })],
  });
  await start();
  assert.equal(state(F('temperature')), undefined);
  assert.equal(state(F('target-temperature')), undefined);
  assert.equal(state(F('temperature', 2)), undefined);
  assert.equal(state(F('target-temperature', 2)), 21);
});

// --- Certificate pin and token ----------------------------------------------------

test('no pin: nothing is sent; the first click of the button pins the certificate then reads', async () => {
  const store = memoryStore();
  const config = { host: '192.168.1.40', api_token: TOKEN };
  const { world, gladys, start, act, app } = await setup({ store, config });
  await start();
  assert.equal(world.sent.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /not known yet/);
  const ack = await act(gladys.fake.action('test_connection'));
  assert.match(ack.data.message.en, /learnt, not verified/);
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  assert.equal(Object.values(store.data.pins)[0], PIN);
  assert.equal(world.clients.at(-1).options.pin, PIN);
  app.stop();
});

test('the pin is not kept when /data cannot save it, and nothing is sent', async () => {
  const store = memoryStore();
  store.save = async () => {
    throw Object.assign(new Error('read-only'), { code: 'EROFS' });
  };
  const config = { host: '192.168.1.40', api_token: TOKEN };
  const { world, gladys, start, act } = await setup({ store, config });
  await start();
  const ack = await act(gladys.fake.action('test_connection'));
  assert.match(ack.data.message.en, /could not keep it/);
  assert.equal(world.sent.length, 0);
});

test('a refused token: kept as a tag in /data, no automatic read, the button or a new token tries again', async () => {
  const store = memoryStore();
  const world = fakeHub();
  world.fail = () => ({ kind: 'token', sent: true, text: 'Invalid token' });
  const { gladys, start, wait, act, app, clock } = await setup({ store, world });
  await start();
  assert.match(gladys.fake.connectionStatus.message.en, /refused the API token/);
  assert.equal(store.data.refused.tag.length, 2);
  assert.ok(!JSON.stringify(store.data).includes(TOKEN));
  await wait(30 * MINUTE);
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  // A restart with the same token does not try it.
  app.stop();
  const again = await setup({ store, world, now: clock.now });
  await again.start();
  await again.wait(10 * MINUTE);
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  // The button tries it once more.
  world.fail = undefined;
  await again.act(again.gladys.fake.action('test_connection'));
  assert.equal(world.count('GET_LIVE_DATA'), 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, null);
  again.app.stop();
  await act(Promise.resolve());
});

test('a new token is always tried, even after a refusal', async () => {
  const store = memoryStore();
  const world = fakeHub();
  world.fail = () => ({ kind: 'token', sent: true });
  const { start, app, clock } = await setup({ store, world });
  await start();
  app.stop();
  world.fail = undefined;
  const config = { ...CONFIG, api_token: 'another-token-123456' };
  const next = await setup({ store, world, config, now: clock.now + MINUTE });
  await next.start();
  assert.equal(world.count('GET_LIVE_DATA'), 2);
  assert.equal(world.sent.at(-1).token, 'another-token-123456');
  next.app.stop();
});

test('a connection closed right after the first command twice in a row is a refused token', async () => {
  const world = fakeHub();
  world.fail = () => ({ kind: 'closed', sent: true, first: true });
  const { gladys, start, wait } = await setup({ world });
  await start();
  assert.match(gladys.fake.connectionStatus.message.en, /not reached/);
  await wait(MINUTE);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the API token/);
});

test('a changed certificate: nothing is sent, the fingerprint seen is shown', async () => {
  const world = fakeHub();
  const seen = PIN.replace(/^../, 'AA');
  world.fail = () => ({ kind: 'pin', sent: false, fingerprint: seen });
  const { gladys, start } = await setup({ world });
  await start();
  assert.match(gladys.fake.connectionStatus.message.en, /certificate of the hub changed/);
  assert.ok(gladys.fake.connectionStatus.message.en.includes(seen));
  assert.equal(world.sent.length, 0);
});

test('getConfig failing in connected is tried again, then the integration starts', async () => {
  const { app, gladys, world, wait } = await setup();
  let calls = 0;
  await app.onConnected(async () => {
    calls += 1;
    if (calls === 1) throw new Error('down');
    return CONFIG;
  });
  await settle();
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /could not be read from Gladys; new try in 5 s/,
  );
  assert.equal(world.sent.length, 0);
  await wait(5 * SECOND);
  assert.equal(calls, 2);
  assert.equal(world.count('GET_LIVE_DATA'), 1);
});

// --- Sensitive commands ------------------------------------------------------------

test('heating commands are off by default: nothing sent', async () => {
  const { world, start, cmd } = await setup({ devices: [created(), createdHub()] });
  await start();
  for (const [feature, value] of [
    [F('target-temperature'), 22],
    [F('mode'), 'schedule'],
    [HUB_AWAY, 'home'],
  ]) {
    const ack = await cmd(feature, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /commandes de chauffage sont désactivées/);
  }
  assert.equal(world.sent.filter((s) => !s.name.startsWith('GET_')).length, 0);
});

test('a setpoint: decided on a fresh read, sent, confirmed by the read back', async () => {
  const { world, start, cmd, state } = await setup({ config: ON });
  await start();
  const reads = world.count('GET_LIVE_DATA');
  const ack = await cmd(F('target-temperature'), 22.5);
  assert.equal(ack.success, true, ack.error);
  const set = world.sent.find((s) => s.name === 'SET_TEMP');
  assert.deepEqual(set.argument, [22.5, [1]], 'the zone by its device number');
  assert.equal(world.count('GET_LIVE_DATA'), reads + 2, 'a fresh read before, a read back after');
  assert.equal(state(F('target-temperature')), 22.5);
});

test('setpoint bounds: 5 °C to the ceiling, steps of 0.5 °C, strict numbers', async () => {
  const { world, start, cmd } = await setup({ config: { ...ON, max_setpoint: 23 } });
  await start();
  for (const value of [4.5, 23.5, 22.3, '', null, 'abc', NaN]) {
    const ack = await cmd(F('target-temperature'), value);
    assert.equal(ack.success, false, String(value));
  }
  assert.equal(world.count('SET_TEMP'), 0);
});

test('the ceiling lowered while the command reads is checked right before sending', async () => {
  const { app, world, start, cmd } = await setup({ config: ON });
  await start();
  world.latency = 400;
  const pending = cmd(F('target-temperature'), 23);
  await settle();
  await app.configUpdated({ ...ON, max_setpoint: 20 });
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 5 et 20/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a setpoint is refused on a zone in standby, away or on holiday', async () => {
  const world = fakeHub({ zones: [ZONE({ STANDBY: true })] });
  const { start, cmd } = await setup({ world, config: ON });
  await start();
  const ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, false);
  assert.match(ack.error, /veille, absente ou en vacances/);
  world.zones[0].STANDBY = false;
  world.hubHoliday = true;
  const second = await cmd(F('target-temperature'), 20);
  assert.equal(second.success, false);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('identity: a renamed zone or another hub is never commanded', async () => {
  const world = fakeHub();
  const { start, cmd, wait } = await setup({ world, config: ON });
  await start();
  world.zones[0].ZONE_NAME = 'Kitchen';
  let ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, false);
  assert.match(ack.error, /renommée/);
  world.zones[0].ZONE_NAME = 'Living room';
  world.hubId = 'aabbccddeeff';
  await wait(MINUTE);
  ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre hub/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a command that may have left is never "not sent"; one that did not leave says so', async () => {
  const world = fakeHub();
  const { start, cmd } = await setup({ world, config: ON });
  await start();
  world.fail = (name) => (name === 'SET_TEMP' ? { kind: 'timeout', sent: true } : undefined);
  let ack = await cmd(F('target-temperature'), 20);
  assert.match(ack.error, /Envoyé, sans confirmation/);
  world.fail = (name) => (name === 'SET_TEMP' ? { kind: 'network', sent: false } : undefined);
  ack = await cmd(F('target-temperature'), 19);
  assert.match(ack.error, /^Pas envoyé/);
});

test('a read back equal to the state before is "not applied", told in the status', async () => {
  const world = fakeHub();
  const { gladys, start, cmd } = await setup({ world, config: ON });
  await start();
  world.apply = false;
  const ack = await cmd(F('target-temperature'), 23);
  assert.equal(ack.success, false);
  assert.match(ack.error, /montre encore 21 °C/);
  assert.match(gladys.fake.connectionStatus.message.en, /not shown by the hub: Living room/);
});

test('a scene on 5 slow zones (900 ms) sets all 5 in one command; an offline zone does not stop the others', async () => {
  const zones = [1, 2, 3, 4, 5].map((id) =>
    ZONE({ DEVICE_ID: id, ZONE_NAME: `Room ${id}`, OFFLINE: id === 3 }),
  );
  const world = fakeHub({ zones });
  const devices = zones.map((z) => created(z));
  const { gladys, clock, start, act } = await setup({ world, config: ON, devices });
  await start();
  world.latency = 900;
  const asked = clock.now;
  const acks = await act(
    Promise.all(
      devices.map((d, i) =>
        gladys.fake.setValue(d, { external_id: F('target-temperature', i + 1) }, 19),
      ),
    ),
  );
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, false, true, true],
  );
  assert.match(acks[2].error, /hors ligne/);
  const sets = world.sent.filter((s) => s.name === 'SET_TEMP');
  assert.deepEqual(
    sets.map((s) => s.argument),
    [[19, [1, 2, 4, 5]]],
  );
  assert.ok(sets[0].at - asked < 2800, 'sent within the deadline');
});

test('a scene of 5 different setpoints: each sent within its deadline or refused unsent, never late', async () => {
  const zones = [1, 2, 3, 4, 5].map((id) => ZONE({ DEVICE_ID: id, ZONE_NAME: `Room ${id}` }));
  const world = fakeHub({ zones });
  const devices = zones.map((z) => created(z));
  const { gladys, clock, start, act } = await setup({ world, config: ON, devices });
  await start();
  world.latency = 500;
  const asked = clock.now;
  const acked = [];
  const acks = await act(
    Promise.all(
      devices.map((d, i) =>
        gladys.fake
          .setValue(d, { external_id: F('target-temperature', i + 1) }, 17 + i)
          .then((a) => {
            acked.push(clock.now - asked);
            return a;
          }),
      ),
    ),
  );
  for (const at of acked) assert.ok(at <= 3500, `ack after ${at} ms`);
  for (const s of world.sent.filter((x) => x.name === 'SET_TEMP')) {
    assert.ok(s.at - asked < 2800, `sent at ${s.at - asked} ms`);
  }
  assert.ok(acks.filter((a) => a.success || /Envoyé/.test(a.error)).length >= 2);
  for (const a of acks.filter((x) => !x.success && !/Envoyé/.test(x.error))) {
    assert.match(a.error, /^Pas envoyé/);
  }
});

// --- Protective commands -----------------------------------------------------------

test('standby is sent with the option off, during a pause, with a refused token, queue full', async () => {
  const world = fakeHub();
  const { app, gladys, start, cmd, wait, act } = await setup({ world });
  await start();
  let ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.sent.find((s) => s.name === 'FROST_ON').argument, [1]);
  // During a pause after failed reads.
  world.zones[0].STANDBY = false;
  world.fail = (name) => (name === 'GET_LIVE_DATA' ? { kind: 'network', sent: false } : undefined);
  await wait(MINUTE);
  assert.ok(app.pauseLeft(app.monotonic()) > 0);
  await cmd(F('mode'), 'standby');
  assert.equal(world.count('FROST_ON'), 2);
  // A refused token.
  world.fail = undefined;
  app.refused = true;
  await cmd(F('mode'), 'standby');
  assert.equal(world.count('FROST_ON'), 3);
  // The queue full of setpoints (a slow hub).
  app.refused = false;
  app.pause = undefined;
  // The guards of the standbys above would refuse the setpoints at once.
  app.guards.clear();
  app.config.allowHeating = true;
  world.latency = 900;
  const device = gladys.devices[0];
  const setpoints = Array.from({ length: 9 }, () =>
    gladys.fake.setValue(device, { external_id: F('target-temperature') }, 19),
  );
  await settle();
  assert.equal(app.commands.length, 8);
  const standby = gladys.fake.setValue(device, { external_id: F('mode') }, 'standby');
  const acks = await act(Promise.all([standby, ...setpoints]));
  assert.equal(world.count('FROST_ON'), 4);
  assert.equal(acks[0].success, true, acks[0].error);
});

test('standby cuts a read stuck for 1 s and leaves within the ack', async () => {
  const world = fakeHub();
  const { app, clock, start, cmd, wait } = await setup({ world });
  await start();
  world.hang = (name) => name === 'GET_LIVE_DATA';
  await wait(MINUTE);
  const before = clock.now;
  world.hang = undefined;
  const ack = await cmd(F('mode'), 'standby');
  const sent = world.sent.find((s) => s.name === 'FROST_ON');
  assert.ok(sent, 'sent');
  assert.ok(sent.at - before < 3500, `left after ${sent.at - before} ms`);
  assert.equal(ack.success, true, ack.error);
  // The cut read is not a failure.
  assert.equal(app.pauseLeft(app.monotonic()), 0);
});

test('a standby cancels the setpoints queued before it on its zone', async () => {
  const world = fakeHub();
  const { gladys, start, act } = await setup({ world, config: ON });
  await start();
  world.latency = 600;
  const device = gladys.devices[0];
  const first = gladys.fake.setValue(device, { external_id: F('target-temperature') }, 22);
  const second = gladys.fake.setValue(device, { external_id: F('target-temperature') }, 23);
  await settle();
  const standby = gladys.fake.setValue(device, { external_id: F('mode') }, 'standby');
  const acks = await act(Promise.all([first, second, standby]));
  assert.equal(acks[2].success, true, acks[2].error);
  assert.equal(acks[1].success, false);
  assert.match(acks[1].error, /mise en veille de cette zone a été demandée après/);
  // Nothing asked before the standby leaves after it.
  const frost = world.sent.findIndex((s) => s.name === 'FROST_ON');
  assert.ok(world.sent.slice(frost).every((s) => s.name !== 'SET_TEMP'));
});

test('after a standby, a setpoint is refused for 10 min; "Schedule" lifts it', async () => {
  const world = fakeHub();
  const { start, cmd, wait } = await setup({ world, config: ON });
  await start();
  await cmd(F('mode'), 'standby');
  let ack = await cmd(F('target-temperature'), 22);
  assert.equal(ack.success, false);
  ack = await cmd(F('mode'), 'schedule');
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.zones[0].STANDBY, false);
  ack = await cmd(F('target-temperature'), 22);
  assert.equal(ack.success, true, ack.error);
  await wait(MINUTE);
});

test('a standby not shown is sent again by the reads, 3 times at most', async () => {
  const world = fakeHub();
  const { start, cmd, wait, gladys } = await setup({ world });
  await start();
  // The hub never answers it (the reads still work).
  world.hang = (name) => name === 'FROST_ON';
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, false);
  await wait(15 * SECOND);
  assert.match(gladys.fake.connectionStatus.message.en, /sent again/);
  await wait(10 * MINUTE);
  assert.equal(world.count('FROST_ON'), 4);
});

test('a newer command of the zone that left stops the resending of a standby', async () => {
  const world = fakeHub();
  const { start, cmd, wait } = await setup({ world, config: ON });
  await start();
  world.apply = false;
  await cmd(F('mode'), 'standby');
  world.apply = true;
  world.zones[0].STANDBY = true;
  const ack = await cmd(F('mode'), 'schedule');
  assert.equal(ack.success, true, ack.error);
  await wait(5 * MINUTE);
  assert.equal(world.count('FROST_ON'), 1);
});

test('a standby not sent is kept in /data and sent at restart before any read', async () => {
  const store = memoryStore();
  const world = fakeHub();
  const { app, start, cmd, clock } = await setup({ store, world });
  await start();
  world.fail = (name) => (name === 'FROST_ON' ? { kind: 'network', sent: false } : undefined);
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Pas envoyé pour l’instant/);
  assert.equal(store.data.guards[0].pending, true);
  app.stop();
  world.fail = undefined;
  const sentBefore = world.sent.length;
  const next = await setup({ store, world, now: clock.now + SECOND });
  await next.start();
  assert.equal(world.sent[sentBefore].name, 'FROST_ON');
  next.app.stop();
});

test('a failing /data never blocks a standby', async () => {
  const store = memoryStore();
  const { start, cmd, world } = await setup({ store });
  await start();
  store.save = async () => {
    throw new Error('disk full');
  };
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.count('FROST_ON'), 1);
});

test('away: always sent; "Home" needs the option; setpoints refused while away', async () => {
  const world = fakeHub();
  const { start, cmd, state } = await setup({ world, devices: [created(), createdHub()] });
  await start();
  let ack = await cmd(HUB_AWAY, 'away');
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.hubAway, true);
  assert.equal(state(HUB_AWAY), 'away');
  ack = await cmd(HUB_AWAY, 'home');
  assert.equal(ack.success, false);
  assert.equal(world.count('AWAY_OFF'), 0);
});

// --- Secrets -------------------------------------------------------------------------

test('the token is never in the logs, the status, /data, the published devices', async () => {
  const store = memoryStore();
  const world = fakeHub();
  world.fail = () => ({ kind: 'token', sent: true, text: `Invalid token` });
  const { gladys, lines, start } = await setup({ store, world });
  await start();
  const everything = JSON.stringify([
    lines,
    gladys.fake.connectionStatuses,
    store.data,
    gladys.fake.discoveredDevices,
    gladys.fake.states,
  ]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes('4321'), 'the PIN of a thermostat is never copied');
  assert.ok(!everything.includes('192.168.1.40'), 'nor the address');
});

// --- /data -----------------------------------------------------------------------------

test('/data unreadable: never overwritten, no pin learnt; read again every 10 s, then merged', async () => {
  const store = memoryStore({
    pins: { ['a'.repeat(32)]: PIN },
    refused: null,
    guards: [],
  });
  let readable = false;
  const load = store.load.bind(store);
  store.load = async () => {
    if (!readable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return load();
  };
  const config = { host: '192.168.1.40', api_token: TOKEN };
  const { world, gladys, start, act, wait, app } = await setup({ store, config });
  await start();
  const ack = await act(gladys.fake.action('test_connection'));
  assert.match(ack.data.message.en, /cannot be read/);
  assert.equal(store.saves, 0, 'an unreadable /data is never overwritten');
  assert.equal(world.sent.length, 0);
  readable = true;
  await wait(10 * SECOND);
  assert.equal(app.memoryUnreadable, false);
  assert.ok(store.saves > 0);
  assert.equal(Object.keys(store.data.pins).length, 1);
  app.stop();
});

test('a /data that hangs never holds the start, the reads nor a standby', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  store.save = () => new Promise(() => {});
  const { world, start, cmd, wait, app } = await setup({ store });
  await start();
  assert.equal(world.count('GET_LIVE_DATA'), 1);
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, true, ack.error);
  await wait(MINUTE);
  // The first read, the check of the standby, its follow-ups at 5 s and 20 s, the next round.
  assert.equal(world.count('GET_LIVE_DATA'), 5);
  app.stop();
});

// --- Guards of the sensitive commands (each one proven by its mutant) ------------------

test('the option is checked on arrival (no read at all) and again right before sending', async () => {
  const { app, world, start, cmd } = await setup({ config: ON });
  await start();
  await app.configUpdated(CONFIG);
  const reads = world.count('GET_LIVE_DATA');
  let ack = await cmd(F('target-temperature'), 20);
  assert.equal(ack.success, false);
  assert.equal(world.count('GET_LIVE_DATA'), reads, 'refused before any request');
  await app.configUpdated(ON);
  world.latency = 400;
  const pending = cmd(F('target-temperature'), 20);
  await settle();
  await app.configUpdated(CONFIG);
  ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /désactivées/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a "Schedule" being read when a standby arrives is not sent after it', async () => {
  const world = fakeHub({ zones: [ZONE({ STANDBY: true })] });
  const { app, gladys, start, act, advance } = await setup({ world, config: ON });
  await start();
  world.latency = 600;
  const device = gladys.devices[0];
  const schedule = gladys.fake.setValue(device, { external_id: F('mode') }, 'schedule');
  await settle();
  // Past the gathering of a scene: its fresh read is in flight.
  await advance(100);
  await settle();
  assert.equal(app.commands.length, 0);
  const standby = gladys.fake.setValue(device, { external_id: F('mode') }, 'standby');
  const [first, second] = await act(Promise.all([schedule, standby]));
  assert.equal(second.success, true, second.error);
  assert.equal(first.success, false);
  assert.match(first.error, /mise en veille de cette zone a été demandée après/);
  assert.equal(world.count('FROST_OFF'), 0);
});

test('queued commands are dropped the moment a standby arrives', async () => {
  const { app, gladys, start, act } = await setup({ config: ON });
  await start();
  const device = gladys.devices[0];
  const pending = [21, 22, 23].map((v) =>
    gladys.fake.setValue(device, { external_id: F('target-temperature') }, v),
  );
  await settle();
  assert.equal(app.commands.length, 3, 'gathered for 50 ms');
  const standby = gladys.fake.setValue(device, { external_id: F('mode') }, 'standby');
  await settle();
  assert.equal(app.commands.length, 0);
  await act(Promise.all([...pending, standby]));
});

test('a setpoint is refused under a stop guard even when the hub does not show the standby', async () => {
  const world = fakeHub();
  const { start, cmd } = await setup({ world, config: ON });
  await start();
  world.apply = false;
  await cmd(F('mode'), 'standby');
  world.apply = true;
  const ack = await cmd(F('target-temperature'), 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /mise en veille il y a moins de 10 minutes/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a setpoint whose turn comes after 3.5 s is refused unsent (beforeSend)', async () => {
  const zones = [ZONE(), ZONE({ DEVICE_ID: 2, ZONE_NAME: 'Hall' })];
  const world = fakeHub({ zones });
  const devices = zones.map((z) => created(z));
  const { app, gladys, start, act, wait } = await setup({ world, config: ON, devices });
  await start();
  world.delay = (name) => (name === 'FROST_ON' ? 3500 : 100);
  const setpoint = gladys.fake.setValue(devices[0], { external_id: F('target-temperature') }, 22);
  await settle();
  // Its fresh read is in flight when the standby of the other zone arrives.
  await wait(50);
  assert.ok(app.serving);
  const standby = gladys.fake.setValue(devices[1], { external_id: F('mode', 2) }, 'standby');
  const [ack] = await act(Promise.all([setpoint, standby]));
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Pas envoyé/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a newer "Schedule" that left stops the resending, and the status says nothing more', async () => {
  const world = fakeHub();
  const { gladys, start, cmd, wait } = await setup({ world, config: ON });
  await start();
  // Sent, never answered: pending.
  world.fail = (name) => (name === 'FROST_ON' ? { kind: 'timeout', sent: true } : undefined);
  world.apply = false;
  await cmd(F('mode'), 'standby');
  assert.match(gladys.fake.connectionStatus.message.en, /sent again/);
  world.fail = undefined;
  world.apply = true;
  await cmd(F('mode'), 'schedule');
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /sent again/);
  await wait(5 * MINUTE);
  assert.equal(world.count('FROST_ON'), 1);
});

test('an offline zone is never commanded (setpoint)', async () => {
  const world = fakeHub();
  const { start, cmd } = await setup({ world, config: ON });
  await start();
  world.zones[0].OFFLINE = true;
  const ack = await cmd(F('target-temperature'), 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /hors ligne/);
  assert.equal(world.count('SET_TEMP'), 0);
});

test('a standby the hub refuses for its token: told refused (not "not sent"), kept for a new token', async () => {
  const store = memoryStore();
  const world = fakeHub();
  const { gladys, start, cmd } = await setup({ world, store });
  await start();
  world.fail = (name) => (name === 'FROST_ON' ? { kind: 'token', sent: true } : undefined);
  const ack = await cmd(F('mode'), 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Refusé par le hub/);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the API token/);
  assert.equal(store.data.guards[0].pending, true);
});

test('a standby asked before the configuration is read leaves as soon as it is, before the first read', async () => {
  const store = memoryStore({ pins: { ['a'.repeat(32)]: PIN } });
  const { app, gladys, world, act } = await setup({ store });
  const ack = await act(
    gladys.fake.setValue(gladys.devices[0], { external_id: F('mode') }, 'standby'),
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /renvoyé avec les prochaines lectures/);
  assert.equal(store.saves, 0, '/data not written before it is read');
  assert.equal(world.sent.length, 0);
  await act(app.connected(CONFIG));
  assert.equal(world.sent[0].name, 'FROST_ON');
  assert.ok(store.data.pins['a'.repeat(32)], 'the pins kept');
  app.stop();
});
