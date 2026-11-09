// LIFESPAN: permanent
// The local Tesseract engine: real OCR on two invoice images with known text, the parser on its own,
// the engine switch, and the server run end to end with the engine on. No model and no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { waitFor, wire } = require("./helpers");
const { extractFromImages, parseInvoiceText, toProducts, shutdown } = require("../local-ocr");
const { selectExtractor } = require("../ocr-select");

const img = (name) => fs.readFileSync(path.join(__dirname, name));
const values = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.value]));

test.after(shutdown);

const PINECREST_TEXT = [
  "Pinecrest Botanicals LLC INVOICE",
  "412 Alder Way, Suite 9 No. INV-20417",
  "Eugene, OR 97401 Date: 10/08/2026",
  "Sold By: Pinecrest Botanicals LLC Ship To: Test Dispensary Demo",
  "Product Product Detail Quantity Price Total",
  "Pinecrest Berry Gummies 10mg B1 (PCB-2204-17) 20 ea/ 1 case 8.50 170.00",
  "Pinecrest Mint Chocolate Bar 100mg B2 (PCB-2231-09) 12 ea/ 1 case 14.00 168.00",
  "Total Due: $338.00",
].join("\n");

test("parser: known text gives the exact fields", () => {
  const p = parseInvoiceText(PINECREST_TEXT);
  assert.equal(p.vendor, "Pinecrest Botanicals LLC");
  assert.equal(p.invoiceNumber, "INV-20417");
  assert.equal(p.date, "10/08/2026");
  assert.equal(p.totalDue, "338.00");
  assert.equal(p.sumTies, true);
  assert.deepEqual(p.rows.map((r) => [r.name, r.batch, r.quantity, r.price, r.total, r.rowTies]), [
    ["Pinecrest Berry Gummies 10mg", "PCB-2204-17", "20 ea / 1 case", "8.50", "170.00", true],
    ["Pinecrest Mint Chocolate Bar 100mg", "PCB-2231-09", "12 ea / 1 case", "14.00", "168.00", true],
  ]);
});

// Generated table: each bad input must turn one specific check red, and the control row stays green.
const GOOD_ROW = "Harbor Citrus Drops 5mg B1 (HLS-3301-02) 30 ea / 1 case 6.00 180.00";
const BAD_INPUTS = [
  ["quantity times price is not the row total", GOOD_ROW.replace("180.00", "181.00"), "Total Due: $181.00", "rowTies"],
  ["rows do not add up to Total Due", GOOD_ROW, "Total Due: $200.00", "sumTies"],
  ["no Total Due line", GOOD_ROW, "", "sumTies"],
];
for (const [name, row, totalLine, check] of BAD_INPUTS) {
  test(`parser: ${name} turns ${check} red`, () => {
    const good = parseInvoiceText(`Sold By: Harbor Leaf\n${GOOD_ROW}\nTotal Due: $180.00`);
    assert.equal(good.rows[0].rowTies, true);
    assert.equal(good.sumTies, true);
    const bad = parseInvoiceText(`Sold By: Harbor Leaf\n${row}\n${totalLine}`);
    const got = check === "rowTies" ? bad.rows[0].rowTies : bad.sumTies;
    assert.equal(got, false);
  });
}

test("parser: text with no table rows yields no rows", () => {
  assert.deepEqual(parseInvoiceText("Sold By: X\nThank you for your business").rows, []);
});

test("confidence: HIGH only when the page is read well and the arithmetic proves the row", () => {
  const level = (text, conf) => toProducts(parseInvoiceText(text, conf))[0].product_name.confidence;
  const ok = `Sold By: Harbor Leaf\n${GOOD_ROW}\nTotal Due: $180.00`;
  assert.equal(level(ok, 90), "HIGH");
  assert.equal(level(ok, 40), "MEDIUM", "a poorly read page is never HIGH");
  assert.equal(level(ok.replace("Total Due: $180.00", "Total Due: $999.00"), 90), "MEDIUM", "rows that do not add up are never HIGH");
});

test("confidence: a row that does not tie is MEDIUM even when the page total happens to add up", () => {
  // 30 x 6.00 is 180.00 and 10 x 12.50 is 125.00; the two misread totals still add up to 305.00.
  const text = [
    "Sold By: Harbor Leaf",
    "Harbor Citrus Drops 5mg B1 (HLS-3301-02) 30 ea / 1 case 6.00 190.00",
    "Harbor Cocoa Squares 50mg B2 (HLS-3318-11) 10 ea / 1 case 12.50 115.00",
    "Total Due: $305.00",
  ].join("\n");
  const parsed = parseInvoiceText(text, 95);
  assert.equal(parsed.sumTies, true);
  assert.deepEqual(parsed.rows.map((r) => r.rowTies), [false, false]);
  assert.deepEqual(toProducts(parsed).map((p) => p.product_name.confidence), ["MEDIUM", "MEDIUM"]);
});

