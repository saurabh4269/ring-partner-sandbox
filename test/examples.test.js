// The examples in examples/ are part of the contract: run each against a real sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createSandbox } from '../src/server.js';
import { placeholderJpeg } from '../src/image.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: root });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** Start a long-running example, resolve once it prints `ready`, collect its output. */
function startServer(cmd, args, env, ready) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: root });
    const h = { proc: p, out: '' };
    const timer = setTimeout(() => reject(new Error(`${args[0]} did not start: ${h.out}`)), 5000);
    const on = (d) => { h.out += d; if (ready.test(h.out)) { clearTimeout(timer); resolve(h); } };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

test('examples/node-client.mjs discovers devices and downloads a snapshot via 303', async () => {
  const sb = createSandbox({ devices: 2 });
  const base = await sb.listen(0);
  const dir = mkdtempSync(join(tmpdir(), 'ring-ex-'));
  try {
    const { code, out } = await run(process.execPath, ['examples/node-client.mjs'], { RING_API_BASE: base, RING_ACCESS_TOKEN: 'sandbox-token', SNAPSHOT_OUT: join(dir, 's.jpg') });
    assert.equal(code, 0, out);
    assert.match(out, /devices {2}2/);
    assert.match(out, /Front Door \(ava1\.ring\.device\.SANDBOX0001\) online/);
    assert.match(out, /snapshot \d+ bytes image\/jpeg origin=recording/);
    assert.deepEqual(readFileSync(join(dir, 's.jpg')), placeholderJpeg());
  } finally {
    await sb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('examples/node-client.mjs fails loudly on a bad token', async () => {
  const sb = createSandbox();
  const base = await sb.listen(0);
  try {
    const { code, out } = await run(process.execPath, ['examples/node-client.mjs'], { RING_API_BASE: base, RING_ACCESS_TOKEN: 'nope' });
    assert.notEqual(code, 0);
    assert.match(out, /401 UNAUTHORIZED/);
  } finally { await sb.close(); }
});

const receivers = [
  ['node', process.execPath, 'examples/webhook-receiver.mjs', true],
  ['python', 'python3', 'examples/python-webhook.py', spawnSync('python3', ['--version']).status === 0],
];
for (const [label, cmd, script, available] of receivers) {
  test(`${script} verifies signed webhooks from the sandbox`, { skip: !available && `${label} not installed` }, async () => {
    const port = await freePort();
    const key = 'example-key';
    const rx = await startServer(cmd, [script], { PORT: String(port), RING_WEBHOOK_SECRET: key }, /listening/);
    const sb = createSandbox({ signingKey: key, webhookUrl: `http://127.0.0.1:${port}/webhooks/ring` });
    await sb.listen(0);
    try {
      const a = await sb.fire({ type: 'motion_detected', sub_type: 'human' });
      assert.equal(a.delivery.status, 200);
      const b = await sb.fire({ type: 'button_press' });
      assert.equal(b.delivery.status, 200);
      assert.ok(await waitFor(() => /button_press/.test(rx.out)), rx.out);
      assert.match(rx.out, /event motion_detected/);
      // Wrong key -> 401 from the receiver.
      const sb2 = createSandbox({ signingKey: 'wrong', webhookUrl: `http://127.0.0.1:${port}/webhooks/ring` });
      const r = await sb2.fire({ type: 'button_press' });
      assert.equal(r.delivery.status, 401);
    } finally {
      await sb.close();
      rx.proc.kill();
    }
  });
}
