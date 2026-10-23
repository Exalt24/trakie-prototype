// LIFESPAN: permanent
const test = require("node:test");
const { S3Client, CreateBucketCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const ENDPOINT = process.env.TRAKIE_TEST_S3_ENDPOINT || "http://localhost:59000";
const BUCKET = "trakie-test";

// The standard AWS variables, as the server reads them.
function s3Env(extra = {}) {
  return {
    S3_BUCKET: BUCKET,
    S3_ENDPOINT: ENDPOINT,
    AWS_ACCESS_KEY_ID: "minio",
    AWS_SECRET_ACCESS_KEY: "minio12345",
    ...extra,
  };
}

let reachable;
async function minioReachable() {
  if (reachable === undefined) {
    try {
      const res = await fetch(`${ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
  }
  return reachable;
}

// A MinIO test skips with a clear message when the container is down. CI sets
// TRAKIE_REQUIRE_MINIO=1 so a missing container is a failure, never a quiet skip.
function minioTest(name, fn) {
  return test(name, async (t) => {
    if (!(await minioReachable())) {
      const msg = `MinIO not reachable at ${ENDPOINT}. Start it with: docker run -d --name trakie-minio -p 59000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 <a MinIO image> server /data`;
      if (process.env.TRAKIE_REQUIRE_MINIO === "1") throw new Error(msg);
      t.skip(msg);
      return;
    }
    await fn(t);
  });
}

async function ensureBucket(client) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(`${err.name} ${err.Code}`)) throw err;
  }
}

async function listKeys(client, prefix) {
  const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (res.Contents || []).map((o) => o.Key);
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Socket.IO client helpers. Each test file calls wire() so it owns the sockets it opens.
function wire() {
  const crypto = require("node:crypto");
  const { io: connect } = require("socket.io-client");
  const sockets = [];

  function client(url) {
    const s = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(s);
    return new Promise((resolve) => s.on("connect", () => resolve(s)));
  }

  const ask = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
  const createSession = (s) => new Promise((resolve) => s.emit("create-session", resolve));

  function once(s, event, ms = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
      s.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  const photo = (n, prefix = "") => Buffer.concat([Buffer.from(prefix), crypto.randomBytes(n)]);
  const closeAll = () => sockets.forEach((s) => s.disconnect());

  return { client, ask, createSession, once, photo, closeAll };
}

module.exports = { ENDPOINT, BUCKET, s3Env, minioTest, ensureBucket, listKeys, waitFor, wire, S3Client };
