// -----------------------------------------------------------------------------
// The transport on a real local WSS hub: the pin checked before any byte,
// one command at a time, only the answer to the command, bounded frames, the
// cut of a stuck read for a protective command, one connection at a time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeoHubClient } from '../src/neohub/client.js';
import { readFingerprint } from '../src/neohub/tls.js';
import { selfSigned } from './helpers/certs.js';
import { wssHub } from './helpers/wssHub.js';

const TOKEN = 'tok-123456789';
const LIVE = { HUB_AWAY: false, devices: [] };
const soon = (ms = 3000) => performance.now() + ms;

async function pair(t, options = {}, clientOptions = {}) {
  const hub = await wssHub({ token: TOKEN, ...options });
  const client = new NeoHubClient({
    host: '127.0.0.1',
    port: hub.port,
    pin: hub.fingerprint256,
    token: TOKEN,
    ...clientOptions,
  });
  t.after(async () => {
    client.stop();
    await hub.close();
  });
  return { hub, client };
}

test('a command and its answer: the hub id, the response parsed, the PDF form sent', async (t) => {
  const { hub, client } = await pair(t, { onCommand: () => LIVE });
  const answer = await client.request('GET_LIVE_DATA', 0, { deadline: soon() });
  assert.equal(answer.hubId, 'd88039ad0df0');
  assert.deepEqual(answer.response, LIVE);
  assert.equal(hub.commands[0].command, "{'GET_LIVE_DATA':0}");
  // The connection is kept for the next command.
  await client.request('GET_LIVE_DATA', 0, { deadline: soon() });
  assert.equal(hub.tcp, 1);
});

test('the fingerprint read on a bare handshake is the one of the hub', async (t) => {
  const { hub } = await pair(t);
  assert.equal(await readFingerprint({ host: '127.0.0.1', port: hub.port }), hub.fingerprint256);
  assert.equal(hub.commands.length, 0);
});

test('another certificate: nothing is written, the token never leaves', async (t) => {
  const other = selfSigned('impostor');
  const { hub, client } = await pair(
    t,
    { cert: other },
    { pin: selfSigned('real').fingerprint256 },
  );
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), (err) => {
    assert.equal(err.kind, 'pin');
    assert.equal(err.fingerprint, other.fingerprint256);
    assert.equal(err.sent, false);
    return true;
  });
  assert.equal(hub.open + hub.peak, 0, 'no WebSocket upgrade');
  assert.deepEqual(hub.tokens, []);
});

test('no pin: no connection at all', async (t) => {
  const { hub, client } = await pair(t, {}, { pin: undefined });
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), { kind: 'nopin' });
  assert.equal(hub.tcp, 0);
});

test('frames of other commands are ignored; the answer type and the hub id are checked', async (t) => {
  let mode = 'other-id';
  const { client } = await pair(t, {
    onCommand: (_c, { id, ws }) => {
      if (mode === 'other-id') {
        ws.send(
          JSON.stringify({
            command_id: id + 100,
            device_id: 'D8:80:39:AD:0D:F0',
            message_type: 'hm_set_command_response',
            response: '{"x":1}',
          }),
        );
        ws.send('not json');
        return LIVE;
      }
      if (mode === 'type')
        return `RAW:${JSON.stringify({ command_id: id, device_id: 'D8:80:39:AD:0D:F0', message_type: 'other', response: '{}' })}`;
      return `RAW:${JSON.stringify({ command_id: id, message_type: 'hm_set_command_response', response: '{}' })}`;
    },
  });
  assert.deepEqual((await client.request('GET_LIVE_DATA', 0, { deadline: soon() })).response, LIVE);
  mode = 'type';
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), {
    kind: 'protocol',
  });
  mode = 'no-hub';
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), {
    kind: 'identity',
  });
});

test('a refused token: kind token, the token never in the error', async (t) => {
  const { client } = await pair(t, {}, { token: 'wrong-token-999' });
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), (err) => {
    assert.equal(err.kind, 'token');
    assert.equal(err.sent, true);
    assert.ok(!JSON.stringify({ m: err.message, t: err.text }).includes('wrong-token-999'));
    return true;
  });
});

