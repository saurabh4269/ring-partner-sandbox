// Runs the composite action's shell step (action.yml) locally, the way GitHub would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const hasBash = spawnSync('bash', ['--version']).status === 0;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('action.yml starts the sandbox and outputs base-url', { skip: !hasBash && 'bash not available' }, async () => {
  const yml = readFileSync(join(root, 'action.yml'), 'utf8');
  const script = yml.split('run: |\n')[1].split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n');
  for (const out of ['base-url', 'token', 'log-file']) assert.match(yml, new RegExp(`^  ${out}:`, 'm'));
  const dir = mkdtempSync(join(tmpdir(), 'ring-action-'));
  const port = await freePort();
  const env = {
    ...process.env, RS_BIN: join(root, 'bin/ring-sandbox.js'), RS_PORT: String(port), RS_TOKEN: 'ci-token',
    RS_WEBHOOK_URL: '', RS_SIGNING_KEY: 'k', RS_SCENARIO: '', RS_SPEED: '1', RS_DEVICES: '2', RS_FIXTURES: '',
    RS_WAF: 'true', RS_TIMEOUT: '10', GITHUB_ENV: join(dir, 'env'), GITHUB_OUTPUT: join(dir, 'out'), RUNNER_TEMP: dir,
  };
  const r = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
  const pid = Number(/RING_SANDBOX_PID=(\d+)/.exec(readFileSync(env.GITHUB_ENV, 'utf8'))?.[1]);
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = readFileSync(env.GITHUB_OUTPUT, 'utf8');
    assert.match(out, new RegExp(`base-url=http://127.0.0.1:${port}`));
    assert.match(out, /token=ci-token/);
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, { headers: { Authorization: 'Bearer ci-token', 'User-Agent': 'ci', Hardware_Id: 'x' } });
    assert.equal((await res.json()).data.length, 2);
  } finally {
    if (pid) process.kill(pid);
    rmSync(dir, { recursive: true, force: true });
  }
});
