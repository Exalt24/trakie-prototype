// LIFESPAN: permanent
// Large video uploads in parts: the pure rules (no container) and the full flow against MinIO,
// including a dropped connection that resumes and a short upload that is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  VIDEO_LIMITS,
  MAX_PARTS,
  videoKey,
  validateVideoRequest,
  videoKeyBelongsToSession,
  planParts,
  partSize,
  missingParts,
  checkComplete,
} = require("../video-uploads");
const { s3Env, minioTest, ensureBucket, waitFor, wire } = require("./helpers");

const MiB = 1024 * 1024;
const TOKEN = "a".repeat(32);
const OTHER = "b".repeat(32);

// A small seeded generator, so a failing size can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("a file smaller than one part is one part, and a file one byte over makes a one byte last part", () => {
  assert.deepEqual(planParts(1), { size: 1, partBytes: 8 * MiB, count: 1 });
  assert.equal(planParts(8 * MiB).count, 1);
  const two = planParts(8 * MiB + 1);
  assert.equal(two.count, 2);
  assert.equal(partSize(two, 1), 8 * MiB);
  assert.equal(partSize(two, 2), 1);
});

test("the largest allowed video is 256 parts of 8 MiB", () => {
  const plan = planParts(VIDEO_LIMITS.maxBytes);
  assert.equal(plan.count, 256);
  assert.equal(partSize(plan, 256), 8 * MiB);
});

test("a file too big for 10,000 parts gets bigger parts, never more than 10,000", () => {
  const plan = planParts(100 * 1024 * MiB);
  assert.ok(plan.count <= MAX_PARTS, String(plan.count));
  assert.ok(plan.partBytes > 8 * MiB);
  assert.equal(plan.partBytes % MiB, 0);
});

test("the parts of any plan add up to the file, and only the last part is short (400 seeded sizes)", () => {
  const next = rng(7);
  for (let i = 0; i < 400; i++) {
    const size = 1 + Math.floor(next() * 300 * MiB);
    const plan = planParts(size);
    let sum = 0;
    for (let n = 1; n <= plan.count; n++) {
      const p = partSize(plan, n);
      assert.ok(p >= 1, `part ${n} of size ${size}`);
      if (n < plan.count) assert.equal(p, plan.partBytes);
      sum += p;
    }
    assert.equal(sum, size, `size ${size}`);
  }
});

test("partSize is 0 for a part number outside the plan", () => {
  const plan = planParts(20 * MiB);
  for (const n of [0, -1, plan.count + 1, 1.5, NaN, "1"]) assert.equal(partSize(plan, n), 0, String(n));
});

test("missingParts lists what is not stored and what is stored at the wrong size, and skips the rest", () => {
  const plan = planParts(17 * MiB); // 8 + 8 + 1
  const ok = (n) => ({ partNumber: n, size: partSize(plan, n), etag: `"e${n}"` });
  assert.deepEqual(missingParts(plan, []), [1, 2, 3]);
  assert.deepEqual(missingParts(plan, null), [1, 2, 3]);
  assert.deepEqual(missingParts(plan, [ok(1)]), [2, 3]);
  assert.deepEqual(missingParts(plan, [ok(1), ok(3)]), [2]);
  assert.deepEqual(missingParts(plan, [ok(1), ok(2), ok(3)]), []);
  assert.deepEqual(missingParts(plan, [ok(1), { ...ok(2), size: 8 * MiB - 1 }, ok(3)]), [2]);
  assert.deepEqual(missingParts(plan, [ok(1), { partNumber: 99, size: 5, etag: "x" }]), [2, 3]);
});

