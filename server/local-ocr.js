// A local OCR engine: Tesseract (tesseract.js, English data from @tesseract.js-data/eng) reads the
// invoice photo, then a parser turns the text into the same 16 {value, confidence} fields the vision
// model returns. No network and no API key. Selected with TRAKIE_OCR_ENGINE=tesseract (ocr-select.js).
//
// What it can do: read a printed invoice table (vendor, date, product, batch, quantity, price, total)
// and check that the arithmetic ties. What it cannot do: read a product label (rotated dense text,
// potency, ingredients), so those fields stay empty and flagged NEEDS_REVIEW for the clerk.

const { createWorker } = require("tesseract.js");
const eng = require("@tesseract.js-data/eng");

const FIELDS = [
  "product_name", "brand", "category", "subcategory", "thc_percent", "cbd_percent", "net_weight",
  "batch_number", "expiration_date", "package_id", "wholesale_cost", "retail_price", "ingredients",
  "allergens", "vendor_name", "quantity_received",
];

// Below this mean Tesseract confidence (0 to 100) nothing is marked HIGH.
const MIN_ENGINE_CONFIDENCE = 70;

const ROW = new RegExp(
  "^(?<name>.+?)\\s+(?:B\\d+\\s*)?\\((?<batch>[A-Za-z0-9-]+)\\)\\s+" +
    "(?<qty>\\d+)\\s*(?<unit>[A-Za-z]+)\\s*/\\s*(?<per>\\d+)\\s*(?<pack>[A-Za-z]+)\\s+" +
    "(?<price>\\d+\\.\\d{2})\\s+(?<total>\\d+\\.\\d{2})$",
);

const cents = (s) => Math.round(parseFloat(s) * 100);

// Pure text to fields, so it is tested without an image. `engineConfidence` is Tesseract's mean.
function parseInvoiceText(text, engineConfidence = 100) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vendor = /Sold By:\s*(.+?)(?:\s+Ship To:|$)/i.exec(text)?.[1]?.trim()
    || (lines[0] || "").replace(/\s+INVOICE.*$/i, "").trim();
  const invoiceNumber = /\b(INV-\d+)\b/.exec(text)?.[1] || "";
  const date = /Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text)?.[1] || "";
  const totalDue = /Total Due:\s*\$?\s*([\d,]+\.\d{2})/i.exec(text)?.[1]?.replace(/,/g, "") || "";

  const rows = [];
  for (const line of lines) {
    const m = ROW.exec(line);
    if (!m) continue;
    const g = m.groups;
    rows.push({
      name: g.name.trim(),
      batch: g.batch,
      quantity: `${g.qty} ${g.unit} / ${g.per} ${g.pack}`,
      price: g.price,
      total: g.total,
      rowTies: Number(g.qty) * cents(g.price) === cents(g.total),
    });
  }
  const sumTies = Boolean(totalDue) && rows.length > 0
    && rows.reduce((n, r) => n + cents(r.total), 0) === cents(totalDue);
  return { vendor, invoiceNumber, date, totalDue, rows, sumTies, engineConfidence };
}

function field(value, confidence) {
  return value ? { value, confidence } : { value: "", confidence: "NEEDS_REVIEW" };
}

// HIGH only when the engine was sure of the page AND the numbers prove the row (quantity times price
// is the row total, and the rows add up to Total Due). Otherwise MEDIUM, so the clerk looks.
function toProducts(parsed) {
  const sure = parsed.engineConfidence >= MIN_ENGINE_CONFIDENCE;
  return parsed.rows.map((r) => {
    const proven = sure && r.rowTies && parsed.sumTies;
    const level = proven ? "HIGH" : "MEDIUM";
    const p = {};
    for (const f of FIELDS) p[f] = { value: "", confidence: "NEEDS_REVIEW" };
    p.product_name = field(r.name, level);
    p.batch_number = field(r.batch, level);
    p.wholesale_cost = field(`$${r.price}`, level);
    p.quantity_received = field(r.quantity, level);
    p.vendor_name = field(parsed.vendor, sure ? "MEDIUM" : "NEEDS_REVIEW");
    // Same rule as the vision prompt: no label photo means package id 0, not empty.
    p.package_id = { value: "0", confidence: "HIGH" };
    return p;
  });
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(eng.code, 1, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: "none" });
  }
  return workerPromise;
}

async function shutdown() {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  await w.terminate();
}

async function extractFromImages(imageBuffers) {
  const worker = await getWorker();
  const products = [];
  const pages = [];
  for (const buf of imageBuffers) {
    const { data } = await worker.recognize(buf);
    const parsed = parseInvoiceText(data.text, data.confidence);
    pages.push({
      engine_confidence: Math.round(data.confidence),
      invoice_number: parsed.invoiceNumber,
      date: parsed.date,
      total_due: parsed.totalDue,
      total_ties: parsed.sumTies,
      rows: parsed.rows.length,
    });
    products.push(...toProducts(parsed));
  }
  if (products.length === 0) {
    throw new Error("No products detected in images. Try capturing clearer photos.");
  }
  return { products, ocr: { engine: "tesseract.js", pages } };
}

module.exports = { extractFromImages, parseInvoiceText, toProducts, shutdown, MIN_ENGINE_CONFIDENCE };
