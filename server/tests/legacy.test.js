// LIFESPAN: permanent
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { waitFor, wire } = require("./helpers");

// These tests start the real server as a child process with no S3 variable set.
const { client, ask, createSession, once, photo, closeAll } = wire();

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startServer(extra) {
  const env = { ...process.env, S3_BUCKET: "", S3_ENDPOINT: "", TRAKIE_FAKE_OCR: "1" };
  delete env.NODE_ENV;
  Object.assign(env, extra);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = waitFor(() => /running on port/.test(out), 8000).catch(() => false);
  return { child, exited, ready, output: () => out };
}

test("legacy: without S3_BUCKET the base64 path works exactly as before", async () => {
  const port = await freePort();
  const srv = startServer({ PORT: String(port) });
  try {
    assert.equal(await srv.ready, true, srv.output());
    const url = `http://127.0.0.1:${port}`;
    const desktop = await client(url);
    const { token } = await createSession(desktop);
    const phone = await client(url);
    const join = await ask(phone, "join-session", { token, device: "test" });
    assert.deepEqual(join, { success: true, uploads: "socket" });

    const refused = await ask(phone, "request-upload-url", {
      token, index: 0, total: 1, contentType: "image/jpeg", size: 10,
    });
    assert.equal(refused.error, "Direct upload is not configured");
    assert.equal((await ask(phone, "image-uploaded", {
      token, key: `sessions/${token}/0.jpg`, index: 0, total: 1,
    })).error, "Direct upload is not configured");

    const a = photo(700);
    const b = photo(900);
    const progress = [];
    desktop.on("image-received", (p) => progress.push(p));
    const complete = once(desktop, "extraction-complete");
    const phoneDone = once(phone, "extraction-complete");
    const acks = [];
    for (const [i, bytes] of [a, b].entries()) {
      await new Promise((resolve) => phone.emit("upload-image", {
        token, image: bytes.toString("base64"), index: i + 1, total: 2,
      }, () => { acks.push(i); resolve(); }));
    }
    assert.deepEqual(acks, [0, 1]);
    assert.deepEqual((await complete).products, [{ product_name: `fake-${a.length + b.length}` }]);
    assert.deepEqual(await phoneDone, { count: 1 });
    assert.deepEqual(progress.map((p) => p.received), [1, 2]);
  } finally {
    closeAll();
    srv.child.kill();
    await srv.exited;
  }
});

test("TRAKIE_FAKE_OCR is refused when NODE_ENV=production, and starts otherwise", async () => {
  const refused = startServer({ NODE_ENV: "production", PORT: String(await freePort()), OPENAI_API_KEY: "x" });
  // Either it exits (refused) or it starts listening (not refused); never wait on a live server.
  const outcome = await Promise.race([
    refused.exited.then(() => "exited"),
    refused.ready.then((up) => (up ? "listening" : "silent")),
  ]);
  if (outcome === "listening") {
    refused.child.kill();
    await refused.exited;
  }
  assert.equal(outcome, "exited", `the server started with the fake seam in production: ${refused.output()}`);
  assert.match(refused.output(), /TRAKIE_FAKE_OCR is a test seam/);

  const ok = startServer({ NODE_ENV: "test", PORT: String(await freePort()) });
  try {
    assert.equal(await ok.ready, true, ok.output());
  } finally {
    ok.child.kill();
    await ok.exited;
  }
});
