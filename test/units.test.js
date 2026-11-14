// -----------------------------------------------------------------------------
// The pure parts: the configuration, the messages of the hub, its answers,
// the devices, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddress, parseFingerprint, tokenTag } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import {
  awayOptions,
  buildHubDevice,
  buildZoneDevice,
  modeOptions,
  parseFeatureId,
  zoneStates,
} from '../src/devices.js';
import { parseLive, parseSystem, parseZone, tenthsOf } from '../src/neohub/model.js';
import {
  buildRequest,
  cleanText,
  encodeCommand,
  hubIdOf,
  parseFrame,
  responseError,
} from '../src/neohub/protocol.js';
import { fileStore, normalizeMemory } from '../src/store.js';
import { ZONE } from './helpers/fakeHub.js';

// --- Configuration -------------------------------------------------------------------

test('the address: an IP or a name, port 4243 by default, never a URL path, broadcast or .local', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 4243 });
  assert.deepEqual(parseAddress(' wss://192.168.1.40:4243/ '), {
    host: '192.168.1.40',
    port: 4243,
  });
  assert.deepEqual(parseAddress('[fe80::1]:4000'), { host: 'fe80::1', port: 4000 });
  assert.deepEqual(parseAddress('neohub.lan'), { host: 'neohub.lan', port: 4243 });
  assert.deepEqual(parseAddress(''), {});
  assert.equal(parseAddress('https://1.2.3.4/x').error, 'path');
  assert.equal(parseAddress('user@1.2.3.4').error, 'path');
  assert.equal(parseAddress('255.255.255.255').error, 'broadcast');
  assert.equal(parseAddress('224.0.0.1').error, 'broadcast');
  assert.equal(parseAddress('0.0.0.0').error, 'broadcast');
  assert.equal(parseAddress('neohub.local').error, 'local-name');
  assert.equal(parseAddress('1.2.3.4:0').error, 'invalid');
  assert.equal(parseAddress('a b').error, 'path');
  assert.equal(parseAddress('1.2.3.4\r\nX: y').error, 'invalid');
});

test('the token: no quote, backslash, space nor control; never a default', () => {
  assert.equal(
    normalizeConfig({ host: '1.2.3.4', api_token: ' abc-123-def ' }).token,
    'abc-123-def',
  );
  for (const bad of ['abc"defgh', "abc'defgh", 'abc\\defgh', 'abc defgh', 'abc\ndefgh', 'short']) {
    const c = normalizeConfig({ host: '1.2.3.4', api_token: bad });
    assert.equal(c.token, '', JSON.stringify(bad));
    assert.equal(c.error, 'token');
  }
});

test('the options: only true turns them on; bounded numbers', () => {
  const c = normalizeConfig({ allow_heating: 'yes', max_setpoint: 99, poll_interval: 1 });
  assert.equal(c.allowHeating, false);
  assert.equal(c.ceiling, 35);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ max_setpoint: '' }).ceiling, 24);
  assert.equal(normalizeConfig({ allow_heating: true }).allowHeating, true);
});

test('the fingerprint: 64 hex digits, colons optional', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(
    parseFingerprint(`SHA256=${'AB:'.repeat(31)}AB`).fingerprint,
    'AB:'.repeat(31) + 'AB',
  );
  assert.equal(parseFingerprint('abc').error, 'fingerprint');
  assert.deepEqual(parseFingerprint(''), {});
});

test('the tag of a refused token: 8 bits, salted; useless to find the token (force brute)', () => {
  const salt = 'a1b2c3d4e5f60718';
  assert.match(tokenTag(salt, 'my-token-1234'), /^[0-9a-f]{2}$/);
  // 256 tags at most: among 5000 candidate tokens, about 20 share the tag of the right one.
  const tag = tokenTag(salt, 'my-token-1234');
  let same = 0;
  for (let i = 0; i < 5000; i += 1) if (tokenTag(salt, `guess-${i}`) === tag) same += 1;
  assert.ok(same > 5, `${same} candidates share the tag`);
  assert.notEqual(
    tokenTag('0000000000000000', 'x') + tokenTag('1111111111111111', 'x'),
    tokenTag('0000000000000000', 'x').repeat(2) + 'zz',
  );
});

// --- Protocol --------------------------------------------------------------------------

