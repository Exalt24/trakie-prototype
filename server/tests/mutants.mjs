// LIFESPAN: permanent
// Removes one guard at a time in a temp copy of the server and requires `node --test` to fail each time.
// A stale anchor (text that is no longer in the file exactly once) fails the run, so a renamed guard
// cannot leave a mutant that silently does nothing. Needs the MinIO container, see the README.
//
//   node tests/mutants.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MUTANTS = [
  { name: "session prefix check, handler", file: "index.js",
    from: '    if (!keyBelongsToSession(key, token)) return reply({ error: "Invalid key" });\n', to: "" },
  { name: "session prefix check, keyBelongsToSession", file: "uploads.js",
    from: "if (!m || m[1] !== token) return false;", to: "if (!m) return false;" },
  { name: "size cap", file: "uploads.js",
    from: "req.size < 1 || req.size > limits.maxBytes", to: "req.size < 1" },
  { name: "content type allowlist", file: "uploads.js",
    from: 'typeof req.contentType !== "string" || !limits.contentTypes.includes(req.contentType)',
    to: 'typeof req.contentType !== "string"' },
  { name: "index below total", file: "uploads.js", from: "index >= total", to: "index > total" },
  { name: "Content-Type signed header", file: "storage.js",
    from: 'new Set(["content-type", "content-length"])', to: 'new Set(["content-length"])' },
  { name: "Content-Length given to the signer", file: "storage.js",
    from: "        ContentType: contentType,\n        ContentLength: size,\n", to: "        ContentType: contentType,\n" },
  { name: "Content-Type given to the signer", file: "storage.js",
    from: "        ContentType: contentType,\n", to: "" },
  { name: "expiry of 300 seconds", file: "storage.js",
    from: "const DEFAULT_EXPIRES_IN = 300;", to: "const DEFAULT_EXPIRES_IN = 3000;" },
  { name: "read size cap on getObject", file: "storage.js",
    from: "if (maxBytes && res.ContentLength > maxBytes) {", to: "if (false) {" },
  { name: "cleanup after OCR success", file: "index.js",
    from: "      await releaseObjects(session);\n\n      // Send to desktop", to: "\n      // Send to desktop" },
  { name: "cleanup after OCR error", file: "index.js",
    from: "session.images = []; // Free memory even on error\n      await releaseObjects(session);",
    to: "session.images = []; // Free memory even on error" },
  { name: "cleanup when the desktop leaves", file: "index.js",
    from: "          sessions.delete(token);\n          releaseObjects(session);", to: "          sessions.delete(token);" },
  { name: "production refusal of the fake OCR seam", file: "ocr-select.js",
    from: 'if (env.NODE_ENV === "production") {', to: "if (false) {" },
  { name: "join callback upload flag", file: "index.js",
    from: 'uploads: storage ? "s3" : "socket"', to: 'uploads: "socket"' },
  { name: "paired phone check on URL requests", file: "index.js",
    from: '    if (session.mobileId !== socket.id) return reply({ error: "Not paired to this session" });\n    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (session.processing) return reply({ error: "Session is already processing" });\n    const invalid = validateUploadRequest(req, LIMITS);',
    to: '    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (session.processing) return reply({ error: "Session is already processing" });\n    const invalid = validateUploadRequest(req, LIMITS);' },
  { name: "processing guard on URL requests", file: "index.js",
    from: '    if (session.processing) return reply({ error: "Session is already processing" });\n    const invalid = validateUploadRequest',
    to: "    const invalid = validateUploadRequest" },
  { name: "processing guard on uploaded reports", file: "index.js",
    from: '    if (session.processing) return reply({ error: "Session is already processing" });\n    if (session.received.has(key))',
    to: "    if (session.received.has(key))" },
  { name: "repeat report of one key", file: "index.js",
    from: '    if (session.received.has(key)) return reply({ error: "Image already received" });\n', to: "" },
  // Large video uploads in parts: each rule that keeps a short, foreign or oversize video out.
  { name: "video size cap", file: "video-uploads.js",
    from: "req.size < 1 || req.size > limits.maxBytes", to: "req.size < 1" },
  { name: "video content type allowlist", file: "video-uploads.js",
    from: 'typeof req.contentType !== "string" || !Object.hasOwn(limits.contentTypes, req.contentType)',
    to: 'typeof req.contentType !== "string"' },
  { name: "video key session prefix", file: "video-uploads.js",
    from: "if (!m || m[1] !== token) return false;", to: "if (!m) return false;" },
  { name: "video last part is what remains", file: "video-uploads.js",
    from: "return n < plan.count ? plan.partBytes : plan.size - plan.partBytes * (plan.count - 1);",
    to: "return plan.partBytes;" },
  { name: "video resume re-sends a part of the wrong size", file: "video-uploads.js",
    from: "if (!p || p.size !== partSize(plan, n)) missing.push(n);", to: "if (!p) missing.push(n);" },
  { name: "video complete needs every part", file: "video-uploads.js",
    from: "if (list.length !== plan.count) return", to: "if (list.length > plan.count) return" },
  { name: "video complete refuses a duplicate part", file: "video-uploads.js",
    from: "    if (seen.has(p.partNumber)) return `Part ${p.partNumber} is listed twice`;\n", to: "" },
  { name: "video complete needs the store's checksum", file: "video-uploads.js",
    from: "    if (!p.etag) return `Part ${p.partNumber} has no checksum from the store`;\n", to: "" },
  { name: "video complete refuses a part of the wrong size", file: "video-uploads.js",
    from: "    if (p.size !== partSize(plan, p.partNumber)) return `Part ${p.partNumber} is the wrong size`;\n", to: "" },
  { name: "video part length given to the signer", file: "storage.js",
    from: "        PartNumber: partNumber,\n        ContentLength: size,\n", to: "        PartNumber: partNumber,\n" },
  { name: "video one slot one file", file: "index.js",
    from: "      if (v && (v.plan.size !== req.size || v.contentType !== req.contentType)) {", to: "      if (false) {" },
  { name: "video request after it finished", file: "index.js",
    from: '      if (v && v.done) return reply({ error: "Video already received" });\n', to: "" },
  { name: "video parts counted before joining", file: "index.js",
    from: "      const problem = checkComplete(v.plan, listed);", to: "      const problem = null;" },
  { name: "video complete twice", file: "index.js",
    from: '    if (!v) return reply({ error: "No video upload was started for this key" });\n    if (v.done) return reply({ error: "Video already received" });\n',
    to: '    if (!v) return reply({ error: "No video upload was started for this key" });\n' },
  { name: "video key must be this session's", file: "index.js",
    from: '    if (!videoKeyBelongsToSession(key, token)) return reply({ error: "Invalid key" });\n', to: "" },
  { name: "paired phone check on video requests", file: "index.js",
    from: '    if (session.mobileId !== socket.id) return reply({ error: "Not paired to this session" });\n    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (session.processing) return reply({ error: "Session is already processing" });\n    const invalid = validateVideoRequest(req, VIDEO_LIMITS);',
    to: '    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (session.processing) return reply({ error: "Session is already processing" });\n    const invalid = validateVideoRequest(req, VIDEO_LIMITS);' },
  { name: "paired phone check on video completion", file: "index.js",
    from: '    if (session.mobileId !== socket.id) return reply({ error: "Not paired to this session" });\n    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (!videoKeyBelongsToSession(key, token))',
    to: '    if (!storage) return reply({ error: "Direct upload is not configured" });\n    if (!videoKeyBelongsToSession(key, token))' },
  { name: "abort an unfinished video when the session ends", file: "index.js",
    from: "      await storage.abortMultipart(key, v.uploadId);", to: "      void 0;" },
  { name: "delete a finished video when the session ends", file: "index.js",
    from: "      keys.push(key);\n      continue;", to: "      continue;" },
  // Local OCR engine: each check that keeps a wrong read from looking certain. These run only
  // tests/local-ocr.test.js, which needs no container (`node tests/mutants.mjs --suite local-ocr`).
  { name: "OCR row arithmetic check", file: "local-ocr.js", suite: "local-ocr",
    from: "Number(g.qty) * cents(g.price) === cents(g.total)", to: "true" },
  { name: "OCR rows must add up to Total Due", file: "local-ocr.js", suite: "local-ocr",
    from: "=== cents(totalDue);", to: ">= 0;" },
  { name: "OCR engine confidence floor", file: "local-ocr.js", suite: "local-ocr",
    from: "const sure = parsed.engineConfidence >= MIN_ENGINE_CONFIDENCE;", to: "const sure = true;" },
  { name: "OCR HIGH needs the row to tie", file: "local-ocr.js", suite: "local-ocr",
    from: "const proven = sure && r.rowTies && parsed.sumTies;", to: "const proven = sure && parsed.sumTies;" },
  { name: "OCR label-only fields flagged for review", file: "local-ocr.js", suite: "local-ocr",
    from: 'for (const f of FIELDS) p[f] = { value: "", confidence: "NEEDS_REVIEW" };',
    to: 'for (const f of FIELDS) p[f] = { value: "", confidence: "HIGH" };' },
  { name: "OCR empty result is an error", file: "local-ocr.js", suite: "local-ocr",
    from: "if (products.length === 0) {", to: "if (false) {" },
  { name: "OCR every photo is read", file: "local-ocr.js", suite: "local-ocr",
    from: "products.push(...toProducts(parsed));", to: "products.splice(0, products.length, ...toProducts(parsed));" },
  { name: "OCR vendor stops at Ship To", file: "local-ocr.js", suite: "local-ocr",
    from: "Sold By:\\s*(.+?)(?:\\s+Ship To:|$)", to: "Sold By:\\s*(.+)" },
  { name: "OCR unknown engine name refused", file: "ocr-select.js", suite: "local-ocr",
    from: "if (env.TRAKIE_OCR_ENGINE) {", to: "if (false) {" },
];

