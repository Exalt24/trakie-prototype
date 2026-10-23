// LIFESPAN: permanent
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LIMITS,
  objectKey,
  validateSlot,
  validateUploadRequest,
  keyBelongsToSession,
} = require("../uploads");

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const good = { token: TOKEN, index: 0, total: 2, contentType: "image/jpeg", size: 1000 };

test("objectKey gives sessions/<token>/<index>.jpg", () => {
  assert.equal(objectKey(TOKEN, 0), `sessions/${TOKEN}/0.jpg`);
  assert.equal(objectKey(TOKEN, 9), `sessions/${TOKEN}/9.jpg`);
});

test("positive control: the baseline request is accepted", () => {
  assert.equal(validateUploadRequest(good), null);
});

test("accepted edges: every content type, size 1 and the cap, index 0 and total-1, total 1 and 10", () => {
  for (const contentType of LIMITS.contentTypes) {
    assert.equal(validateUploadRequest({ ...good, contentType }), null, contentType);
  }
  assert.equal(validateUploadRequest({ ...good, size: 1 }), null);
  assert.equal(validateUploadRequest({ ...good, size: 10 * 1024 * 1024 }), null);
  assert.equal(validateUploadRequest({ ...good, index: 0, total: 1 }), null);
  assert.equal(validateUploadRequest({ ...good, index: 9, total: 10 }), null);
  assert.equal(validateUploadRequest({ ...good, index: 1, total: 2 }), null);
});

// Each row replaces one field of the good request with a value that must be refused.
const BAD = {
  token: [
    "", TOKEN.slice(1), `${TOKEN}0`, TOKEN.toUpperCase(), `${TOKEN.slice(1)}g`, `${TOKEN}\n`,
    `../${TOKEN.slice(3)}`, `${TOKEN.slice(0, 30)}/x`, ` ${TOKEN.slice(1)}`, null, undefined, 123,
    [TOKEN], { toString: () => TOKEN },
  ],
  index: [-1, 2, 3, 10, 1.5, NaN, Infinity, -Infinity, "0", "1", null, undefined, [0], 1e21],
  total: [0, -1, 11, 100, 2.5, NaN, Infinity, "2", null, undefined, [2]],
  contentType: [
    "", "image/gif", "image/svg+xml", "IMAGE/JPEG", "image/jpeg; charset=utf-8", " image/jpeg",
    "image/jpeg ", "image/jpg", "application/octet-stream", "text/html", "image/", "image", null,
    undefined, 5, ["image/jpeg"],
  ],
  size: [0, -1, 10 * 1024 * 1024 + 1, 1e9, 1.5, NaN, Infinity, "1000", "", null, undefined, [1000]],
};

for (const [field, values] of Object.entries(BAD)) {
  for (const value of values) {
    test(`refuses ${field} = ${JSON.stringify(value) ?? String(value)}`, () => {
      const reason = validateUploadRequest({ ...good, [field]: value });
      assert.equal(typeof reason, "string");
      assert.ok(reason.length > 0);
    });
  }
}

test("refuses a missing field and a non-object request", () => {
  for (const field of Object.keys(good)) {
    const req = { ...good };
    delete req[field];
    assert.equal(typeof validateUploadRequest(req), "string", `missing ${field}`);
  }
  for (const req of [null, undefined, "x", 5, []]) {
    assert.equal(typeof validateUploadRequest(req), "string");
  }
});

test("index must stay below the total of this request", () => {
  assert.equal(typeof validateUploadRequest({ ...good, index: 4, total: 4 }), "string");
  assert.equal(validateUploadRequest({ ...good, index: 3, total: 4 }), null);
  assert.equal(validateSlot({ token: TOKEN, index: 0, total: 1 }), null);
});

test("limits can be passed in and are honoured", () => {
  const small = { maxImages: 2, maxBytes: 10, contentTypes: ["image/png"] };
  assert.equal(validateUploadRequest({ ...good, contentType: "image/png", size: 10 }, small), null);
  assert.equal(typeof validateUploadRequest({ ...good, contentType: "image/png", size: 11 }, small), "string");
  assert.equal(typeof validateUploadRequest({ ...good, contentType: "image/jpeg", size: 5 }, small), "string");
  assert.equal(typeof validateUploadRequest({ ...good, total: 3, index: 0, contentType: "image/png", size: 5 }, small), "string");
});

test("positive control: every key made by objectKey belongs to its own session", () => {
  for (let i = 0; i < LIMITS.maxImages; i++) {
    assert.equal(keyBelongsToSession(objectKey(TOKEN, i), TOKEN), true, `index ${i}`);
  }
});

const own = (rest) => `sessions/${TOKEN}/${rest}`;
const BAD_KEYS = [
  "",
  "sessions",
  "sessions/",
  `sessions/${TOKEN}`,
  `sessions/${TOKEN}/`,
  `../sessions/${TOKEN}/0.jpg`,
  `sessions/../sessions/${TOKEN}/0.jpg`,
  own("../0.jpg"),
  own("../../0.jpg"),
  own("%2e%2e/0.jpg"),
  own("%2E%2E/0.jpg"),
  own("%2e%2e%2f0.jpg"),
  own("..%2f0.jpg"),
  own("..\\0.jpg"),
  `sessions/%2e%2e/${TOKEN}/0.jpg`,
  `sessions/${OTHER}/0.jpg`,
  `sessions/${OTHER}/../${TOKEN}/0.jpg`,
  `sessions/${TOKEN.slice(1)}/0.jpg`,
  `sessions/${TOKEN}0/0.jpg`,
  `sessions/${TOKEN.toUpperCase()}/0.jpg`,
  `sessions//${TOKEN}/0.jpg`,
  `/sessions/${TOKEN}/0.jpg`,
  `Sessions/${TOKEN}/0.jpg`,
  `other/${TOKEN}/0.jpg`,
  `sessions/${TOKEN}/0.jpg/`,
  own("0.jpg/extra"),
  own("0.jpg/"),
  own("extra/0.jpg"),
  own("0/0.jpg"),
  own("0.jpg.jpg"),
  own("0.png"),
  own("0.JPG"),
  own("0.jpeg"),
  own(".jpg"),
  own("a.jpg"),
  own("-1.jpg"),
  own("1.5.jpg"),
  own("01.jpg"),
  own("100.jpg"),
  own("0.jpg\n"),
  own("0.jpg%00"),
  own("0.jpg\0"),
  ` ${own("0.jpg")}`,
  `${own("0.jpg")} `,
  `sessions/${TOKEN}/0.jpg?x=1`,
  `sessions/${TOKEN}/0.jpg#x`,
  `s3://bucket/sessions/${TOKEN}/0.jpg`,
  null,
  undefined,
  0,
  {},
  [own("0.jpg")],
];

BAD_KEYS.forEach((key, i) => {
  test(`refuses key shape ${i}: ${JSON.stringify(key) ?? String(key)}`, () => {
    assert.equal(keyBelongsToSession(key, TOKEN), false);
  });
});

test("refuses another session's valid key, and a bad token", () => {
  assert.equal(keyBelongsToSession(objectKey(OTHER, 0), TOKEN), false);
  assert.equal(keyBelongsToSession(objectKey(TOKEN, 0), OTHER), false);
  for (const token of ["", "x", null, undefined, `${TOKEN}0`, TOKEN.toUpperCase()]) {
    assert.equal(keyBelongsToSession(objectKey(TOKEN, 0), token), false);
  }
});