test("checkComplete accepts exactly the promised parts and names the first problem otherwise", () => {
  const plan = planParts(17 * MiB);
  const ok = (n) => ({ partNumber: n, size: partSize(plan, n), etag: `"e${n}"` });
  const all = [ok(1), ok(2), ok(3)];
  assert.equal(checkComplete(plan, all), null);
  assert.equal(checkComplete(plan, [all[2], all[0], all[1]]), null, "order does not matter");
  assert.match(checkComplete(plan, all.slice(0, 2)), /Expected 3 parts/);
  assert.match(checkComplete(plan, [...all, ok(3)]), /Expected 3 parts/);
  assert.match(checkComplete(plan, [ok(1), ok(1), ok(3)]), /listed twice/);
  assert.match(checkComplete(plan, [ok(1), ok(2), { ...ok(3), size: 2 }]), /wrong size/);
  assert.match(checkComplete(plan, [ok(1), ok(2), { ...ok(3), etag: "" }]), /no checksum/);
  assert.match(checkComplete(plan, [ok(1), ok(2), { ...ok(3), partNumber: 4 }]), /wrong size/);
  assert.match(checkComplete(plan, undefined), /Expected 3 parts/);
});

const good = { token: TOKEN, index: 0, total: 1, contentType: "video/mp4", size: 5 * MiB };

test("validateVideoRequest accepts a good request and refuses each bad field", () => {
  assert.equal(validateVideoRequest(good), null);
  assert.equal(validateVideoRequest({ ...good, size: VIDEO_LIMITS.maxBytes }), null);
  assert.equal(validateVideoRequest({ ...good, contentType: "video/quicktime" }), null);
  assert.equal(validateVideoRequest({ ...good, contentType: "video/webm" }), null);
  const bad = [
    [null, /Invalid request/],
    [{ ...good, token: "short" }, /token/],
    [{ ...good, token: "A".repeat(32) }, /token/],
    [{ ...good, total: 0 }, /total/],
    [{ ...good, total: VIDEO_LIMITS.maxVideos + 1 }, /total/],
    [{ ...good, total: 1.5 }, /total/],
    [{ ...good, index: 1 }, /index/],
    [{ ...good, index: -1 }, /index/],
    [{ ...good, contentType: "image/jpeg" }, /contentType/],
    [{ ...good, contentType: "video/x-matroska" }, /contentType/],
    [{ ...good, contentType: "__proto__" }, /contentType/],
    [{ ...good, contentType: "constructor" }, /contentType/],
    [{ ...good, size: 0 }, /size/],
    [{ ...good, size: VIDEO_LIMITS.maxBytes + 1 }, /size/],
    [{ ...good, size: 1.5 }, /size/],
    [{ ...good, size: "100" }, /size/],
  ];
  for (const [req, re] of bad) assert.match(validateVideoRequest(req) || "", re, JSON.stringify(req));
});

test("a video key belongs to its own session only, in exactly the shape the server makes", () => {
  const key = videoKey(TOKEN, 2, "video/webm");
  assert.equal(key, `videos/${TOKEN}/2.webm`);
  assert.equal(videoKeyBelongsToSession(key, TOKEN), true);
  assert.equal(videoKeyBelongsToSession(key, OTHER), false);
  const refused = [
    `videos/${TOKEN}/../${OTHER}/0.mp4`,
    `videos/${TOKEN}/01.mp4`,
    `videos/${TOKEN}/0.mkv`,
    `videos/${TOKEN}/0.mp4/extra`,
    `sessions/${TOKEN}/0.mp4`,
    `videos/${TOKEN}/0.jpg`,
    `videos/${TOKEN}%2f/0.mp4`,
    "",
    null,
  ];
  for (const k of refused) assert.equal(videoKeyBelongsToSession(k, TOKEN), false, String(k));
  assert.equal(videoKeyBelongsToSession(key, "short"), false);
});

// ---------------------------------------------------------------- the flow against MinIO

const { client, ask, createSession, closeAll } = wire();
process.env.TRAKIE_FAKE_OCR = "1";
Object.assign(process.env, s3Env());
const trakie = require("../index");
let base;