test('commands in the single-quoted form of the PDF; only the known ones; names checked', () => {
  assert.equal(encodeCommand('GET_LIVE_DATA', 0), "{'GET_LIVE_DATA':0}");
  assert.equal(
    encodeCommand('SET_TEMP', [21.5, ['Living room']]),
    "{'SET_TEMP':[21.5,['Living room']]}",
  );
  assert.equal(encodeCommand('FROST_ON', ['Hall']), "{'FROST_ON':['Hall']}");
  assert.throws(() => encodeCommand('SET_CHANNEL', 11));
  assert.throws(() => encodeCommand('SET_TEMP', [21, ["Kid's room"]]));
  assert.throws(() => encodeCommand('SET_TEMP', [21, ['a\\b']]));
  assert.throws(() => encodeCommand('SET_TEMP', [NaN, ['Hall']]));
});

test('the request envelope: the token only inside the message string', () => {
  const text = buildRequest('tok-123', "{'GET_LIVE_DATA':0}", 7);
  const outer = JSON.parse(text);
  assert.deepEqual(Object.keys(outer), ['message_type', 'message']);
  assert.equal(outer.message_type, 'hm_get_command_queue');
  const inner = JSON.parse(outer.message);
  assert.deepEqual(inner, {
    token: 'tok-123',
    COMMANDS: [{ COMMAND: "{'GET_LIVE_DATA':0}", COMMANDID: 7 }],
  });
});

test('the answer envelope: id, hub, type, the response parsed; errors and refused tokens', () => {
  const frame = parseFrame(
    JSON.stringify({
      command_id: 3,
      device_id: ' D8:80:39:AD:0D:F0',
      message_type: 'hm_set_command_response',
      response: '{"firmware version":"2153"}',
    }),
  );
  assert.deepEqual(frame, {
    commandId: 3,
    hubId: 'd88039ad0df0',
    type: 'hm_set_command_response',
    response: { 'firmware version': '2153' },
  });
  assert.equal(parseFrame('nope').invalid, true);
  assert.equal(parseFrame('[1]').invalid, true);
  assert.equal(hubIdOf('00:00:00:00:00:00'), undefined);
  assert.equal(hubIdOf('xyz'), undefined);
  assert.deepEqual(responseError({ error: 'Invalid token' }), {
    token: true,
    text: 'Invalid token',
  });
  assert.deepEqual(responseError({ error: 'Invalid Json' }), { text: 'Invalid Json' });
  assert.deepEqual(responseError({ text: 'garbage' }), { text: 'garbage' });
  assert.equal(responseError({ result: 'ok' }), undefined);
  assert.equal(cleanText('bad tok-123 here\u0007', 'tok-123'), 'bad … here');
});

// --- Answers ---------------------------------------------------------------------------

test('temperatures: strict, bounded; text, empty, null and 127 are unknown, never 0', () => {
  assert.equal(tenthsOf('21.5'), 215);
  assert.equal(tenthsOf(19), 190);
  assert.equal(tenthsOf('-3.0'), -30);
  for (const bad of ['', null, undefined, 'abc', '127', 127, '255.255', '1e2', true]) {
    assert.equal(tenthsOf(bad), undefined, JSON.stringify(bad));
  }
});

test('a zone: only the fields used (never the PIN); time clocks and bad ids skipped', () => {
  const zone = parseZone(ZONE());
  assert.equal(zone.id, 1);
  assert.equal(zone.name, 'Living room');
  assert.ok(!JSON.stringify(zone).includes('4321'));
  assert.equal(parseZone(ZONE({ THERMOSTAT: false })), undefined);
  assert.equal(parseZone(ZONE({ TIMECLOCK: true })), undefined);
  assert.equal(parseZone(ZONE({ DEVICE_ID: '1' })), undefined);
  assert.equal(parseZone(ZONE({ STANDBY: 'yes' })).standby, undefined);
  assert.equal(parseZone(ZONE({ WRITE_COUNT: 0x43 })).waking, true);
});

test('live data: duplicates dropped, bounded, flags strict; system unit', () => {
  const live = parseLive({
    HUB_AWAY: false,
    HUB_HOLIDAY: 'no',
    devices: [ZONE(), ZONE({ DEVICE_ID: 2 }), ZONE({ DEVICE_ID: 2, ZONE_NAME: 'Other' })],
  });
  assert.deepEqual(
    live.zones.map((z) => z.id),
    [1],
  );
  assert.equal(live.duplicates, true);
  assert.equal(live.hubHoliday, undefined);
  assert.equal(parseLive({ devices: 'x' }), undefined);
  assert.equal(parseLive([]), undefined);
  const many = parseLive({
    devices: Array.from({ length: 500 }, (_, i) => ZONE({ DEVICE_ID: i })),
  });
  assert.ok(many.zones.length <= 64);
  assert.equal(parseSystem({ CORF: 'F' }).unit, 'F');
  assert.equal(parseSystem({ CORF: 'K' }).unit, undefined);
});

