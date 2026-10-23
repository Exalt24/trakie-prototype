const test = require("node:test");
const assert = require("node:assert/strict");
const { s3Env, minioTest, ensureBucket, listKeys, waitFor, wire } = require("./helpers");
const { FAIL_MARKER } = require("../ocr-select");

const { client, ask, createSession, once, photo, closeAll } = wire();

// The server reads its configuration when it loads, so set it first.
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

async function pair(url) {
  const desktop = await client(url);
  const { token } = await createSession(desktop);
  const phone = await client(url);
  const join = await ask(phone, "join-session", { token, device: "test" });
  return { desktop, phone, token, join };
}

// request-upload-url, PUT, image-uploaded: what the phone page does for one image.
async function sendPhoto(phone, token, index, total, bytes) {
  const asked = await ask(phone, "request-upload-url", {
    token, index, total, contentType: "image/jpeg", size: bytes.length,
  });
  assert.ok(asked.url, JSON.stringify(asked));
  const res = await fetch(asked.url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: bytes });
  assert.equal(res.status, 200);
  const reported = await ask(phone, "image-uploaded", { token, key: asked.key, index, total });
  return { asked, reported };
}

const keysOf = (token) => listKeys(trakie.storage.client, `sessions/${token}/`);
const objectsGone = (token) => waitFor(async () => (await keysOf(token)).length === 0);

minioTest("join reports s3 and two photos go phone to store to desktop, then the objects are deleted", async () => {
  const { desktop, phone, token, join } = await pair(await boot());
  assert.equal(join.success, true);
  assert.equal(join.uploads, "s3");

  const progress = [];
  desktop.on("image-received", (p) => progress.push(p));
  const complete = once(desktop, "extraction-complete");
  const phoneDone = once(phone, "extraction-complete");

  const a = photo(1000);
  const b = photo(2500);
  const first = await sendPhoto(phone, token, 0, 2, a);
  assert.equal(first.asked.key, `sessions/${token}/0.jpg`);
  assert.equal(first.asked.expiresIn, 300);
  assert.match(first.asked.url, /X-Amz-Expires=300/);
  assert.deepEqual(first.reported, { success: true });
  assert.deepEqual(await keysOf(token), [`sessions/${token}/0.jpg`], "the object is in the store before OCR");
  await sendPhoto(phone, token, 1, 2, b);

  const result = await complete;
  assert.deepEqual(result, { products: [{ product_name: `fake-${a.length + b.length}` }] });
  assert.deepEqual(await phoneDone, { count: 1 });
  assert.deepEqual(progress.map((p) => p.received), [1, 2]);
  assert.deepEqual(await keysOf(token), [], "objects are gone once the result is out");

  // a finished session takes nothing more
  const more = { token, index: 0, total: 2, contentType: "image/jpeg", size: 10 };
  assert.equal((await ask(phone, "request-upload-url", more)).error, "Session is already processing");
  const late = await ask(phone, "image-uploaded", { token, key: `sessions/${token}/0.jpg`, index: 0, total: 2 });
  assert.equal(late.error, "Session is already processing");
});

minioTest("a failed OCR also deletes the objects, and the same keys can be used again", async () => {
  const { desktop, phone, token } = await pair(await boot());
  const failed = once(desktop, "extraction-error");
  await sendPhoto(phone, token, 0, 1, photo(300, FAIL_MARKER));
  assert.match((await failed).message, /fake OCR failure/);
  assert.deepEqual(await keysOf(token), []);

  const ok = once(desktop, "extraction-complete");
  const again = photo(400);
  await sendPhoto(phone, token, 0, 1, again);
  assert.equal((await ok).products[0].product_name, `fake-${again.length}`);
  assert.deepEqual(await keysOf(token), []);
});

