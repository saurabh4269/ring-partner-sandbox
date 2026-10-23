import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../src/server.js';
import { createRecorder, loadFixtures, canonicalQuery, fixtureName, redactUrl } from '../src/fixtures.js';

// The "real" Ring API in these tests is just another sandbox on a random port with a different
// token, 3 devices and a distinctive snapshot, so replayed data is distinguishable from the mock.
const UP_TOKEN = 'upstream-secret-token-123';
const H = { 'User-Agent': 'Test/1.0', Hardware_Id: '550e8400-e29b-41d4-a716-446655440000' };
const SNAP = Buffer.from('\xff\xd8\xffRECORDED-SNAPSHOT-BYTES', 'latin1');
let dir, upstream, rec, recUrl;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ring-fx-'));
  const snapFile = join(dir, 'snap.jpg');
  writeFileSync(snapFile, SNAP);
  upstream = createSandbox({ token: UP_TOKEN, devices: 3, snapshot: snapFile });
  const upUrl = await upstream.listen(0);
  rec = createRecorder({ upstream: upUrl, out: join(dir, 'fixtures') });
  recUrl = await rec.listen(0);
});
after(async () => { await rec.close(); await upstream.close(); rmSync(dir, { recursive: true, force: true }); });

const auth = (t) => ({ ...H, Authorization: `Bearer ${t}` });
const DEV = 'ava1.ring.device.SANDBOX0002';

test('record: proxies requests unchanged and writes fixtures', async () => {
  const direct = await (await fetch(`${upstream.url}/v1/devices?include=status`, { headers: auth(UP_TOKEN) })).json();
  const res = await fetch(`${recUrl}/v1/devices?include=status`, { headers: auth(UP_TOKEN) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, direct.data);
  assert.equal(body.included.length, 3);

  assert.equal((await fetch(`${recUrl}/v1/users/me`, { headers: auth(UP_TOKEN) })).status, 200);
  assert.equal((await fetch(`${recUrl}/v1/devices/${DEV}/status`, { headers: auth(UP_TOKEN) })).status, 200);
  // WAF headers are forwarded as sent (no User-Agent -> 406 from upstream); auth/WAF errors aren't saved.
  assert.equal((await fetch(`${recUrl}/v1/devices`, { headers: { Authorization: `Bearer ${UP_TOKEN}`, 'User-Agent': '' } })).status, 406);

  assert.equal((await fetch(`${recUrl}/v1/devices/nope`, { headers: auth(UP_TOKEN) })).status, 404);

  const files = readdirSync(join(dir, 'fixtures'));
  assert.ok(files.includes('GET_v1_devices_nope.json'), '404s are recorded');
  assert.ok(!files.includes('GET_v1_devices.json'), '406 not recorded');
  assert.ok(files.some((f) => f.startsWith('GET_v1_devices__')), files.join());
  assert.ok(files.includes('GET_v1_users_me.json'));
});

test('record: snapshot 303 is routed through the proxy and the image is saved', async () => {
  const res = await fetch(`${recUrl}/v1/devices/${DEV}/media/image/download`, {
    method: 'POST',
    headers: { ...auth(UP_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'latest_in_range', start_timestamp: Date.now() - 3600_000 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), SNAP);
  const name = fixtureName('POST', `/v1/devices/${DEV}/media/image/download`);
  const fx = JSON.parse(readFileSync(join(dir, 'fixtures', name + '.json'), 'utf8'));
  assert.equal(fx.response.status, 303);
  assert.equal(fx.response.image.file, name + '.jpg');
  assert.match(fx.response.headers.location, /security_token=REDACTED/);
  assert.deepEqual(readFileSync(join(dir, 'fixtures', name + '.jpg')), SNAP);
});

test('record: tokens never reach disk; account ids and e-mails are redacted', () => {
  const all = readdirSync(join(dir, 'fixtures')).filter((f) => f.endsWith('.json'))
    .map((f) => readFileSync(join(dir, 'fixtures', f), 'utf8')).join('\n');
  assert.ok(!all.includes(UP_TOKEN));
  assert.ok(!/authorization/i.test(all));
  assert.ok(!/security_token=(?!REDACTED)/.test(all));
  assert.ok(!all.includes('sandbox@example.com'));
  assert.ok(!all.includes(upstream.options.accountId));
  assert.match(all, /ava1\.ring\.account\.REDACTED0001/);
});

test('serve --fixtures: replays recorded responses, falls back to the mock', async () => {
  const sb = createSandbox({ fixtures: join(dir, 'fixtures'), devices: 1 });
  const base = await sb.listen(0);
  try {
    const t = auth('sandbox-token');
    // Recorded: 3 devices (the mock alone would return 1).
    const res = await fetch(`${base}/v1/devices?include=status`, { headers: t });
    assert.match(res.headers.get('x-sandbox-fixture'), /^GET_v1_devices__/);
    assert.equal((await res.json()).data.length, 3);
    // Same path, unrecorded query: query-less fallback to the recorded path.
    assert.equal((await (await fetch(`${base}/v1/devices`, { headers: t })).json()).data.length, 3);
    // Recorded device that the mock doesn't know.
    const st = await fetch(`${base}/v1/devices/${DEV}/status`, { headers: t });
    assert.equal(st.status, 200);
    assert.equal((await st.json()).data.type, 'device-status');
    // Recorded snapshot via 303 -> sandbox download URL -> recorded bytes.
    const snap = await fetch(`${base}/v1/devices/${DEV}/media/image/download`, {
      method: 'POST', headers: { ...t, 'Content-Type': 'application/json' }, body: '{"type":"latest_in_range","start_timestamp":0}',
    });
    assert.equal(snap.status, 200);
    assert.deepEqual(Buffer.from(await snap.arrayBuffer()), SNAP);
    // Unrecorded: mock answers.
    const hist = await fetch(`${base}/v1/history/devices/ava1.ring.device.SANDBOX0001/events`, { headers: t });
    assert.equal(hist.status, 200);
    assert.equal(hist.headers.get('x-sandbox-fixture'), null);
    // Auth and WAF are still enforced in front of fixtures.
    assert.equal((await fetch(`${base}/v1/devices`, { headers: auth('wrong') })).status, 401);
    assert.equal((await fetch(`${base}/v1/devices`, { headers: { Authorization: 'Bearer sandbox-token' } })).status, 406);
    assert.ok((await (await fetch(`${base}/_sandbox/state`)).json()).fixtures >= 4);
  } finally {
    await sb.close();
  }
});

test('fixture helpers', () => {
  assert.equal(canonicalQuery(new URLSearchParams('b=2&a=1&security_token=x&req_id=y')), 'a=1&b=2');
  assert.equal(redactUrl('https://d.example/v1/download?security_token=abc&req_type=image_download'), 'https://d.example/v1/download?security_token=REDACTED&req_type=image_download');
  assert.equal(fixtureName('get', '/v1/users/me'), 'GET_v1_users_me');
  assert.throws(() => loadFixtures('/nonexistent/fixtures'), /not found/);
});
