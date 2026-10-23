// Pure rules for direct-to-storage uploads. No I/O here, so every rule is table-testable.

const TOKEN_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^sessions\/([0-9a-f]{32})\/(\d{1,2})\.jpg$/;

const LIMITS = Object.freeze({
  maxImages: 10,
  maxBytes: 10 * 1024 * 1024,
  contentTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
});

function objectKey(token, index) {
  return `sessions/${token}/${index}.jpg`;
}

// Token, index and total only: shared by the URL request and the "uploaded" report.
function validateSlot({ token, index, total }, limits = LIMITS) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return "Invalid session token";
  if (!Number.isInteger(total) || total < 1 || total > limits.maxImages) {
    return `total must be a whole number from 1 to ${limits.maxImages}`;
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return "index must be a whole number below total";
  }
  return null;
}

// Returns null when the request is acceptable, otherwise a short reason.
function validateUploadRequest(req, limits = LIMITS) {
  if (!req || typeof req !== "object") return "Invalid request";
  const slot = validateSlot(req, limits);
  if (slot) return slot;
  if (typeof req.contentType !== "string" || !limits.contentTypes.includes(req.contentType)) {
    return `contentType must be one of ${limits.contentTypes.join(", ")}`;
  }
  if (!Number.isInteger(req.size) || req.size < 1 || req.size > limits.maxBytes) {
    return `size must be a whole number of bytes from 1 to ${limits.maxBytes}`;
  }
  return null;
}

// True only for exactly sessions/<this token>/<n>.jpg. Anything else is refused:
// traversal, another session's prefix, extra segments, encoded dots, an empty key.
function keyBelongsToSession(key, token) {
  if (typeof key !== "string" || typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const m = KEY_RE.exec(key);
  if (!m || m[1] !== token) return false;
  return m[2] === String(Number(m[2]));
}

module.exports = { LIMITS, objectKey, validateSlot, validateUploadRequest, keyBelongsToSession };
