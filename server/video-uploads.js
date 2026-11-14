// Pure rules for large video uploads sent in parts. No I/O here, so every rule is table-testable.
// The store (storage.js) holds the parts; these rules decide the part plan, what is still
// missing after a dropped connection, and whether the parts add up to the file that was promised.

const TOKEN_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^videos\/([0-9a-f]{32})\/(\d{1,2})\.(mp4|mov|webm)$/;

const MiB = 1024 * 1024;

// S3 and MinIO: every part but the last must be at least 5 MiB, and an upload has at most 10,000 parts.
const MIN_PART_BYTES = 5 * MiB;
const MAX_PARTS = 10000;

const VIDEO_LIMITS = Object.freeze({
  maxVideos: 3,
  maxBytes: 2 * 1024 * MiB,
  partBytes: 8 * MiB,
  contentTypes: Object.freeze({
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  }),
});

function videoKey(token, index, contentType, limits = VIDEO_LIMITS) {
  const ext = limits.contentTypes[contentType];
  return `videos/${token}/${index}.${ext}`;
}

// Returns null when the request is acceptable, otherwise a short reason.
function validateVideoRequest(req, limits = VIDEO_LIMITS) {
  if (!req || typeof req !== "object") return "Invalid request";
  if (typeof req.token !== "string" || !TOKEN_RE.test(req.token)) return "Invalid session token";
  if (!Number.isInteger(req.total) || req.total < 1 || req.total > limits.maxVideos) {
    return `total must be a whole number from 1 to ${limits.maxVideos}`;
  }
  if (!Number.isInteger(req.index) || req.index < 0 || req.index >= req.total) {
    return "index must be a whole number below total";
  }
  if (typeof req.contentType !== "string" || !Object.hasOwn(limits.contentTypes, req.contentType)) {
    return `contentType must be one of ${Object.keys(limits.contentTypes).join(", ")}`;
  }
  if (!Number.isInteger(req.size) || req.size < 1 || req.size > limits.maxBytes) {
    return `size must be a whole number of bytes from 1 to ${limits.maxBytes}`;
  }
  return null;
}

// True only for exactly videos/<this token>/<n>.<mp4|mov|webm>.
function videoKeyBelongsToSession(key, token) {
  if (typeof key !== "string" || typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const m = KEY_RE.exec(key);
  if (!m || m[1] !== token) return false;
  return m[2] === String(Number(m[2]));
}

// The part plan for one file. A file too big for 10,000 parts of the default size gets bigger
// parts, rounded up to a whole MiB. A file smaller than one part is a single part.
function planParts(size, limits = VIDEO_LIMITS) {
  let partBytes = limits.partBytes;
  if (Math.ceil(size / partBytes) > MAX_PARTS) {
    partBytes = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  }
  const count = Math.max(1, Math.ceil(size / partBytes));
  return { size, partBytes, count };
}

// Bytes in part n (1 based): every part is a full part except the last, which is what remains.
function partSize(plan, n) {
  if (!Number.isInteger(n) || n < 1 || n > plan.count) return 0;
  return n < plan.count ? plan.partBytes : plan.size - plan.partBytes * (plan.count - 1);
}

// `uploaded` is what the store lists: [{ partNumber, size, etag }]. A part that is not listed, or
// is listed at the wrong size, is still owed; the rest are skipped, which is the whole point of a resume.
function missingParts(plan, uploaded) {
  const have = new Map();
  for (const p of uploaded || []) have.set(p.partNumber, p);
  const missing = [];
  for (let n = 1; n <= plan.count; n++) {
    const p = have.get(n);
    if (!p || p.size !== partSize(plan, n)) missing.push(n);
  }
  return missing;
}

// Null when the listed parts are exactly the promised file, otherwise a short reason. It checks
// before the store is asked to join the parts, so a short upload is never stitched into a "finished" video.
function checkComplete(plan, uploaded) {
  const list = uploaded || [];
  if (list.length !== plan.count) return `Expected ${plan.count} parts, the store holds ${list.length}`;
  const seen = new Set();
  for (const p of list) {
    if (seen.has(p.partNumber)) return `Part ${p.partNumber} is listed twice`;
    seen.add(p.partNumber);
    if (!p.etag) return `Part ${p.partNumber} has no checksum from the store`;
    if (p.size !== partSize(plan, p.partNumber)) return `Part ${p.partNumber} is the wrong size`;
  }
  return null;
}

module.exports = {
  VIDEO_LIMITS,
  MIN_PART_BYTES,
  MAX_PARTS,
  videoKey,
  validateVideoRequest,
  videoKeyBelongsToSession,
  planParts,
  partSize,
  missingParts,
  checkComplete,
};
