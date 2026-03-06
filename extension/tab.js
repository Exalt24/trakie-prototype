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

  // Build product list with search
  if (products.length > 1) {
    const search = document.getElementById("productSearch");
    const list = document.getElementById("productList");
    const count = document.getElementById("productCount");

    // Only show search if enough products to need it
    if (products.length > 5) {
      search.classList.remove("hidden");
    }

    buildProductList(products, list);
    list.classList.remove("hidden");
    count.textContent = `${products.length} products`;
    count.classList.remove("hidden");

    search.oninput = () => {
      const q = search.value.toLowerCase();
      buildProductList(products, list, q);
    };
  } else {
    document.getElementById("productSelector").classList.add("hidden");
  }

  // Fill first product with animation
  fillProduct(0);
  updateConfirmButton();
}

function buildProductList(products, list, filter = "") {
  list.innerHTML = "";
  products.forEach((p, i) => {
    const name = p.product_name.value || `Product ${i + 1}`;
    if (filter && !name.toLowerCase().includes(filter)) return;
    const btn = document.createElement("button");
    btn.className = "product-item" + (i === currentProductIndex ? " active" : "");
    btn.dataset.index = i;
    btn.textContent = `${i + 1}. ${truncate(name, 50)}`;
    btn.onclick = () => selectProduct(i);
    list.appendChild(btn);
  });
}

function selectProduct(index) {
  currentProductIndex = index;
  document.querySelectorAll(".product-item").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.index) === index);
  });
  fillProduct(index);
  updateConfirmButton();
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

// --- Validation ---
const PRICE_FIELDS = ["wholesale_cost", "retail_price"];
const REQUIRED_FIELDS = ["product_name", "brand", "category", "vendor_name", "quantity_received"];

function validateFields() {
  let hasIssues = false;

  // Check required fields
  REQUIRED_FIELDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) {
      hasIssues = true;
      el.classList.add("field-needs-review");
      el.classList.add("field-filling");
      setTimeout(() => el.classList.remove("field-filling"), 500);
    }
  });

  // Check price format (should look like a number or $number)
  PRICE_FIELDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.value.trim()) {
      const cleaned = el.value.replace(/[$,\s]/g, "");
      if (cleaned && isNaN(Number(cleaned))) {
        hasIssues = true;
        el.classList.add("field-needs-review");
        el.classList.add("field-filling");
        setTimeout(() => el.classList.remove("field-filling"), 500);
      }
    }
  });

  return hasIssues;
}

// --- Confirm ---
function updateConfirmButton() {
  const btn = document.getElementById("confirmBtn");
  if (!productsData || productsData.length <= 1) return;
  const remaining = productsData.length - 1 - currentProductIndex;
  if (remaining > 0) {
    btn.textContent = `Confirm & Next (${remaining} remaining)`;
  } else {
    btn.textContent = "Confirm Receiving";
  }
}

function confirmReceiving() {
  validateFields();

  const productName = document.getElementById("product_name").value || "Product";
  document.getElementById("successProduct").textContent = productName;

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
