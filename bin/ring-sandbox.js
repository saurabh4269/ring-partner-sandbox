#!/usr/bin/env node
// ring-partner-sandbox CLI: serve | fire | play
import { parseArgs } from 'node:util';
import { createSandbox, DEFAULTS } from '../src/server.js';
import { buildEvent, EVENT_TYPES, DEFAULT_DEVICE_ID, DEFAULT_ACCOUNT_ID } from '../src/events.js';
import { deliver } from '../src/deliver.js';
import { loadScenario, playScenario } from '../src/scenario.js';

const HELP = `ring-partner-sandbox - local mock of the Ring Partner API + signed webhook simulator
(unofficial; not affiliated with Ring or Amazon)

Usage:
  ring-sandbox serve [--port 8686] [--host 127.0.0.1] [--token sandbox-token]
                     [--webhook-url URL] [--signing-key KEY] [--devices N]
                     [--snapshot photo.jpg] [--scenario file.json] [--speed 1]
                     [--no-waf] [--no-sim-flag] [--no-seed]
  ring-sandbox fire <type> [--sub-type human|vehicle|motion|other_motion|animal|paid|trial]
                     [--url URL] [--signing-key KEY] [--device ID] [--account ID]
                     [--via http://localhost:8686] [--no-sim-flag] [--print]
  ring-sandbox play <scenario.json> [--url URL] [--signing-key KEY] [--speed 10]
                     [--via http://localhost:8686] [--device ID] [--no-sim-flag]

Event types: ${EVENT_TYPES.join(', ')}

Environment: RING_WEBHOOK_URL, RING_WEBHOOK_SECRET (signing key), RING_SANDBOX_TOKEN, PORT
--via sends the event through a running 'serve' so mock history and webhooks agree.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const neg = (flag) => { const i = rest.indexOf(flag); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
const noWaf = neg('--no-waf');
const noSim = neg('--no-sim-flag');
const noSeed = neg('--no-seed');

const env = process.env;
const common = {
  'signing-key': { type: 'string', default: env.RING_WEBHOOK_SECRET || DEFAULTS.signingKey },
  url: { type: 'string', default: env.RING_WEBHOOK_URL },
  device: { type: 'string' },
  account: { type: 'string', default: DEFAULT_ACCOUNT_ID },
  via: { type: 'string' },
  speed: { type: 'string', default: '1' },
  help: { type: 'boolean', short: 'h' },
};

function die(msg) { console.error(`error: ${msg}\n\nRun 'ring-sandbox --help' for usage.`); process.exit(2); }

async function viaServer(base, step) {
  const res = await fetch(new URL('/_sandbox/events', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(step),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `sandbox returned ${res.status}`);
  return out;
}

function report(type, sub, delivery, url) {
  const label = `${type}${sub ? '.' + sub : ''}`;
  if (!delivery) return console.log(`  ${label}: recorded in mock history (server has no --webhook-url)`);
  const r = delivery.status ? `HTTP ${delivery.status}` : `failed: ${delivery.error}`;
  console.log(`  ${label} -> ${url ?? ''} ${r} (${delivery.ms}ms) request_id=${delivery.request_id}`);
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }

  if (cmd === 'serve') {
    const { values: v } = parseArgs({
      args: rest,
      options: {
        ...common,
        port: { type: 'string', default: env.PORT || String(DEFAULTS.port) },
        host: { type: 'string', default: DEFAULTS.host },
        token: { type: 'string', default: env.RING_SANDBOX_TOKEN || DEFAULTS.token },
        'webhook-url': { type: 'string', default: env.RING_WEBHOOK_URL },
        devices: { type: 'string', default: '1' },
        snapshot: { type: 'string' },
        scenario: { type: 'string' },
      },
    });
    if (v.help) return console.log(HELP);
    const sb = createSandbox({
      token: v.token,
      signingKey: v['signing-key'],
      webhookUrl: v['webhook-url'] || v.url,
      devices: Number(v.devices),
      snapshot: v.snapshot,
      waf: !noWaf,
      simFlag: !noSim,
      seedHistory: !noSeed,
      accountId: v.account,
      log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
    });
    const url = await sb.listen(Number(v.port), v.host);
    console.log(`ring-partner-sandbox listening on ${url}  (unofficial mock, not affiliated with Ring/Amazon)`);
    console.log(`  token:        ${v.token}   (Authorization: Bearer ${v.token})`);
    console.log(`  WAF headers:  ${noWaf ? 'not required (--no-waf)' : 'User-Agent + Hardware_Id required (406 otherwise)'}`);
    console.log(`  devices:      ${sb.state.devices.map((d) => d.id).join(', ')}`);
    console.log(`  webhooks:     ${sb.options.webhookUrl ? `${sb.options.webhookUrl} (X-Signature HMAC-SHA256)` : 'off (pass --webhook-url)'}`);
    console.log(`  point your app at it: RING_API_BASE=${url} RING_ACCESS_TOKEN=${v.token}`);
    if (v.scenario) {
      const steps = await loadScenario(v.scenario);
      console.log(`  playing scenario ${v.scenario} (${steps.length} events, speed x${v.speed})`);
      playScenario(steps, (s) => sb.fire({ type: s.type, sub_type: s.sub_type, device: s.device || v.device }), { speed: Number(v.speed) })
        .then(() => console.log('  scenario finished'))
        .catch((e) => console.error('  scenario error:', e.message));
    }
    const stop = () => sb.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'fire') {
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, 'sub-type': { type: 'string' }, print: { type: 'boolean' } } });
    if (v.help) return console.log(HELP);
    const type = positionals[0];
    if (!EVENT_TYPES.includes(type)) die(`fire needs an event type: ${EVENT_TYPES.join(', ')}`);
    if (v.via) {
      const out = await viaServer(v.via, { type, sub_type: v['sub-type'], device: v.device, url: v.url });
      if (v.print) console.log(JSON.stringify(out.payload, null, 2));
      report(type, v['sub-type'], out.delivery, v.url);
      if (out.delivery && !out.delivery.ok) process.exitCode = 1;
      return;
    }
    const payload = buildEvent({ type, subType: v['sub-type'], deviceId: v.device || DEFAULT_DEVICE_ID, accountId: v.account, simFlag: !noSim });
    if (v.print || !v.url) console.log(JSON.stringify(payload, null, 2));
    if (!v.url) { console.error('(no --url / RING_WEBHOOK_URL: printed payload only)'); return; }
    const d = await deliver(v.url, v['signing-key'], payload);
    report(type, v['sub-type'], d, v.url);
    if (!d.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'play') {
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, speed: { type: 'string', default: '1' } } });
    if (v.help) return console.log(HELP);
    if (!positionals[0]) die('play needs a scenario file');
    if (!v.url && !v.via) die('play needs --url (webhook endpoint) or --via (running sandbox)');
    const steps = await loadScenario(positionals[0]);
    console.log(`playing ${steps.length} events from ${positionals[0]} at x${v.speed}`);
    let failed = 0;
    await playScenario(steps, async (s) => {
      const device = s.device || v.device;
      process.stdout.write(`t+${String(s.at).padStart(4)}s`);
      if (v.via) {
        const out = await viaServer(v.via, { type: s.type, sub_type: s.sub_type, device, url: v.url });
        if (out.delivery && !out.delivery.ok) failed++;
        report(s.type, s.sub_type, out.delivery, v.url);
      } else {
        const d = await deliver(v.url, v['signing-key'], buildEvent({ type: s.type, subType: s.sub_type, deviceId: device || DEFAULT_DEVICE_ID, accountId: v.account, simFlag: !noSim }));
        if (!d.ok) failed++;
        report(s.type, s.sub_type, d, v.url);
      }
    }, { speed: Number(v.speed) });
    if (failed) { console.log(`${failed} deliveries failed`); process.exitCode = 1; }
    return;
  }

  die(`unknown command "${cmd}"`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
