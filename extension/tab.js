// --- Configuration ---
const SERVER_URL = "http://192.168.254.114:3000"; // Change to Render URL for production

// --- State ---
let sessionToken = null;
let productsData = null;
let currentProductIndex = 0;

// --- Field IDs (matches the 16 form fields) ---
const FIELD_IDS = [
  "product_name", "brand", "category", "subcategory",
  "thc_percent", "cbd_percent", "net_weight", "batch_number",
  "expiration_date", "package_id", "wholesale_cost", "retail_price",
  "ingredients", "allergens", "vendor_name", "quantity_received",
];

// --- Socket.IO Connection ---
const socket = io(SERVER_URL);

socket.on("connect", () => {
  console.log("Connected to server");
  socket.emit("create-session", (res) => {
    sessionToken = res.token;
    generateQR(sessionToken);
  });
});

socket.on("connect_error", () => {
  setStatus("Server unavailable", "error");
});

let phoneInfoStr = "";

socket.on("phone-connected", (data) => {
  if (data && data.device) {
    phoneInfoStr = data.device;
    document.getElementById("phoneInfo").textContent = data.device;
  }
  // If results already showing, don't reset left panel back to connected state
  if (productsData) {
    setStatus("Phone Connected", "connected");
    return;
  }
  setStatus("Phone Connected", "connected");
  document.getElementById("qrSection").classList.add("hidden");
  document.getElementById("connectedSection").classList.remove("hidden");
  document.getElementById("doneLeftSection").classList.add("hidden");
});

socket.on("phone-disconnected", () => {
  // Only show disconnected if we haven't already extracted data
  if (!productsData) {
    setStatus("Phone Disconnected", "error");
  }
});

socket.on("image-received", ({ index, total, received }) => {
  document.getElementById("imageProgress").textContent =
    `Received image ${received} of ${total}`;
});

socket.on("processing-started", () => {
  setStatus("AI Extracting Data...", "processing");
  document.getElementById("imageProgress").innerHTML =
    `<div style="margin-top:16px;width:200px">
      <div style="background:#1e293b;border-radius:8px;height:6px;overflow:hidden">
        <div style="background:#38bdf8;height:100%;border-radius:8px;animation:progressPulse 2s ease-in-out infinite"></div>
      </div>
      <p style="margin-top:10px;font-size:13px;color:#94a3b8">Waiting for AI extraction...</p>
    </div>`;
});

socket.on("extraction-complete", (data) => {
  setStatus("Extraction Complete", "done");
  productsData = data.products;

  // Update left panel to done state
  document.getElementById("connectedSection").classList.add("hidden");
  document.getElementById("doneLeftSection").classList.remove("hidden");
  document.getElementById("extractionSummary").textContent =
    `${data.products.length} product(s) ready for review`;
  if (phoneInfoStr) {
    document.getElementById("phoneInfoDone").textContent = phoneInfoStr;
  }

  showForm(data.products);
});

socket.on("extraction-error", ({ message }) => {
  setStatus("Extraction Failed: " + message, "error");
  document.getElementById("imageProgress").textContent =
    "Error - ask phone to retry";
});

// --- QR Code ---
function generateQR(token) {
  const url = `${SERVER_URL}/m?s=${token}`;
  const container = document.getElementById("qrCode");
  const qrSize = window.innerWidth < 1100 ? 200 : 250;
  new QRCode(container, {
    text: url,
    width: qrSize,
    height: qrSize,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
}

// --- Status Badge ---
function setStatus(text, type) {
  const badge = document.getElementById("statusBadge");
  badge.textContent = text;
  badge.className = `status-badge status-${type}`;
}

// --- Form Population ---
function showForm(products) {
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("formSection").classList.remove("hidden");

  // Build product tabs
  if (products.length > 1) {
    const selector = document.getElementById("productSelector");
    // Keep the label, remove old tabs
    while (selector.children.length > 1) selector.removeChild(selector.lastChild);

    products.forEach((p, i) => {
      const tab = document.createElement("button");
      tab.className = "product-tab" + (i === 0 ? " active" : "");
      tab.textContent = truncate(p.product_name.value, 30) || `Product ${i + 1}`;
      tab.onclick = () => selectProduct(i);
      selector.appendChild(tab);
    });
  } else {
    document.getElementById("productSelector").classList.add("hidden");
  }

  // Fill first product with animation
  fillProduct(0);
}

function selectProduct(index) {
  currentProductIndex = index;
  // Update tab styling
  document.querySelectorAll(".product-tab").forEach((tab, i) => {
    tab.classList.toggle("active", i === index);
  });
  fillProduct(index);
}

function fillProduct(index) {
  const product = productsData[index];
  let delay = 0;

  FIELD_IDS.forEach((fieldId) => {
    const fieldData = product[fieldId];
    if (!fieldData) return;

    setTimeout(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;

      // Set value
      if (el.tagName === "SELECT") {
        // Try to match option
        const opt = Array.from(el.options).find(
          (o) => o.value.toLowerCase() === (fieldData.value || "").toLowerCase()
        );
        el.value = opt ? opt.value : "";
      } else {
        el.value = fieldData.value || "";
      }

      // Confidence styling
      const conf = fieldData.confidence;
      el.className = "";
      if (conf === "HIGH") el.classList.add("field-high");
      else if (conf === "MEDIUM") el.classList.add("field-medium");
      else el.classList.add("field-needs-review");

      // Badge
      const badge = document.getElementById(`badge_${fieldId}`);
      if (badge) {
        badge.classList.remove("hidden", "badge-high", "badge-medium", "badge-needs-review");
        if (conf === "NEEDS_REVIEW") {
          badge.textContent = "NEEDS REVIEW";
          badge.classList.add("badge-needs-review");
        } else if (conf === "MEDIUM") {
          badge.textContent = "MEDIUM";
          badge.classList.add("badge-medium");
        } else {
          badge.textContent = "";
          badge.classList.add("hidden");
        }
      }

      // Flash animation
      el.classList.add("field-filling");
      setTimeout(() => el.classList.remove("field-filling"), 500);
    }, delay);
    delay += 80;
  });
}

// --- Confirm ---
function confirmReceiving() {
  const productName = document.getElementById("product_name").value || "Product";
  document.getElementById("successProduct").textContent = productName;

  // Update button text based on remaining products
  const resetBtn = document.querySelector("#successOverlay .btn-confirm");
  if (productsData && currentProductIndex < productsData.length - 1) {
    const next = currentProductIndex + 2;
    const total = productsData.length;
    resetBtn.textContent = `Next Product (${next} of ${total})`;
  } else {
    resetBtn.textContent = "Start New Scan";
  }

  document.getElementById("successOverlay").classList.remove("hidden");
}

function resetFlow() {
  document.getElementById("successOverlay").classList.add("hidden");

  if (productsData && currentProductIndex < productsData.length - 1) {
    selectProduct(currentProductIndex + 1);
  } else {
    location.reload();
  }
}

// --- Helpers ---
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.substring(0, n) + "..." : str;
}
