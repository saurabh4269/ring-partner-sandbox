"""Verify a Ring webhook (v1.1) X-Signature header. Standard library only."""
import hashlib
import hmac


def verify_signature(signing_key: str, raw_body: bytes, header: str | None) -> bool:
    """raw_body must be the exact bytes received (Flask: request.get_data())."""
    if not signing_key or raw_body is None or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(signing_key.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):].strip().lower())


_seen: set[str] = set()
def first_delivery(request_id: str | None) -> bool:
    """Idempotency on meta.request_id (in-memory; use a DB in production)."""
    if not request_id: return True
    if request_id in _seen: return False
    _seen.add(request_id); return True
