// Record / replay fixtures.
//
// createRecorder(): a transparent proxy in front of the real Ring Partner API. Every response is
// returned to the caller unchanged (except that snapshot 303 redirects are routed back through the
// proxy so the image can be captured) and saved as a JSON fixture file, with secrets redacted.
//
// loadFixtures() / matchFixture(): used by createSandbox({ fixtures }) to serve recorded responses
// for matching method + path (+ query) before falling back to the built-in mock.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRawBody } from './verify.js';

/** Query parameters that carry credentials. Always redacted, whatever --redact says. */
export const SECRET_PARAMS = ['security_token', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'signature', 'token', 'access_token', 'refresh_token', 'code'];
/** Query parameters ignored when matching a request to a fixture (volatile or secret). */
const VOLATILE_PARAMS = new Set([...SECRET_PARAMS, 'req_id', 'x-amz-date', 'x-amz-expires']);
const SAVED_HEADERS = ['content-type', 'x-media-timestamp', 'x-media-origin'];
const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);
const REDACTED = 'REDACTED';
/** Statuses not worth replaying: expired token, missing WAF headers, rate limits, upstream outages. */
const NOT_RECORDED = new Set([401, 403, 406, 429, 500, 502, 503, 504]);

/** Canonical query string used for matching: volatile params dropped, keys sorted. */
export function canonicalQuery(searchParams) {
  const pairs = [...searchParams].filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()));
  pairs.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  return new URLSearchParams(pairs).toString();
}

/** Stable, readable file name for a request. */
export function fixtureName(method, path, query = '') {
  const slug = path.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'root';
  const q = query ? '__' + createHash('sha1').update(query).digest('hex').slice(0, 8) : '';
  return `${method.toUpperCase()}_${slug}${q}`;
}

/** Replace secret query params in a URL (absolute or path) with REDACTED. */
export function redactUrl(u) {
  const abs = /^https?:\/\//i.test(u);
  const url = new URL(u, 'http://x');
  for (const k of [...url.searchParams.keys()]) if (SECRET_PARAMS.includes(k.toLowerCase())) url.searchParams.set(k, REDACTED);
  return abs ? url.toString() : url.pathname + url.search;
}

/**
 * Deep-redact a JSON value: known secrets (bearer tokens seen on the wire) are replaced everywhere;
 * with ids=true, Ring account ids are mapped to stable placeholders and e-mail addresses are masked.
 */
function redactJson(value, ctx) {
  if (typeof value === 'string') return redactString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (ctx.ids && k === 'email' && typeof v === 'string') out[k] = 'redacted@example.com';
      else out[k] = redactJson(v, ctx);
    }
    return out;
  }
  return value;
}