minioTest("a key from another session, or a bent key, never reaches the store", async () => {
  const url = await boot();
  const a = await pair(url);
  const b = await pair(url);
  const aKey = (await ask(a.phone, "request-upload-url", {
    token: a.token, index: 0, total: 2, contentType: "image/jpeg", size: 50,
  })).key;
  const put = await fetch((await ask(a.phone, "request-upload-url", {
    token: a.token, index: 0, total: 2, contentType: "image/jpeg", size: 50,
  })).url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo(50) });
  assert.equal(put.status, 200);

  const real = trakie.storage.getObject;
  let fetched = [];
  trakie.storage.getObject = (key, opts) => {
    fetched.push(key);
    return real(key, opts);
  };
  try {
    const bad = [
      aKey,
      `sessions/${b.token}/../${a.token}/0.jpg`,
      `sessions/${b.token}/%2e%2e/${a.token}/0.jpg`,
      `sessions/${b.token}/0.jpg/extra`,
      `sessions/${b.token}/extra/0.jpg`,
      `../sessions/${a.token}/0.jpg`,
      "",
      null,
    ];
    for (const key of bad) {
      const res = await ask(b.phone, "image-uploaded", { token: b.token, key, index: 0, total: 2 });
      assert.equal(res.error, "Invalid key", String(key));
    }
    assert.deepEqual(fetched, [], "the store was never asked");

    // positive control: the phone's own key is fetched
    const own = await sendPhoto(b.phone, b.token, 0, 2, photo(60));
    assert.deepEqual(own.reported, { success: true });
    assert.deepEqual(fetched, [`sessions/${b.token}/0.jpg`]);
  } finally {
    trakie.storage.getObject = real;
  }
  assert.equal(a.desktop.connected && b.desktop.connected, true);
});

minioTest("request-upload-url refuses what validateUploadRequest refuses, an unpaired socket and an unknown session", async () => {
  const url = await boot();
  const { desktop, phone, token } = await pair(url);
  const good = { token, index: 0, total: 2, contentType: "image/jpeg", size: 100 };
  assert.ok((await ask(phone, "request-upload-url", good)).url, "positive control");

  const bad = [
    { ...good, size: 10 * 1024 * 1024 + 1 },
    { ...good, size: 0 },
    { ...good, contentType: "image/gif" },
    { ...good, index: 2 },
    { ...good, total: 11 },
    { ...good, token: "x" },
    { ...good, token: "f".repeat(32) },
  ];
  for (const req of bad) {
    const res = await ask(phone, "request-upload-url", req);
    assert.ok(res.error && !res.url, JSON.stringify(req));
  }
  assert.equal((await ask(phone, "request-upload-url", null)).error, "Session not found");
  assert.equal((await ask(desktop, "request-upload-url", good)).error, "Not paired to this session");
  const stranger = await client(url);
  assert.equal((await ask(stranger, "request-upload-url", good)).error, "Not paired to this session");
});

minioTest("the URL from the server refuses a body larger than requested", async () => {
  const { phone, token } = await pair(await boot());
  const asked = await ask(phone, "request-upload-url", {
    token, index: 0, total: 1, contentType: "image/jpeg", size: 10,
  });
  const big = await fetch(asked.url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo(11) });
  assert.ok(big.status === 403 || big.status === 400, `got ${big.status}`);
  assert.deepEqual(await keysOf(token), []);
});

minioTest("reporting an object that is not there fails cleanly, then works once it is uploaded; a repeat is refused", async () => {
  const { phone, token } = await pair(await boot());
  const asked = await ask(phone, "request-upload-url", {
    token, index: 0, total: 2, contentType: "image/jpeg", size: 40,
  });
  const report = { token, key: asked.key, index: 0, total: 2 };
  assert.equal((await ask(phone, "image-uploaded", report)).error, "Uploaded image not found");
  await fetch(asked.url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo(40) });
  assert.deepEqual(await ask(phone, "image-uploaded", report), { success: true });
  assert.equal((await ask(phone, "image-uploaded", report)).error, "Image already received");
});

minioTest("when the desktop leaves, the session's objects are deleted", async () => {
  const { desktop, phone, token } = await pair(await boot());
  await fetch((await ask(phone, "request-upload-url", {
    token, index: 0, total: 2, contentType: "image/jpeg", size: 30,
  })).url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo(30) });
  assert.equal((await keysOf(token)).length, 1);
  desktop.disconnect();
  await objectsGone(token);
});

test.after(() => {
  closeAll();
  trakie.io.close();
  trakie.storage.client.destroy();
});
