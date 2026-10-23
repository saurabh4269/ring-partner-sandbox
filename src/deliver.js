// Send a signed webhook the way Ring does: POST, application/json, X-Signature over raw bytes.
import { sign } from './verify.js';

/**
 * @returns {Promise<{ ok: boolean, status: number|null, ms: number, error?: string, request_id: string }>}
 */
export async function deliver(url, signingKey, payload, { timeoutMs = 5000 } = {}) {
  const raw = JSON.stringify(payload);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ring-partner-sandbox-webhooks', 'X-Signature': sign(signingKey, raw) },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, request_id: payload?.meta?.request_id };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - t0, error: err.name === 'TimeoutError' ? 'timeout (Ring treats >5s as 5xx)' : err.message, request_id: payload?.meta?.request_id };
  }
}
