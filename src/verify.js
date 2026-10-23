// Ring webhook signature verification (v1.1).
// Ring signs the *raw request body bytes* with HMAC-SHA256 and sends
//   X-Signature: sha256=<lowercase hex>
// Verify against the exact bytes you received. Parsing then re-serialising the
// JSON changes whitespace/key order and the signature will no longer match.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compute the header value Ring would send for `rawBody`. */
export function sign(signingKey, rawBody) {
  return 'sha256=' + createHmac('sha256', signingKey).update(rawBody).digest('hex');
}

/**
 * Constant-time check of an `X-Signature` header against the raw body.
 * @param {string|Buffer} signingKey
 * @param {string|Buffer} rawBody  exact bytes received (Buffer preferred)
 * @param {string|undefined} header value of X-Signature, e.g. "sha256=ab12..."
 * @returns {boolean}
 */
export function verifySignature(signingKey, rawBody, header) {
  if (!signingKey || rawBody == null || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const got = Buffer.from(m[1], 'hex');
  const want = createHmac('sha256', signingKey).update(rawBody).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Idempotency on meta.request_id (Ring retries 5xx/timeouts, so duplicates happen).
 * In-memory and bounded; swap for Redis/DB in production.
 * @returns {{ firstDelivery(id: string): boolean, size: number }}
 */
export function idempotency({ max = 10_000 } = {}) {
  const seen = new Set();
  return {
    firstDelivery(requestId) {
      if (!requestId) return true;
      if (seen.has(requestId)) return false;
      seen.add(requestId);
      if (seen.size > max) seen.delete(seen.values().next().value);
      return true;
    },
    get size() { return seen.size; },
  };
}

/** Read the full raw body of a Node IncomingMessage. */
export function readRawBody(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Middleware for node:http, Express and Connect: `(req, res, next)`.
 * Captures the raw body, verifies X-Signature, rejects with 401 on mismatch,
 * acknowledges duplicate request_ids with 200 (so Ring stops retrying) and
 * otherwise sets `req.rawBody`, `req.body` (parsed JSON) and calls next().
 *
 * With Express, mount it *instead of* express.json() on the webhook route,
 * or use express.raw({ type: '*\/*' }) before it (a Buffer req.body is reused).
 */
export function ringWebhookMiddleware(signingKey, { dedupe = idempotency(), onDuplicate } = {}) {
  if (!signingKey) throw new Error('ringWebhookMiddleware: signingKey is required');
  return async function ringWebhook(req, res, next) {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : req.rawBody ?? (await readRawBody(req));
      const header = req.headers['x-signature'];
      if (!verifySignature(signingKey, raw, header)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      req.rawBody = raw;
      req.body = body;
      if (dedupe && !dedupe.firstDelivery(body?.meta?.request_id)) {
        onDuplicate?.(body);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }
      if (typeof next === 'function') next();
    } catch (err) {
      if (typeof next === 'function') return next(err);
      res.statusCode = err.status || 500;
      res.end();
    }
  };
}
