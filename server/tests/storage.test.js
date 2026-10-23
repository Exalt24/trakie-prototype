const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createStorage } = require("../storage");
const { s3Env, minioTest, ensureBucket, listKeys, waitFor } = require("./helpers");

const TOKEN = crypto.randomBytes(16).toString("hex");
let n = 0;
const nextKey = () => `sessions/${TOKEN}/${n++}.jpg`;

// The store answers 403 for a signature mismatch and 400 when a signed header is missing.
function refused(res) {
  assert.ok(res.status === 403 || res.status === 400, `expected a refusal, got ${res.status}`);
}

function put(url, body, headers = { "Content-Type": "image/jpeg" }) {
  return fetch(url, { method: "PUT", headers, body });
}

let storage;
async function setup() {
  if (!storage) {
    storage = createStorage(s3Env());
    await ensureBucket(storage.client);
  }
  return storage;
}

test("createStorage returns null when S3_BUCKET is unset or empty", () => {
  assert.equal(createStorage({}), null);
  assert.equal(createStorage({ S3_BUCKET: "" }), null);
  assert.equal(createStorage({ S3_ENDPOINT: "http://x", AWS_ACCESS_KEY_ID: "a" }), null);
  assert.notEqual(createStorage({ S3_BUCKET: "b" }), null);
});

test("credentials come only from the standard AWS variables", async () => {
  const s = createStorage({ S3_BUCKET: "b", S3_ENDPOINT: "http://localhost:1" });
  await assert.rejects(s.presignPut("sessions/x/0.jpg", "image/jpeg", 5), /AWS_ACCESS_KEY_ID/);
});

test("a presigned URL signs content-type and content-length and expires in 300 seconds", async () => {
  const s = createStorage(s3Env());
  const url = new URL(await s.presignPut(nextKey(), "image/jpeg", 5));
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  const signed = url.searchParams.get("X-Amz-SignedHeaders").split(";");
  assert.ok(signed.includes("content-type"), signed.join());
  assert.ok(signed.includes("content-length"), signed.join());
  assert.equal(url.pathname.startsWith("/trakie-test/sessions/"), true, "path style for MinIO");
});

minioTest("a PUT with the presigned URL stores the bytes and getObject returns identical bytes", async () => {
  const s = await setup();
  const key = nextKey();
  const bytes = crypto.randomBytes(5000);
  const res = await put(await s.presignPut(key, "image/jpeg", bytes.length), bytes);
  assert.equal(res.status, 200);
  const back = await s.getObject(key);
  assert.ok(Buffer.isBuffer(back));
  assert.ok(back.equals(bytes));
});

minioTest("a PUT with a larger body than signed is refused and nothing is stored", async () => {
  const s = await setup();
  const key = nextKey();
  const url = await s.presignPut(key, "image/jpeg", 100);
  const big = await put(url, crypto.randomBytes(101));
  refused(big);
  assert.deepEqual(await listKeys(s.client, key), []);
  // positive control: the exact size goes through on the same URL
  assert.equal((await put(url, crypto.randomBytes(100))).status, 200);
});

minioTest("a PUT with a smaller body than signed is refused", async () => {
  const s = await setup();
  const key = nextKey();
  const url = await s.presignPut(key, "image/jpeg", 100);
  refused(await put(url, crypto.randomBytes(99)));
  assert.deepEqual(await listKeys(s.client, key), []);
});

minioTest("a PUT with a different Content-Type is refused, and so is one with none", async () => {
  const s = await setup();
  const key = nextKey();
  const url = await s.presignPut(key, "image/jpeg", 50);
  const body = crypto.randomBytes(50);
  refused(await put(url, body, { "Content-Type": "image/png" }));
  refused(await put(url, body, { "Content-Type": "text/html" }));
  refused(await put(url, body, {}));
  assert.deepEqual(await listKeys(s.client, key), []);
  // positive control: the signed type goes through
  assert.equal((await put(url, body, { "Content-Type": "image/jpeg" })).status, 200);
});

minioTest("an expired URL is refused, while a fresh one works", async () => {
  const s = await setup();
  const key = nextKey();
  const body = crypto.randomBytes(20);
  const short = await s.presignPut(key, "image/jpeg", 20, { expiresIn: 1 });
  const fresh = await s.presignPut(key, "image/jpeg", 20);
  await new Promise((r) => setTimeout(r, 2500)); // the expiry itself is the thing under test
  refused(await put(short, body));
  assert.deepEqual(await listKeys(s.client, key), []);
  assert.equal((await put(fresh, body)).status, 200);
});

minioTest("deleteObjects removes the keys, ignores missing ones and accepts an empty list", async () => {
  const s = await setup();
  const keys = [nextKey(), nextKey(), nextKey()];
  for (const key of keys) {
    assert.equal((await put(await s.presignPut(key, "image/jpeg", 10), crypto.randomBytes(10))).status, 200);
  }
  assert.equal((await listKeys(s.client, `sessions/${TOKEN}/`)).filter((k) => keys.includes(k)).length, 3);
  await s.deleteObjects([keys[0], keys[1], `sessions/${TOKEN}/never-existed.jpg`]);
  await waitFor(async () => (await listKeys(s.client, keys[0])).length === 0);
  assert.deepEqual(await listKeys(s.client, keys[1]), []);
  assert.deepEqual(await listKeys(s.client, keys[2]), [keys[2]]);
  await s.deleteObjects([]);
  await s.deleteObjects([keys[2]]);
  assert.deepEqual(await listKeys(s.client, keys[2]), []);
});

minioTest("getObject refuses an object over maxBytes and rejects a missing key", async () => {
  const s = await setup();
  const key = nextKey();
  await put(await s.presignPut(key, "image/jpeg", 64), crypto.randomBytes(64));
  assert.equal((await s.getObject(key, { maxBytes: 64 })).length, 64);
  await assert.rejects(s.getObject(key, { maxBytes: 63 }), /larger/);
  await assert.rejects(s.getObject(`sessions/${TOKEN}/missing.jpg`));
});
