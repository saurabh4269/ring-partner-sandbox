import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSandbox } from '../src/server.js';
import { verifySignature, readRawBody } from '../src/verify.js';

const TOKEN = 'sandbox-token';
const KEY = 'k3y';
const H = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'Test/1.0', Hardware_Id: '550e8400-e29b-41d4-a716-446655440000' };
let sb, base, hook, hookUrl;
const received = [];

before(async () => {
  hook = http.createServer(async (req, res) => {
    const raw = await readRawBody(req);
    received.push({ ok: verifySignature(KEY, raw, req.headers['x-signature']), body: JSON.parse(raw) });
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/webhooks/ring`;
  sb = createSandbox({ token: TOKEN, signingKey: KEY, webhookUrl: hookUrl, devices: 2 });
  base = await sb.listen(0);
});
after(async () => { await sb.close(); hook.close(); });

const get = (p, headers = H) => fetch(base + p, { headers });
const DEV = 'ava1.ring.device.SANDBOX0001';

test('401 JSON:API error without/with wrong bearer token', async () => {
  for (const auth of [undefined, 'Bearer wrong']) {
    const h = { ...H };
    if (auth) h.Authorization = auth; else delete h.Authorization;
    const res = await get('/v1/users/me', h);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.errors[0].code, 'UNAUTHORIZED');
    assert.equal(body.errors[0].status, '401');
  }
});

test('406 when User-Agent or Hardware_Id missing', async () => {
  const noHw = { ...H }; delete noHw.Hardware_Id;
  assert.equal((await get('/v1/devices', noHw)).status, 406);
  const res = await fetch(base + '/v1/devices', { headers: { Authorization: H.Authorization, Hardware_Id: 'x', 'User-Agent': '' } });
  assert.equal(res.status, 406);
});

test('--no-waf disables the 406 check', async () => {
  const s2 = createSandbox({ waf: false });
  const u = await s2.listen(0);
  const res = await fetch(u + '/v1/users/me', { headers: { Authorization: 'Bearer sandbox-token', 'User-Agent': '' } });
  assert.equal(res.status, 200);
  await s2.close();
});

test('users/me', async () => {
  const body = await (await get('/v1/users/me')).json();
  assert.equal(body.data.type, 'users');
  assert.match(body.data.id, /^ava1\.ring\.account\./);
});

test('devices list, include=status,capabilities compound document', async () => {
  const plain = await (await get('/v1/devices')).json();
  assert.equal(plain.data.length, 2);
  assert.equal(plain.included, undefined);
  assert.ok(plain.meta.time);
  const res = await get('/v1/devices?include=status,capabilities');
  assert.match(res.headers.get('content-type'), /json/);
  const body = await res.json();
  const d = body.data[0];
  assert.equal(d.type, 'devices');
  const st = body.included.find((i) => i.type === d.relationships.status.data.type && i.id === d.relationships.status.data.id);
  assert.equal(st.attributes.online, true);
  assert.ok(body.included.find((i) => i.type === 'device-capabilities'));
  assert.equal(body.included.length, 4);
  assert.equal((await get('/v1/devices?include=bogus')).status, 400);
});

test('device sub-resources', async () => {
  for (const [p, type] of [['', 'devices'], ['/status', 'device-status'], ['/capabilities', 'device-capabilities'], ['/location', 'locations'], ['/configurations', 'device-configurations']]) {
    const res = await get(`/v1/devices/${DEV}${p}`);
    assert.equal(res.status, 200, p);
    assert.equal((await res.json()).data.type, type);
  }
  const cfg = (await (await get(`/v1/devices/${DEV}/configurations`)).json()).data.attributes;
  assert.equal(cfg.e2e_encryption.enabled, false);
  assert.equal(cfg.motion_detection.enabled, 'on');
  const nf = await get('/v1/devices/nope/status');
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).errors[0].code, 'DEVICE_NOT_FOUND');
});

test('history: newest first, event_types filter incl. composite motion.human', async () => {
  const all = (await (await get(`/v1/history/devices/${DEV}/events`)).json());
  assert.equal(all.data.length, 5);
  const starts = all.data.map((e) => e.attributes.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
  assert.equal(all.data[0].type, 'history-events');
  assert.match(all.links.next, /page\[key\]=/);

  const motion = (await (await get(`/v1/history/devices/${DEV}/events?event_types=motion`)).json()).data;
  assert.equal(motion.length, 3);
  assert.ok(motion.every((e) => e.attributes.event_type === 'motion'));
  const humanOrDing = (await (await get(`/v1/history/devices/${DEV}/events?event_types=motion.human,ding`)).json()).data;
  assert.deepEqual(humanOrDing.map((e) => e.attributes.event_type).sort(), ['ding', 'motion']);
});

test('snapshot: POST -> 303 Location -> GET image with media headers', async () => {
  const end = Date.now();
  const res = await fetch(`${base}/v1/devices/${DEV}/media/image/download`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'latest_in_range', start_timestamp: end - 3600_000, end_timestamp: end, image_options: { format: 'jpeg' } }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.match(loc, /\/v1\/download\?security_token=[^&]+&req_type=image_download&req_id=/);
  // signed URL works without the bearer token
  const img = await fetch(loc, { headers: { 'User-Agent': 'Test/1.0', Hardware_Id: 'x' } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(img.headers.get('x-media-timestamp')) > end - 3600_000);
  assert.equal(img.headers.get('x-media-origin'), 'recording');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);

  // PNG via fetch's automatic redirect following
  const png = await fetch(`${base}/v1/devices/${DEV}/media/image/download`, {
    method: 'POST', headers: H, body: JSON.stringify({ type: 'at_timestamp', timestamp: end - 1000, image_options: { format: 'png' } }),
  });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await png.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  // bad token
  assert.equal((await fetch(`${base}/v1/download?security_token=bad&req_type=image_download&req_id=x`, { headers: H })).status, 403);
});

test('snapshot validation errors are JSON:API 400s', async () => {
  const res = await fetch(`${base}/v1/devices/${DEV}/media/image/download`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'sometime' }) });
  assert.equal(res.status, 400);
  const e = (await res.json()).errors[0];
  assert.equal(e.code, 'INVALID_PAYLOAD');
  assert.equal(e.source.pointer, 'type');
});

test('WHEP is explicitly not mocked (501)', async () => {
  const res = await fetch(`${base}/v1/devices/${DEV}/media/streaming/whep/sessions`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/sdp' }, body: 'v=0' });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).errors[0].code, 'NOT_IMPLEMENTED');
});

test('fired events reach history AND a signed webhook; device state follows', async () => {
  received.length = 0;
  const r = await fetch(base + '/_sandbox/events', { method: 'POST', body: JSON.stringify({ type: 'motion_detected', sub_type: 'vehicle' }) });
  const out = await r.json();
  assert.equal(out.delivery.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].ok, true);
  assert.equal(received[0].body.data.attributes.sub_type, 'vehicle');
  const latest = (await (await get(`/v1/history/devices/${DEV}/events?event_types=motion.vehicle`)).json()).data[0];
  assert.equal(latest.id, out.history.id);
  assert.equal(latest.attributes.start, received[0].body.data.attributes.timestamp);

  await sb.fire({ type: 'device_offline' });
  assert.equal((await (await get(`/v1/devices/${DEV}/status`)).json()).data.attributes.online, false);
  await sb.fire({ type: 'device_online' });
  assert.equal((await (await get(`/v1/devices/${DEV}/status`)).json()).data.attributes.online, true);
  await sb.fire({ type: 'device_removed', device: 'ava1.ring.device.SANDBOX0002' });
  assert.equal((await (await get('/v1/devices')).json()).data.length, 1);
  await sb.fire({ type: 'device_added', device: 'ava1.ring.device.SANDBOX0002' });
  assert.equal((await (await get('/v1/devices')).json()).data.length, 2);
  assert.ok(received.every((x) => x.ok));
});
