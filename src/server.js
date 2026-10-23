// Mock of the Ring Partner API (https://api.amazonvision.com), JSON:API flavoured.
// Shapes follow the public docs; see README "Fidelity" for what is approximated.
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildEvent, historyTypeFor, DEFAULT_ACCOUNT_ID, MOTION_SUB_TYPES } from './events.js';
import { deliver } from './deliver.js';
import { placeholderJpeg, placeholderPng } from './image.js';
import { readRawBody } from './verify.js';
import { loadFixtures, matchFixture } from './fixtures.js';

const PAGE_SIZE = 20;
const DOWNLOAD_TTL_MS = 60_000;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const meta = () => ({ time: nowIso() });

export const DEFAULTS = {
  port: 8686,
  host: '127.0.0.1',
  token: 'sandbox-token',
  signingKey: 'sandbox-signing-key',
  devices: 1,
  waf: true,
  simFlag: true,
  accountId: DEFAULT_ACCOUNT_ID,
  seedHistory: true,
};

const NAMES = ['Front Door', 'Backyard', 'Driveway', 'Garage', 'Side Gate', 'Porch', 'Patio', 'Nursery'];

function makeDevice(i) {
  const n = String(i + 1).padStart(4, '0');
  return {
    id: `ava1.ring.device.SANDBOX${n}`,
    name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''),
    model: i === 0 ? 'DoorbellPro' : 'StickUpCam',
    online: true,
    removed: false,
    location: { country: 'US', state: 'WA' },
  };
}

function seed(state) {
  const now = Date.now();
  for (const d of state.devices) {
    const base = [
      { t: 55 * 60_000, event_type: 'motion', sub: 'vehicle' },
      { t: 40 * 60_000, event_type: 'ding' },
      { t: 25 * 60_000, event_type: 'motion', sub: 'human' },
      { t: 12 * 60_000, event_type: 'on_demand' },
      { t: 4 * 60_000, event_type: 'motion', sub: 'other_motion' },
    ];
    for (const b of base) record(state, d.id, b.event_type, b.sub, now - b.t);
  }
}

function record(state, deviceId, eventType, subType, start) {
  const ev = {
    id: `ava1.ring.event.${randomBytes(8).toString('hex').toUpperCase()}`,
    deviceId,
    event_type: eventType,
    sub_type: subType || null,
    start,
    end: start + (eventType === 'ding' ? 15_000 : 25_000),
    reviewed: false,
  };
  state.history.push(ev);
  return ev;
}

// ---------- JSON:API helpers ----------
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/vnd.api+json', 'X-Request-ID': res.requestId, ...headers });
  res.end(data);
}

function apiError(res, status, code, detail, pointer) {
  const err = { id: res.requestId, status: String(status), code, detail, meta: { timestamp: nowIso() } };
  if (pointer) err.source = { pointer };
  send(res, status, { errors: [err] });
}

const rel = (d, name, type, idPrefix) => ({
  data: { type, id: `ava1.ring.device.${idPrefix}.${d.id.split('.').pop()}` },
  links: { related: `/v1/devices/${d.id}/${name}` },
});

function deviceResource(d) {
  return {
    type: 'devices',
    id: d.id,
    attributes: { name: d.name, image_url: `https://sandbox.invalid/products/${d.model.toLowerCase()}.png` },
    relationships: {
      status: rel(d, 'status', 'device-status', 'status'),
      capabilities: rel(d, 'capabilities', 'device-capabilities', 'capabilities'),
      configurations: rel(d, 'configurations', 'device-configurations', 'configurations'),
      location: rel(d, 'location', 'locations', 'location'),
    },
  };
}