test("fields an invoice cannot give stay empty and flagged, package id follows the label rule", () => {
  const p = toProducts(parseInvoiceText(PINECREST_TEXT, 90))[0];
  for (const f of ["brand", "category", "thc_percent", "ingredients", "allergens", "expiration_date", "retail_price"]) {
    assert.deepEqual(p[f], { value: "", confidence: "NEEDS_REVIEW" }, f);
  }
  assert.deepEqual(p.package_id, { value: "0", confidence: "HIGH" });
  assert.equal(Object.keys(p).length, 16);
});

test("OCR reads the Pinecrest sample invoice image into fields", async () => {
  const { products, ocr } = await extractFromImages([img("invoice-pinecrest.jpg")]);
  assert.deepEqual(products.map((p) => values(p).product_name), [
    "Pinecrest Berry Gummies 10mg",
    "Pinecrest Mint Chocolate Bar 100mg",
  ]);
  assert.deepEqual(products.map((p) => values(p).batch_number), ["PCB-2204-17", "PCB-2231-09"]);
  assert.deepEqual(products.map((p) => values(p).quantity_received), ["20 ea / 1 case", "12 ea / 1 case"]);
  assert.deepEqual(products.map((p) => values(p).wholesale_cost), ["$8.50", "$14.00"]);
  assert.equal(values(products[0]).vendor_name, "Pinecrest Botanicals LLC");
  assert.equal(products.every((p) => p.product_name.confidence === "HIGH"), true);
  assert.equal(ocr.engine, "tesseract.js");
  assert.equal(ocr.pages[0].date, "10/08/2026");
  assert.equal(ocr.pages[0].total_due, "338.00");
  assert.equal(ocr.pages[0].total_ties, true);
  // The bold INV-20417 in the corner is not always read; it must be empty or right, never wrong.
  assert.match(ocr.pages[0].invoice_number, /^(INV-20417)?$/);
});

test("OCR reads a second, differently laid out invoice with three rows", async () => {
  const { products, ocr } = await extractFromImages([img("invoice-harbor.png")]);
  assert.deepEqual(products.map((p) => values(p).product_name), [
    "Harbor Citrus Drops 5mg", "Harbor Cocoa Squares 50mg", "Harbor Lemon Tonic 20mg",
  ]);
  assert.deepEqual(products.map((p) => values(p).batch_number), ["HLS-3301-02", "HLS-3318-11", "HLS-3342-05"]);
  assert.deepEqual(products.map((p) => values(p).wholesale_cost), ["$6.00", "$12.50", "$9.25"]);
  assert.equal(ocr.pages[0].total_due, "379.00");
  assert.equal(ocr.pages[0].total_ties, true);
});

test("two photos in one session give the products of both", async () => {
  const { products } = await extractFromImages([img("invoice-pinecrest.jpg"), img("invoice-harbor.png")]);
  assert.equal(products.length, 5);
});

test("a blank image has no products and says so", async () => {
  // A 1x1 white PNG.
  const blank = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await assert.rejects(extractFromImages([blank]), /No products detected/);
});

test("engine switch: tesseract picks the local engine, anything else is refused", () => {
  assert.equal(selectExtractor({ TRAKIE_OCR_ENGINE: "tesseract" }), extractFromImages);
  assert.throws(() => selectExtractor({ TRAKIE_OCR_ENGINE: "textract" }), /must be "tesseract" or unset/);
  // The real engine is allowed in production; only the fake is a test seam.
  assert.equal(selectExtractor({ TRAKIE_OCR_ENGINE: "tesseract", NODE_ENV: "production" }), extractFromImages);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("end to end: the server with TRAKIE_OCR_ENGINE=tesseract fills the form fields from a phone photo", async () => {
  const { client, ask, createSession, once, closeAll } = wire();
  const port = await freePort();
  const env = { ...process.env, S3_BUCKET: "", S3_ENDPOINT: "", TRAKIE_OCR_ENGINE: "tesseract", OPENAI_API_KEY: "", PORT: String(port) };
  delete env.TRAKIE_FAKE_OCR;
  delete env.NODE_ENV;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    await waitFor(() => /running on port/.test(out), 8000);
    const url = `http://127.0.0.1:${port}`;
    const desktop = await client(url);
    const { token } = await createSession(desktop);
    const phone = await client(url);
    await ask(phone, "join-session", { token, device: "test" });
    const complete = once(desktop, "extraction-complete", 30000);
    await new Promise((resolve) => phone.emit("upload-image", {
      token, image: img("invoice-pinecrest.jpg").toString("base64"), index: 1, total: 1,
    }, resolve));
    const result = await complete;
    assert.deepEqual(result.products.map((p) => p.product_name.value), [
      "Pinecrest Berry Gummies 10mg", "Pinecrest Mint Chocolate Bar 100mg",
    ]);
    assert.equal(result.products[0].batch_number.value, "PCB-2204-17");
  } finally {
    closeAll();
    child.kill();
    await exited;
  }
});
