import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sign, verifySignature, idempotency, ringWebhookMiddleware } from '../src/verify.js';
import { buildEvent } from '../src/events.js';

const KEY = 'test-signing-key';

test('valid signature over raw bytes verifies', () => {
  const raw = JSON.stringify(buildEvent({ type: 'motion_detected', subType: 'human' }));
  assert.equal(verifySignature(KEY, raw, sign(KEY, raw)), true);
  assert.equal(verifySignature(KEY, Buffer.from(raw), sign(KEY, raw)), true);
});

test('re-serialised JSON (whitespace / key order) fails verification', () => {
  const raw = JSON.stringify(buildEvent({ type: 'button_press' }));
  const header = sign(KEY, raw);
  const pretty = JSON.stringify(JSON.parse(raw), null, 2);
  assert.equal(verifySignature(KEY, pretty, header), false);
  const obj = JSON.parse(raw);
  const reordered = JSON.stringify({ data: obj.data, meta: obj.meta });
  assert.equal(verifySignature(KEY, reordered, header), false);
});

test('wrong key, missing/malformed header are rejected', () => {
  const raw = '{"a":1}';
  assert.equal(verifySignature('other', raw, sign(KEY, raw)), false);
  assert.equal(verifySignature(KEY, raw, undefined), false);
  assert.equal(verifySignature(KEY, raw, sign(KEY, raw).replace('sha256=', '')), false);
  assert.equal(verifySignature(KEY, raw, 'sha256=zz'), false);
  assert.equal(verifySignature(KEY, raw, 'sha256=' + 'a'.repeat(64)), false);
});

test('idempotency dedupes on request_id', () => {
  const d = idempotency({ max: 2 });
  assert.equal(d.firstDelivery('a'), true);
  assert.equal(d.firstDelivery('a'), false);
  d.firstDelivery('b');
  d.firstDelivery('c');
  assert.equal(d.size, 2);
});

test('middleware: accepts good, rejects bad (401), acks duplicates (200)', async () => {
  const seen = [];
  const mw = ringWebhookMiddleware(KEY);
  const server = http.createServer((req, res) => mw(req, res, () => { seen.push(req.body.meta.request_id); res.end('ok'); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const raw = JSON.stringify(buildEvent({ type: 'device_online' }));
  const post = (body, sig) => fetch(url, { method: 'POST', headers: { 'X-Signature': sig }, body });
  try {
    assert.equal((await post(raw, sign(KEY, raw))).status, 200);
    assert.equal((await post(raw, sign('nope', raw))).status, 401);
    const dup = await post(raw, sign(KEY, raw));
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).duplicate, true);
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});
