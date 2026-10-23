// Picks the extraction function. The fake is a test seam so end-to-end tests do not need a model.

// An image that starts with this marker makes the fake fail, to exercise the error path.
const FAIL_MARKER = "FAKE-OCR-FAIL";

function fakeExtract(imageBuffers) {
  if (imageBuffers.some((b) => b.subarray(0, FAIL_MARKER.length).toString() === FAIL_MARKER)) {
    return Promise.reject(new Error("fake OCR failure"));
  }
  const bytes = imageBuffers.reduce((n, b) => n + b.length, 0);
  return Promise.resolve({ products: [{ product_name: `fake-${bytes}` }] });
}

function selectExtractor(env = process.env) {
  if (env.TRAKIE_FAKE_OCR === "1") {
    if (env.NODE_ENV === "production") {
      throw new Error("TRAKIE_FAKE_OCR is a test seam and is refused when NODE_ENV=production");
    }
    return fakeExtract;
  }
  return require("./ocr").extractFromImages;
}

module.exports = { selectExtractor, fakeExtract, FAIL_MARKER };
