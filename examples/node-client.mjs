#!/usr/bin/env node
// Minimal Ring Partner API client: discover devices, read history, download a snapshot.
// Zero dependencies (Node >= 20). Works against the sandbox or the real API:
//
//   node bin/ring-sandbox.js serve &
//   node examples/node-client.mjs                      # defaults to the sandbox
//   RING_API_BASE=https://api.amazonvision.com RING_ACCESS_TOKEN=<playground token> node examples/node-client.mjs
//
// Optional: SNAPSHOT_OUT=snap.jpg to choose where the image is written.
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.RING_API_BASE || 'http://localhost:8686').replace(/\/+$/, '');
const TOKEN = process.env.RING_ACCESS_TOKEN || 'sandbox-token';
const OUT = process.env.SNAPSHOT_OUT || 'snapshot.jpg';

// Ring's WAF answers 406 unless both User-Agent and Hardware_Id are present.
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'ring-sandbox-example/1.0',
  Hardware_Id: process.env.RING_HARDWARE_ID || randomUUID(),
  Accept: 'application/vnd.api+json',
};

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...HEADERS, ...init.headers }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.errors?.[0];
    throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${e ? `${e.code}: ${e.detail}` : ''}`);
  }
  return body;
}

// JSON:API: related resources live in the top-level `included` array, keyed by type + id.
function included(doc, rel) {
  if (!rel?.data) return undefined;
  return doc.included?.find((r) => r.type === rel.data.type && r.id === rel.data.id);
}

async function snapshot(deviceId) {
  // Step 1: POST returns 303 See Other with a signed, short-lived download URL.
  const res = await api(`/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'latest_in_range', start_timestamp: Date.now() - 3600_000, end_timestamp: Date.now() }),
  });
  if (res.status !== 303) throw new Error(`expected 303 from image/download, got ${res.status}`);
  // Step 2: GET the Location. It carries its own security_token: do NOT send the bearer token there.
  const img = await fetch(res.headers.get('location'), { headers: { 'User-Agent': HEADERS['User-Agent'], Hardware_Id: HEADERS.Hardware_Id } });
  if (!img.ok) throw new Error(`download -> ${img.status}`);
  return {
    bytes: Buffer.from(await img.arrayBuffer()),
    type: img.headers.get('content-type'),
    ts: Number(img.headers.get('x-media-timestamp')) || null,
    origin: img.headers.get('x-media-origin'),
  };
}

const me = await api('/v1/users/me');
console.log(`account  ${me.data.id}`);

const devices = await api('/v1/devices?include=status');
console.log(`devices  ${devices.data.length}`);
for (const d of devices.data) {
  const online = included(devices, d.relationships?.status)?.attributes?.online;
  console.log(`  - ${d.attributes.name} (${d.id}) ${online === undefined ? '' : online ? 'online' : 'OFFLINE'}`);
}

const first = devices.data[0];
if (!first) { console.log('no devices'); process.exit(0); }

const history = await api(`/v1/history/devices/${encodeURIComponent(first.id)}/events?event_types=motion,ding`);
console.log(`history  ${history.data.length} recent motion/ding events on ${first.attributes.name}`);
for (const e of history.data.slice(0, 3)) console.log(`  - ${new Date(e.attributes.start).toISOString()} ${e.attributes.event_type}`);

const snap = await snapshot(first.id);
await writeFile(OUT, snap.bytes);
console.log(`snapshot ${snap.bytes.length} bytes ${snap.type} origin=${snap.origin} ts=${snap.ts} -> ${OUT}`);
