import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sign } from '../src/verify.js';

const py = spawnSync('python3', ['--version']);
test('python/verify.py agrees with the JS signer', { skip: py.status !== 0 && 'python3 not installed' }, () => {
  const raw = '{"meta":{"version":"1.1"},"data":{"type":"button_press"}}';
  const dir = fileURLToPath(new URL('../python/', import.meta.url));
  const code = `import sys; sys.path.insert(0, sys.argv[1]); from verify import verify_signature as v; raw=sys.argv[2].encode(); print(v("k", raw, sys.argv[3]), v("k", raw + b" ", sys.argv[3]), v("x", raw, sys.argv[3]))`;
  const out = spawnSync('python3', ['-I', '-c', code, dir, raw, sign('k', raw)], { encoding: 'utf8' });
  assert.equal(out.stderr, '');
  assert.equal(out.stdout.trim(), 'True False False');
});