function redactString(s, ctx) {
  for (const secret of ctx.secrets) if (secret && secret.length >= 6) s = s.split(secret).join(REDACTED);
  if (/^https?:\/\/|^\/v1\//.test(s) && s.includes('?')) s = redactUrl(s);
  if (ctx.ids) {
    s = s.replace(/ava1\.ring\.account\.[A-Za-z0-9-]+/g, (m) => {
      if (!ctx.accounts.has(m)) ctx.accounts.set(m, `ava1.ring.account.REDACTED${String(ctx.accounts.size + 1).padStart(4, '0')}`);
      return ctx.accounts.get(m);
    });
  }
  return s;
}

/**
 * Start a recording proxy. Returns { server, listen(port, host), close(), url, recorded }.
 * @param {object} o
 * @param {string} o.upstream   e.g. https://api.amazonvision.com
 * @param {string} o.out        fixtures directory (created if missing)
 * @param {boolean} [o.redact=true]  also redact account ids and e-mails (tokens are always redacted)
 * @param {(msg:string)=>void} [o.log]
 */
export function createRecorder({ upstream, out, redact = true, log = () => {} } = {}) {
  if (!upstream) throw new Error('createRecorder: upstream is required');
  if (!out) throw new Error('createRecorder: out is required');
  const up = new URL(upstream);
  mkdirSync(out, { recursive: true });
  const ctx = { secrets: new Set(), ids: redact, accounts: new Map() };
  const pendingImages = new Map(); // download id -> fixture name of the POST that produced the 303
  const recorded = [];

  function save(name, fixture) {
    writeFileSync(join(out, name + '.json'), JSON.stringify(fixture, null, 2) + '\n');
    recorded.push(name);
  }

  async function handle(req, res) {
    const base = `http://${req.headers.host}`;
    const inUrl = new URL(req.url, base);
    const auth = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    if (bearer) ctx.secrets.add(bearer.trim());

    // Snapshot step 2: we rewrote the 303 Location to /_record/download?id=..&u=<original>.
    let target;
    let imageFor = null;
    if (inUrl.pathname === '/_record/download') {
      target = new URL(inUrl.searchParams.get('u') || '');
      imageFor = pendingImages.get(inUrl.searchParams.get('id')) || null;
    } else {
      target = new URL(inUrl.pathname + inUrl.search, up);
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    // Signed download URLs carry their own auth; never send the bearer token to them.
    if (imageFor !== null || target.origin !== up.origin) delete headers.authorization;
    headers['accept-encoding'] = 'identity';
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRawBody(req, { limit: 10_000_000 });

    let upRes;
    try {
      upRes = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    } catch (err) {
      log(`${req.method} ${inUrl.pathname} -> upstream error: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/vnd.api+json' });
      return res.end(JSON.stringify({ errors: [{ status: '502', code: 'UPSTREAM_UNREACHABLE', detail: err.message }] }));
    }
    const buf = Buffer.from(await upRes.arrayBuffer());
    const outHeaders = {};
    upRes.headers.forEach((v, k) => { if (!HOP.has(k) && k !== 'content-encoding') outHeaders[k] = v; });

    const name = imageFor ?? fixtureName(req.method, inUrl.pathname, canonicalQuery(inUrl.searchParams));
    const savedHeaders = Object.fromEntries(SAVED_HEADERS.filter((h) => upRes.headers.has(h)).map((h) => [h, upRes.headers.get(h)]));
    const ctype = upRes.headers.get('content-type') || '';

    if (imageFor !== null) {
      // Attach the image bytes to the POST fixture that issued the redirect.
      const ext = /png/i.test(ctype) ? 'png' : 'jpg';
      if (upRes.ok) {
        writeFileSync(join(out, `${imageFor}.${ext}`), buf);
        const file = join(out, imageFor + '.json');
        const fx = JSON.parse(readFileSync(file, 'utf8'));
        fx.response.image = { file: `${imageFor}.${ext}`, headers: savedHeaders };
        writeFileSync(file, JSON.stringify(fx, null, 2) + '\n');
        log(`GET  (download) -> ${upRes.status} saved ${imageFor}.${ext} (${buf.length} bytes)`);
      } else {
        log(`GET  (download) -> ${upRes.status} (not saved)`);
      }
    } else if (inUrl.pathname.startsWith('/_sandbox') || NOT_RECORDED.has(upRes.status)) {
      // Control plane, or an auth/WAF/server error caused by this session rather than the API's data.
      log(`${req.method.padEnd(4)} ${inUrl.pathname} -> ${upRes.status} (not saved)`);
    } else {
      const fixture = {
        request: {
          method: req.method,
          path: inUrl.pathname,
          query: redactUrl('/?' + canonicalQuery(inUrl.searchParams)).slice(2),
          recorded_at: new Date().toISOString(),
        },
        response: { status: upRes.status, headers: savedHeaders },
      };
      if (body?.length && /json/i.test(req.headers['content-type'] || '')) {
        try { fixture.request.body = redactJson(JSON.parse(body.toString('utf8')), ctx); } catch { /* not JSON */ }
      }
      if (/json/i.test(ctype)) {
        try { fixture.response.body = redactJson(JSON.parse(buf.toString('utf8') || 'null'), ctx); } catch { fixture.response.text = redactString(buf.toString('utf8'), ctx); }
      } else if (/^text\//i.test(ctype)) {
        fixture.response.text = redactString(buf.toString('utf8'), ctx);
      }
      const loc = upRes.headers.get('location');
      if (loc && upRes.status >= 300 && upRes.status < 400) {
        fixture.response.headers.location = redactUrl(new URL(loc, target).toString());
        const id = String(pendingImages.size + 1) + '-' + Date.now().toString(36);
        pendingImages.set(id, name);
        outHeaders.location = `${base}/_record/download?id=${id}&u=${encodeURIComponent(new URL(loc, target).toString())}`;
      }
      save(name, fixture);
      log(`${req.method.padEnd(4)} ${inUrl.pathname} -> ${upRes.status} saved ${name}.json`);
    }

    res.writeHead(upRes.status, outHeaders);
    res.end(buf);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(err.message)); } else res.end();
    });
  });

  return {
    server,
    recorded,
    listen(port = 8687, host = '127.0.0.1') {
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

/** Load every *.json fixture in a directory. Returns Map<"METHOD path?query", fixture>. */
export function loadFixtures(dir) {
  const map = new Map();
  if (!dir || !existsSync(dir)) throw new Error(`fixtures directory not found: ${dir}`);
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    let fx;
    try { fx = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!fx?.request?.method || !fx?.request?.path || !fx.response) continue;
    if (fx.response.image?.file) {
      const p = join(dir, fx.response.image.file);
      if (existsSync(p)) fx.response.image.bytes = readFileSync(p);
    }
    fx.file = f;
    const key = `${fx.request.method.toUpperCase()} ${fx.request.path}`;
    map.set(`${key}?${fx.request.query || ''}`, fx);
    if (!map.has(key)) map.set(key, fx); // first fixture for a path is the query-less fallback
  }
  return map;
}

/** Find the fixture for a request: exact method+path+query first, then method+path. */
export function matchFixture(map, method, path, searchParams) {
  if (!map?.size) return null;
  const key = `${method.toUpperCase()} ${path}`;
  return map.get(`${key}?${canonicalQuery(searchParams)}`) || map.get(key) || null;
}