test('no answer in time: "sent" (it may have been done), a new connection after the old one closed', async (t) => {
  let silent = true;
  const { hub, client } = await pair(t, { onCommand: () => (silent ? undefined : LIVE) });
  await assert.rejects(
    client.request('SET_TEMP', [20, ['Hall']], { deadline: soon(300) }),
    (err) => {
      assert.equal(err.kind, 'timeout');
      assert.equal(err.sent, true);
      return true;
    },
  );
  silent = false;
  await client.request('GET_LIVE_DATA', 0, { deadline: soon() });
  assert.equal(hub.tcp, 2);
  assert.equal(hub.peak, 1, 'never two connections open at once');
});

test('beforeSend throwing: nothing is sent', async (t) => {
  const { hub, client } = await pair(t);
  await assert.rejects(
    client.request('SET_TEMP', [20, ['Hall']], {
      deadline: soon(),
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    /option off/,
  );
  assert.equal(hub.commands.length, 0);
});

test('an answer larger than the limit is dropped before it is complete', async (t) => {
  const { client } = await pair(t, { onCommand: () => ({ big: 'x'.repeat(600 * 1024) }) });
  await assert.rejects(client.request('GET_LIVE_DATA', 0, { deadline: soon() }), (err) => {
    assert.ok(['size', 'network', 'closed'].includes(err.kind), err.kind);
    assert.equal(err.sent, true);
    return true;
  });
});

test('one command at a time, a protective one first; a read stuck 1 s is cut for it', async (t) => {
  const { hub, client } = await pair(t, {
    onCommand: (command) =>
      command.startsWith("{'GET_LIVE_DATA'") ? undefined : { result: 'frost on' },
  });
  const started = performance.now();
  const read = client.request('GET_LIVE_DATA', 0, { deadline: soon(10_000) });
  const queued = client.request('GET_LIVE_DATA', 0, { deadline: soon(10_000) });
  read.catch(() => {});
  queued.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frost = await client.request('FROST_ON', ['Hall'], {
    deadline: soon(4000),
    priority: true,
  });
  const took = performance.now() - started;
  assert.deepEqual(frost.response, { result: 'frost on' });
  await assert.rejects(read, { kind: 'cut' });
  assert.ok(took >= 900 && took < 3000, `left after ${Math.round(took)} ms`);
  // The protective one went before the read queued earlier.
  const order = hub.commands.map((c) => c.command);
  assert.deepEqual(order.slice(0, 2), ["{'GET_LIVE_DATA':0}", "{'FROST_ON':['Hall']}"]);
  assert.equal(hub.peakInflight, 1);
  assert.equal(hub.peak, 1, 'the cut connection closed before the new one');
});

test('a connection stuck opening (TLS) for 1 s is cut for a protective command', async (t) => {
  const { createServer, connect } = await import('node:net');
  const { hub } = await pair(t);
  // The first TCP connection is held silent; the next ones go to the hub.
  let first = true;
  const held = [];
  const proxy = createServer((socket) => {
    if (first) {
      first = false;
      held.push(socket);
      socket.on('error', () => {});
      return;
    }
    const upstream = connect(hub.port, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of held) s.destroy();
    proxy.close();
  });
  const client = new NeoHubClient({
    host: '127.0.0.1',
    port: proxy.address().port,
    pin: hub.fingerprint256,
    token: TOKEN,
  });
  t.after(() => client.stop());
  const started = performance.now();
  const read = client.request('GET_LIVE_DATA', 0, { deadline: soon(10_000) });
  read.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.request('FROST_ON', ['Hall'], { deadline: soon(4000), priority: true });
  const took = performance.now() - started;
  await assert.rejects(read, { kind: 'cut' });
  assert.ok(took < 3000, `left after ${Math.round(took)} ms`);
  assert.equal(hub.commands[0].command, "{'FROST_ON':['Hall']}");
});