async function boot() {
  if (!base) {
    await new Promise((r) => trakie.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${trakie.server.address().port}`;
    await ensureBucket(trakie.storage.client);
  }
  return base;
}

async function pair() {
  const url = await boot();
  const desktop = await client(url);
  const { token } = await createSession(desktop);
  const phone = await client(url);
  const join = await ask(phone, "join-session", { token, device: "test" });
  assert.equal(join.success, true);
  return { desktop, phone, token };
}

function slice(bytes, plan, n) {
  const start = (n - 1) * plan.partBytes;
  return bytes.subarray(start, start + partSize(plan, n));
}

const putPart = (url, body) => fetch(url, { method: "PUT", body });
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function openUpload(phone, token, bytes, extra = {}) {
  return ask(phone, "request-video-upload", {
    token, index: 0, total: 1, contentType: "video/mp4", size: bytes.length, ...extra,
  });
}

// What the store holds under this key: the finished object and any upload still open.
async function storeState(key) {
  const { HeadObjectCommand, ListMultipartUploadsCommand } = require("@aws-sdk/client-s3");
  const { BUCKET } = require("./helpers");
  const c = trakie.storage.client;
  let object = false;
  try {
    await c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    object = true;
  } catch {
    object = false;
  }
  const open = await c.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: key }));
  return { object, open: (open.Uploads || []).length };
}

test.after(() => {
  closeAll();
  trakie.io.close();
  trakie.storage.client.destroy();
});

minioTest("a 17 MiB video goes up in three parts, is joined and is byte for byte the same", async () => {
  const { phone, token } = await pair();
  const bytes = crypto.randomBytes(17 * MiB);
  const asked = await openUpload(phone, token, bytes);
  assert.ok(asked.parts, JSON.stringify(asked));
  assert.equal(asked.count, 3);
  assert.equal(asked.alreadyUploaded, 0);
  assert.deepEqual(asked.parts.map((p) => p.partNumber), [1, 2, 3]);
  const plan = planParts(bytes.length);
  for (const p of asked.parts) {
    assert.equal((await putPart(p.url, slice(bytes, plan, p.partNumber))).status, 200);
  }
  const done = await ask(phone, "video-uploaded", { token, key: asked.key });
  assert.deepEqual({ success: done.success, size: done.size }, { success: true, size: bytes.length });
  const back = await trakie.storage.getObject(asked.key);
  assert.equal(sha(back), sha(bytes));
  assert.deepEqual(await storeState(asked.key), { object: true, open: 0 });
  assert.match((await openUpload(phone, token, bytes)).error, /already received/);
});

minioTest("a dropped connection resumes: only the missing parts get new URLs and the file is still identical", async () => {
  const { phone, token } = await pair();
  const bytes = crypto.randomBytes(17 * MiB);
  const plan = planParts(bytes.length);
  const first = await openUpload(phone, token, bytes);
  assert.equal(first.parts.length, 3);
  // The phone sends part 1 and part 3, then the connection drops before part 2.
  assert.equal((await putPart(first.parts[0].url, slice(bytes, plan, 1))).status, 200);
  assert.equal((await putPart(first.parts[2].url, slice(bytes, plan, 3))).status, 200);

  const again = await openUpload(phone, token, bytes);
  assert.equal(again.alreadyUploaded, 2);
  assert.deepEqual(again.parts.map((p) => p.partNumber), [2]);
  assert.equal(again.key, first.key);
  assert.equal((await putPart(again.parts[0].url, slice(bytes, plan, 2))).status, 200);

  const done = await ask(phone, "video-uploaded", { token, key: first.key });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(sha(await trakie.storage.getObject(first.key)), sha(bytes));
});

minioTest("a part that was cut short is owed again on resume, and the complete call lists it", async () => {
  const { phone, token } = await pair();
  const bytes = crypto.randomBytes(17 * MiB);
  const plan = planParts(bytes.length);
  const first = await openUpload(phone, token, bytes);
  assert.equal((await putPart(first.parts[0].url, slice(bytes, plan, 1))).status, 200);
  const early = await ask(phone, "video-uploaded", { token, key: first.key });
  assert.match(early.error, /Expected 3 parts/);
  assert.deepEqual(early.missing, [2, 3]);
  assert.equal((await storeState(first.key)).object, false, "a short upload is never joined");
  // positive control: the same flow finishes once the parts are up
  for (const p of first.parts.slice(1)) assert.equal((await putPart(p.url, slice(bytes, plan, p.partNumber))).status, 200);
  assert.equal((await ask(phone, "video-uploaded", { token, key: first.key })).success, true);
});

minioTest("the store refuses a part of another size than the one signed", async () => {
  const { phone, token } = await pair();
  const bytes = crypto.randomBytes(17 * MiB);
  const plan = planParts(bytes.length);
  const asked = await openUpload(phone, token, bytes);
  const part1 = slice(bytes, plan, 1);
  const bad = await putPart(asked.parts[0].url, part1.subarray(0, part1.length - 1));
  assert.ok(bad.status === 400 || bad.status === 403, String(bad.status));
  const bigger = await putPart(asked.parts[0].url, Buffer.concat([part1, Buffer.from([1])]));
  assert.ok(bigger.status === 400 || bigger.status === 403, String(bigger.status));
  assert.equal((await putPart(asked.parts[0].url, part1)).status, 200, "the exact size goes through");
});

minioTest("one slot holds one file: a different size or type for the same slot is refused", async () => {
  const { phone, token } = await pair();
  const bytes = crypto.randomBytes(6 * MiB);
  const asked = await openUpload(phone, token, bytes);
  assert.ok(asked.parts);
  assert.match((await openUpload(phone, token, Buffer.alloc(6 * MiB + 1))).error, /different file/);
  // the same key could only come back with the same extension, so a new type is a new key
  const other = await openUpload(phone, token, bytes, { contentType: "video/webm" });
  assert.notEqual(other.key, asked.key);
});

minioTest("a request that breaks a rule gets a short reason and opens nothing", async () => {
  const { phone, token } = await pair();
  const bytes = Buffer.alloc(10);
  assert.match((await openUpload(phone, token, bytes, { contentType: "image/jpeg" })).error, /contentType/);
  assert.match((await openUpload(phone, token, bytes, { size: VIDEO_LIMITS.maxBytes + 1 })).error, /size/);
  assert.match((await openUpload(phone, token, bytes, { total: 9 })).error, /total/);
  assert.match((await ask(phone, "request-video-upload", { token: "f".repeat(32), index: 0, total: 1, contentType: "video/mp4", size: 5 })).error, /Session not found/);
  assert.deepEqual(await storeState(videoKey(token, 0, "video/mp4")), { object: false, open: 0 });
});

minioTest("only the paired phone can start or finish a video, and a key from another session is refused", async () => {
  const url = await boot();
  const a = await pair();
  const b = await pair();
  const stranger = await client(url);
  const bytes = crypto.randomBytes(6 * MiB);
  assert.match((await openUpload(stranger, a.token, bytes)).error, /Not paired/);
  const asked = await openUpload(a.phone, a.token, bytes);
  const plan = planParts(bytes.length);
  for (const p of asked.parts) await putPart(p.url, slice(bytes, plan, p.partNumber));
  assert.match((await ask(stranger, "video-uploaded", { token: a.token, key: asked.key })).error, /Not paired/);
  // B's phone names A's key under B's token: the key is not B's.
  assert.match((await ask(b.phone, "video-uploaded", { token: b.token, key: asked.key })).error, /Invalid key/);
  assert.equal((await ask(a.phone, "video-uploaded", { token: a.token, key: asked.key })).success, true);
  assert.match((await ask(a.phone, "video-uploaded", { token: a.token, key: asked.key })).error, /already received/);
});

minioTest("an unfinished upload is aborted and a finished video is deleted when the session ends", async () => {
  const unfinished = await pair();
  const finished = await pair();
  const half = crypto.randomBytes(17 * MiB);
  const open = await openUpload(unfinished.phone, unfinished.token, half);
  assert.equal((await putPart(open.parts[0].url, slice(half, planParts(half.length), 1))).status, 200);
  assert.equal((await storeState(open.key)).open, 1, "positive control: the upload is open before the session ends");

  const whole = crypto.randomBytes(6 * MiB);
  const done = await openUpload(finished.phone, finished.token, whole);
  for (const p of done.parts) await putPart(p.url, slice(whole, planParts(whole.length), p.partNumber));
  assert.equal((await ask(finished.phone, "video-uploaded", { token: finished.token, key: done.key })).success, true);
  assert.equal((await storeState(done.key)).object, true, "positive control: the video exists before the session ends");

  unfinished.desktop.disconnect();
  finished.desktop.disconnect();
  await waitFor(async () => (await storeState(open.key)).open === 0);
  await waitFor(async () => (await storeState(done.key)).object === false);
});