// `--suite local-ocr` runs only the OCR mutants against only the OCR tests (no MinIO needed).
const suiteArg = process.argv.includes("--suite") ? process.argv[process.argv.indexOf("--suite") + 1] : null;
const TEST_GLOB = suiteArg === "local-ocr" ? "tests/local-ocr.test.js" : "tests/*.test.js";
const ACTIVE = suiteArg ? MUTANTS.filter((m) => m.suite === suiteArg) : MUTANTS;

const read = (f) => fs.readFileSync(path.join(serverDir, f), "utf8").replace(/\r\n/g, "\n");

function runSuite(dir) {
  // The reporter is pinned: Node picks `spec` on a terminal and `tap` otherwise (Node 22), and this file reads the spec marks.
  return spawnSync(process.execPath, ["--test", "--test-reporter=spec", TEST_GLOB], {
    cwd: dir,
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      NODE_PATH: path.join(serverDir, "node_modules"),
      TRAKIE_REQUIRE_MINIO: "1", // a missing container must fail the run, not skip it
    },
  });
}

function copyTo(dir) {
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  for (const f of fs.readdirSync(serverDir)) {
    if (f.endsWith(".js")) fs.writeFileSync(path.join(dir, f), read(f));
  }
  for (const f of fs.readdirSync(path.join(serverDir, "tests"))) {
    fs.copyFileSync(path.join(serverDir, "tests", f), path.join(dir, "tests", f));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trakie-mutants-"));
let failed = false;
try {
  for (const m of ACTIVE) {
    const count = read(m.file).split(m.from).length - 1;
    if (count !== 1) {
      console.error(`STALE ANCHOR: "${m.name}" matches ${count} times in ${m.file}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);

  copyTo(tmp);
  const base = runSuite(tmp);
  if (base.status !== 0) {
    console.error("The unmodified copy does not pass, so no mutant means anything.");
    console.error(`${base.stdout}\n${base.stderr}`.split("\n").filter((l) => /^(✖|ℹ (pass|fail|skipped))/.test(l)).join("\n"));
    process.exit(1);
  }
  const skipped = /ℹ skipped (\d+)/.exec(base.stdout);
  console.log(`baseline: pass, skipped ${skipped ? skipped[1] : "?"}`);

  let caught = 0;
  for (const m of ACTIVE) {
    copyTo(tmp);
    const file = path.join(tmp, m.file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(m.from, () => m.to));
    const res = runSuite(tmp);
    if (res.error) {
      console.error(`INCONCLUSIVE ${m.name}: ${res.error.message}`);
      failed = true;
      continue;
    }
    const names = res.stdout.split("\n").filter((l) => l.startsWith("✖") && !l.includes("failing tests"));
    if (res.status !== 0 && names.length > 0) {
      caught++;
      console.log(`caught   ${m.name}  [${names[0].replace(/^✖\s*/, "").replace(/\s*\(.*$/, "").slice(0, 70)}]`);
    } else {
      failed = true;
      console.error(`SURVIVED ${m.name}`);
    }
  }
  console.log(`mutants: ${caught}/${ACTIVE.length} caught`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