const statusResource = (d) => ({ type: 'device-status', id: rel(d, 'status', 'device-status', 'status').data.id, attributes: { online: d.online } });
const capabilitiesResource = (d) => ({
  type: 'device-capabilities',
  id: rel(d, 'capabilities', 'device-capabilities', 'capabilities').data.id,
  attributes: {
    video: { configurations: ['resolution_mode'], codecs: ['AVC'], ratio: '16:9', max_resolution: 1080, supported_resolutions: [1080] },
    motion_detection: { configurations: ['enabled', 'motion_zones'] },
    image_enhancements: { configurations: ['color_night_vision', 'hdr', 'ir_led_night_vision', 'privacy_zones'] },
  },
  relationships: { configurations: { links: { related: `/v1/devices/${d.id}/configurations` } } },
});
const configurationsResource = (d) => ({
  type: 'device-configurations',
  id: rel(d, 'configurations', 'device-configurations', 'configurations').data.id,
  attributes: {
    e2e_encryption: { enabled: false },
    motion_detection: {
      enabled: 'on',
      motion_zones: [{ id: '5b1f6c1e-0000-4000-8000-000000000001', vertices: [{ x: 0, y: 0.2 }, { x: 1, y: 0.2 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }],
      component_id: '0',
    },
    video: { component_id: '0' },
    image_enhancements: { color_night_vision: 'off', hdr: 'off', ir_led_night_vision: 'off', privacy_zones: [] },
  },
});
const locationResource = (d) => ({ type: 'locations', id: rel(d, 'location', 'locations', 'location').data.id, attributes: { ...d.location } });

const INCLUDES = { status: statusResource, capabilities: capabilitiesResource, configurations: configurationsResource, location: locationResource };

function historyResource(ev) {
  return {
    type: 'history-events',
    id: ev.id,
    attributes: { event_type: ev.event_type, is_third_party_reviewed: ev.reviewed, start: ev.start, end: ev.end },
    relationships: { source: { data: { type: 'devices', id: ev.deviceId } } },
  };
}

function matchesFilter(ev, filters) {
  if (!filters.length) return true;
  return filters.some((f) => {
    const [t, sub] = f.split('.');
    if (t !== ev.event_type) return false;
    return !sub || sub === ev.sub_type;
  });
}

// ---------- server ----------
/**
 * Create a sandbox. Returns { server, state, listen(port?), close(), url, fire(evt) }.
 */
export function createSandbox(opts = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const state = {
    devices: Array.from({ length: Math.max(1, Number(o.devices) || 1) }, (_, i) => makeDevice(i)),
    history: [],
    downloads: new Map(),
    deliveries: [],
  };
  if (o.seedHistory) seed(state);
  let snapshotFile = null;
  const log = o.log || (() => {});
  // Recorded responses (see `ring-sandbox record`) take precedence over the mock when they match.
  const fixtures = o.fixtures ? (o.fixtures instanceof Map ? o.fixtures : loadFixtures(o.fixtures)) : null;
  state.fixtures = fixtures ? new Set([...fixtures.values()]).size : 0;

  const visible = () => state.devices.filter((d) => !d.removed);
  const findDevice = (id) => visible().find((d) => d.id === id);

  /** Fire an event: update state, record history, deliver webhook (if a URL is configured). */
  async function fire({ type, sub_type, subType, device, deviceId, url } = {}) {
    const id = deviceId || device || state.devices[0].id;
    const st = sub_type ?? subType;
    const ts = Date.now();
    const d = state.devices.find((x) => x.id === id);
    if (type === 'device_offline' && d) d.online = false;
    if (type === 'device_online' && d) d.online = true;
    if (type === 'device_removed' && d) d.removed = true;
    if (type === 'device_added') {
      if (d) d.removed = false;
      else state.devices.push({ ...makeDevice(state.devices.length), id });
    }
    const ht = historyTypeFor(type);
    let historyEvent = null;
    if (ht) historyEvent = record(state, id, ht, ht === 'motion' ? (st && st !== 'motion' ? st : null) : null, ts);
    const payload = buildEvent({ type, subType: st, deviceId: id, accountId: o.accountId, timestamp: ts, simFlag: o.simFlag });
    const target = url || o.webhookUrl;
    let delivery = null;
    if (target) {
      delivery = await deliver(target, o.signingKey, payload);
      state.deliveries.push({ at: nowIso(), type, url: target, ...delivery });
      if (state.deliveries.length > 200) state.deliveries.shift();
      log(`webhook ${type}${st ? '.' + st : ''} -> ${target} : ${delivery.status ?? delivery.error}`);
    } else {
      log(`event ${type}${st ? '.' + st : ''} recorded (no --webhook-url, not delivered)`);
    }
    return { payload, delivery, history: historyEvent ? historyResource(historyEvent) : null };
  }

  async function handle(req, res) {
    res.requestId = randomUUID();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    // Sandbox control plane (not part of the Ring API; no auth, bind to localhost).
    if (path.startsWith('/_sandbox')) return control(req, res, path, url);
    if (path === '/' && method === 'GET') {
      return send(res, 200, { meta: { ...meta(), sandbox: 'ring-partner-sandbox', note: 'Unofficial local mock of the Ring Partner API. See /_sandbox/state.' } });
    }

    // WAF: Ring returns 406 when User-Agent or Hardware_Id is missing.
    if (o.waf && (!req.headers['user-agent'] || !req.headers['hardware_id'])) {
      res.writeHead(406, { 'Content-Type': 'text/plain' });
      return res.end('Not Acceptable (sandbox WAF: send User-Agent and Hardware_Id headers; disable with --no-waf)');
    }

    // Signed download URL: carries its own auth (security_token), no bearer needed.
    if (path === '/v1/download' && method === 'GET') return download(res, url);

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${o.token}`) return apiError(res, 401, 'UNAUTHORIZED', 'Authentication credentials are missing or invalid');

    const fx = fixtures && matchFixture(fixtures, method, path, url.searchParams);
    if (fx && replay(req, res, fx)) return;

    if (method === 'GET' && path === '/v1/users/me') {
      return send(res, 200, { data: { type: 'users', id: o.accountId, attributes: { first_name: 'Sandy', last_name: 'Box', email: 'sandbox@example.com' } } });
    }

    if (method === 'GET' && path === '/v1/devices') {
      const inc = (url.searchParams.get('include') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = inc.find((i) => !INCLUDES[i]);
      if (bad) return apiError(res, 400, 'INVALID_PAYLOAD', `Unsupported include: ${bad}`, 'include');
      const list = visible();
      const body = { meta: meta(), data: list.map(deviceResource) };
      if (inc.length) body.included = list.flatMap((d) => inc.map((i) => INCLUDES[i](d)));
      return send(res, 200, body);
    }

    let m = /^\/v1\/devices\/([^/]+)(?:\/(status|capabilities|location|configurations))?$/.exec(path);
    if (m && method === 'GET') {
      const d = findDevice(decodeURIComponent(m[1]));
      if (!d) return apiError(res, 404, 'DEVICE_NOT_FOUND', `Unknown device provided: ${decodeURIComponent(m[1])}`);
      if (!m[2]) return send(res, 200, { meta: meta(), data: deviceResource(d) });
      return send(res, 200, { meta: meta(), data: INCLUDES[m[2]](d) });
    }

    m = /^\/v1\/history\/devices\/([^/]+)\/events$/.exec(path);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const d = findDevice(id);
      if (!d) return apiError(res, 404, 'DEVICE_NOT_FOUND', `Unknown device provided: ${id}`);
      const filters = (url.searchParams.get('event_types') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const cursor = url.searchParams.get('page[key]');
      const before = cursor ? Date.parse(cursor) : Infinity;
      if (cursor && Number.isNaN(before)) return apiError(res, 400, 'INVALID_PAYLOAD', 'page[key] must be an ISO timestamp', 'page[key]');
      const all = state.history
        .filter((e) => e.deviceId === id && e.start < before && matchesFilter(e, filters))
        .sort((a, b) => b.start - a.start);
      const page = all.slice(0, PAGE_SIZE);
      const oldest = page.length ? page[page.length - 1].start : before === Infinity ? Date.now() : before;
      const qs = new URLSearchParams();
      if (filters.length) qs.set('event_types', filters.join(','));
      qs.set('page[key]', new Date(oldest).toISOString());
      return send(res, 200, { data: page.map(historyResource), links: { next: `/v1/history/devices/${id}/events?${qs.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}` } });
    }

    m = /^\/v1\/devices\/([^/]+)\/media\/image\/download$/.exec(path);
    if (m && method === 'POST') return imageRequest(req, res, decodeURIComponent(m[1]), url);

    m = /^\/v1\/devices\/([^/]+)\/media\/(streaming\/whep\/sessions|video\/download)(\/.*)?$/.exec(path);
    if (m) {
      const what = m[2].startsWith('streaming') ? 'WHEP live streaming' : 'Video clip download';
      return apiError(res, 501, 'NOT_IMPLEMENTED', `${what} is not mocked by ring-partner-sandbox. Test it against the Ring Developer Playground.`);
    }

    return apiError(res, 404, 'NOT_FOUND', `No sandbox route for ${method} ${path}`);
  }

  /** Serve a recorded fixture. Returns false if it can't be replayed (caller falls back to the mock). */
  function replay(req, res, fx) {
    const r = fx.response;
    res.setHeader('X-Sandbox-Fixture', fx.file);
    if (r.status >= 300 && r.status < 400) {
      if (!r.image?.bytes) return false; // redirect recorded without its media: use the mock flow
      const token = randomBytes(24).toString('base64url');
      const reqId = res.requestId;
      const h = r.image.headers || {};
      state.downloads.set(token, {
        reqId, expires: Date.now() + DOWNLOAD_TTL_MS, bytes: r.image.bytes,
        contentType: h['content-type'] || (/\.png$/i.test(r.image.file) ? 'image/png' : 'image/jpeg'),
        ts: h['x-media-timestamp'], origin: h['x-media-origin'],
      });
      const loc = `http://${req.headers.host}/v1/download?security_token=${token}&req_type=image_download&req_id=${reqId}`;
      res.writeHead(r.status, { Location: loc, 'X-Request-ID': reqId, 'Content-Length': '0' });
      res.end();
      return true;
    }
    const headers = { 'X-Request-ID': res.requestId };
    for (const [k, v] of Object.entries(r.headers || {})) if (k !== 'location') headers[k] = v;
    const data = r.body !== undefined ? JSON.stringify(r.body) : (r.text ?? '');
    headers['content-type'] ??= r.body !== undefined ? 'application/vnd.api+json' : 'text/plain';
    res.writeHead(r.status, headers);
    res.end(data);
    log(`${req.method} ${req.url} -> ${r.status} (fixture ${fx.file})`);
    return true;
  }

  async function imageRequest(req, res, id, url) {
    const d = findDevice(id);
    if (!d) return apiError(res, 404, 'DEVICE_NOT_FOUND', `Unknown device provided: ${id}`);
    let body;
    try {
      const raw = (await readRawBody(req)).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return apiError(res, 400, 'INVALID_PAYLOAD', 'Request body must be JSON');
    }
    const now = Date.now();
    const DAY = 86400_000;
    let ts;
    let origin;
    if (body.type === 'at_timestamp') {
      if (!Number.isInteger(body.timestamp)) return apiError(res, 400, 'INVALID_PAYLOAD', 'timestamp is required for at_timestamp', 'timestamp');
      if (body.timestamp > now || body.timestamp < now - 180 * DAY) return apiError(res, 400, 'INVALID_PAYLOAD', 'timestamp must be within the last 180 days and not in the future', 'timestamp');
      ts = body.timestamp;
      origin = 'recording';
    } else if (body.type === 'latest_in_range') {
      if (!Number.isInteger(body.start_timestamp)) return apiError(res, 400, 'INVALID_PAYLOAD', 'start_timestamp is required for latest_in_range', 'start_timestamp');
      const end = body.end_timestamp ?? now;
      if (!Number.isInteger(end) || end < body.start_timestamp) return apiError(res, 400, 'INVALID_PAYLOAD', 'end_timestamp must be >= start_timestamp', 'end_timestamp');
      if (end - body.start_timestamp > DAY) return apiError(res, 400, 'INVALID_PAYLOAD', 'window must be <= 24 hours', 'end_timestamp');
      const hit = state.history
        .filter((e) => e.deviceId === id && e.start >= body.start_timestamp && e.start <= end)
        .sort((a, b) => b.start - a.start)[0];
      if (hit) { ts = hit.start; origin = 'recording'; hit.reviewed = true; }
      else if (d.online && end >= now - 60_000) { ts = Math.min(end, now); origin = 'snapshot'; }
      else return apiError(res, 416, 'MEDIA_NOT_FOUND', 'No media found in time range');
    } else {
      return apiError(res, 400, 'INVALID_PAYLOAD', 'type must be "at_timestamp" or "latest_in_range"', 'type');
    }
    const format = body.image_options?.format || 'jpeg';
    if (!['jpeg', 'png'].includes(format)) return apiError(res, 400, 'INVALID_PAYLOAD', 'image_options.format must be "jpeg" or "png"', 'image_options.format');
    for (const e of state.history) if (e.deviceId === id && e.start <= ts && e.end >= ts) e.reviewed = true;

    const token = randomBytes(24).toString('base64url');
    const reqId = res.requestId;
    state.downloads.set(token, { reqId, ts, origin, format, expires: Date.now() + DOWNLOAD_TTL_MS });
    for (const [k, v] of state.downloads) if (v.expires < Date.now()) state.downloads.delete(k);
    const base = `http://${req.headers.host}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const loc = `${base}/v1/download?security_token=${token}&req_type=image_download&req_id=${reqId}&X-Amz-Date=${amzDate}&X-Amz-Expires=${DOWNLOAD_TTL_MS / 1000}`;
    res.writeHead(303, { Location: loc, 'X-Request-ID': reqId, 'Content-Length': '0' });
    res.end();
  }

  async function download(res, url) {
    const token = url.searchParams.get('security_token');
    const entry = token && state.downloads.get(token);
    if (!entry || entry.expires < Date.now() || url.searchParams.get('req_id') !== entry.reqId) {
      return apiError(res, 403, 'REQUEST_FORBIDDEN', 'Download link is invalid or expired');
    }
    if (entry.bytes) {
      const h = { 'Content-Type': entry.contentType, 'Content-Length': entry.bytes.length, 'X-Request-ID': entry.reqId };
      if (entry.ts) h['X-Media-Timestamp'] = String(entry.ts);
      if (entry.origin) h['X-Media-Origin'] = entry.origin;
      res.writeHead(200, h);
      return res.end(entry.bytes);
    }
    let bytes;
    let type = entry.format === 'png' ? 'image/png' : 'image/jpeg';
    if (o.snapshot) {
      snapshotFile ??= await readFile(o.snapshot);
      bytes = snapshotFile;
      type = /\.png$/i.test(o.snapshot) ? 'image/png' : 'image/jpeg';
    } else {
      bytes = entry.format === 'png' ? placeholderPng() : placeholderJpeg();
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'X-Request-ID': entry.reqId, 'X-Media-Timestamp': String(entry.ts), 'X-Media-Origin': entry.origin });
    res.end(bytes);
  }

  async function control(req, res, path, url) {
    if (req.method === 'GET' && path === '/_sandbox/state') {
      return send(res, 200, {
        token: o.token,
        account_id: o.accountId,
        webhook_url: o.webhookUrl || null,
        waf: o.waf,
        devices: state.devices,
        history_count: state.history.length,
        fixtures: state.fixtures,
        deliveries: state.deliveries.slice(-50),
      });
    }
    if (req.method === 'POST' && path === '/_sandbox/events') {
      let body;
      try { body = JSON.parse((await readRawBody(req)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      try {
        const out = await fire(body);
        return send(res, 200, out);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.method === 'POST' && path === '/_sandbox/reset') {
      state.history.length = 0;
      state.deliveries.length = 0;
      for (const d of state.devices) { d.online = true; d.removed = false; }
      if (url.searchParams.get('seed') !== 'false') seed(state);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown sandbox route', routes: ['GET /_sandbox/state', 'POST /_sandbox/events', 'POST /_sandbox/reset'] });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) apiError(res, 500, 'INTERNAL_ERROR', err.message);
      else res.end();
    });
  });

  return {
    server,
    state,
    options: o,
    fire,
    listen(port = o.port, host = o.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(this.url)));
    },
    get url() {
      const a = server.address();
      return a ? `http://${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}` : null;
    },
    close() {
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}

export { MOTION_SUB_TYPES };