// --- Devices ---------------------------------------------------------------------------

/** The rules of the core for the options of a select (the fake Gladys does not check them). */
function checkOptions(options) {
  const values = new Set();
  for (const option of options) {
    assert.deepEqual(Object.keys(option).sort(), ['label', 'sort_order', 'value']);
    assert.equal(typeof option.label, 'string');
    assert.ok(option.label.length > 0 && option.label === option.label.trim());
    assert.equal(typeof option.value, 'string');
    assert.ok(!values.has(option.value));
    values.add(option.value);
  }
}

test('selects: the options follow the rules of the core, in both languages', async () => {
  for (const language of ['fr', 'en']) {
    checkOptions(modeOptions(language));
    checkOptions(awayOptions(language));
  }
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  if (existsSync(core)) {
    const { createRequire } = await import('node:module');
    const normalize = createRequire(import.meta.url)(core);
    const fn = normalize.normalizeSupportedOptions ?? normalize;
    for (const options of [modeOptions('fr'), awayOptions('en')]) {
      assert.doesNotThrow(() => fn(options, { allowStringValues: true }));
    }
  }
});

test('devices: no switch, no binary; ids parse back; created features kept', () => {
  const gladys = createFakeGladys({ selector: 's' });
  const zone = buildZoneDevice(
    gladys,
    { hub: 'd88039ad0df0', id: 3 },
    { zone: parseZone(ZONE({ DEVICE_ID: 3 })), language: 'en' },
  );
  const hub = buildHubDevice(gladys, 'd88039ad0df0', { language: 'en' });
  for (const feature of [...zone.features, ...hub.features]) {
    assert.ok(!['switch', 'binary'].includes(feature.type), feature.external_id);
    assert.ok(parseFeatureId(feature.external_id), feature.external_id);
  }
  assert.deepEqual(parseFeatureId(`${zone.external_id}:mode`), {
    hub: 'd88039ad0df0',
    zone: 3,
    key: 'd88039ad0df0-3',
    role: 'mode',
  });
  assert.equal(parseFeatureId(`${hub.external_id}:mode`), undefined);
  assert.equal(parseFeatureId(`${zone.external_id}:away`), undefined);
  const kept = buildZoneDevice(
    gladys,
    { hub: 'd88039ad0df0', id: 3 },
    {
      language: 'en',
      created: {
        ...zone,
        name: 'Mine',
        features: [...zone.features, { external_id: `${zone.external_id}:old`, name: 'Old' }],
      },
    },
  );
  assert.equal(kept.name, 'Mine');
  assert.ok(kept.features.some((f) => f.external_id.endsWith(':old')));
  assert.equal(kept.params.find((p) => p.name === 'zone_name').value, 'Living room');
});

test('states: an offline zone publishes nothing; °F publishes no temperature', () => {
  const zone = parseZone(ZONE());
  assert.equal(zoneStates({ ...zone, offline: true }, { celsius: true }).length, 0);
  assert.deepEqual(
    zoneStates(zone, { celsius: false }).map(([role]) => role),
    ['mode'],
  );
});

// --- /data -----------------------------------------------------------------------------

test('/data: repaired when read; future dates invalid; never the token', () => {
  const now = Date.UTC(2026, 10, 14);
  const m = normalizeMemory(
    {
      key: 'a'.repeat(32),
      lastAttemptAt: now + 1e9,
      pause: { until: now + 10 * 3600_000, failures: 3 },
      pins: { ['b'.repeat(32)]: 'AB:'.repeat(31) + 'AB', bad: 'x' },
      refused: { key: 'a'.repeat(32), salt: '0123456789abcdef', tag: 'zz' },
      guards: [
        {
          target: 'd88039ad0df0-1',
          kind: 'standby',
          until: now + 60_000,
          pending: true,
          resends: 9,
        },
        { target: 'd88039ad0df0-1', kind: 'standby', until: now + TIMINGS.stopGuard + 60_000 },
        { target: '../x', kind: 'standby', until: now + 60_000 },
      ],
    },
    now,
  );
  assert.equal(m.lastAttemptAt, now);
  assert.equal(m.pause, null);
  assert.deepEqual(Object.keys(m.pins), ['b'.repeat(32)]);
  assert.equal(m.refused, null);
  assert.equal(m.guards.length, 1);
  assert.equal(m.guards[0].resends, 3);
  assert.deepEqual(normalizeMemory('garbage', now).guards, []);
});

test('fileStore: written whole, 0600, read back', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'neohub-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = fileStore(join(dir, 'state.json'));
  assert.equal(await store.load(), null);
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { a: 1 });
  assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{"a":1}');
});
