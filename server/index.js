require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const { selectExtractor } = require("./ocr-select");
const { createStorage, DEFAULT_EXPIRES_IN } = require("./storage");
const {
  LIMITS,
  objectKey,
  validateSlot,
  validateUploadRequest,
  keyBelongsToSession,
} = require("./uploads");

const extractFromImages = selectExtractor(process.env);
// null unless S3_BUCKET is set; then phones upload straight to the bucket.
const storage = createStorage(process.env);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB for image uploads
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve mobile page
app.use("/m", express.static(require("path").join(__dirname, "public/mobile")));

// Session storage
const sessions = new Map();

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size });
});

// Delete the objects a session handed out. Never throws: a failed delete must not hide the result.
async function releaseObjects(session) {
  const keys = [...session.presigned];
  session.presigned.clear();
  session.received.clear();
  if (!storage || keys.length === 0) return;
  try {
    await storage.deleteObjects(keys);
  } catch (err) {
    console.error("Object cleanup failed:", err.message);
  }
}

// One path for both upload routes: store the image, report progress, run OCR when all have arrived.
async function receiveImage(session, token, buf, index, total, ack) {
  if (session.processing) return;
  session.images.push(buf);
  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);

  // Notify desktop of progress
  io.to(session.desktopId).emit("image-received", {
    index,
    total,
    received: session.images.length,
  });

  if (typeof ack === "function") ack();

  console.log(
    `Image ${session.images.length}/${total} received (${sizeMB}MB) for session ${token.slice(0, 8)}...`
  );

  // When all images received, run OCR
  if (session.images.length >= total) {
    session.processing = true;
    io.to(session.desktopId).emit("processing-started");
    if (session.mobileId) {
      io.to(session.mobileId).emit("processing-started");
    }

    try {
      console.log(`Running OCR on ${session.images.length} images...`);
      const result = await extractFromImages(session.images);
      console.log(`OCR complete: ${result.products.length} products extracted`);
      await releaseObjects(session);

      // Send to desktop (may have disconnected during OCR)
      const desktopSocket = io.sockets.sockets.get(session.desktopId);
      if (desktopSocket) {
        desktopSocket.emit("extraction-complete", result);
      } else {
        console.log("Desktop disconnected during OCR - results lost");
      }

      // Send count to mobile
      const mobileSocket = session.mobileId
        ? io.sockets.sockets.get(session.mobileId)
        : null;
      if (mobileSocket) {
        mobileSocket.emit("extraction-complete", {
          count: result.products.length,
        });
      }

      // Free memory
      session.images = [];
    } catch (err) {
      console.error("OCR error:", err.message);
      session.processing = false;
      session.images = []; // Free memory even on error
      await releaseObjects(session);

      const errPayload = { message: err.message };
      const desktopSocket = io.sockets.sockets.get(session.desktopId);
      if (desktopSocket) desktopSocket.emit("extraction-error", errPayload);

      const mobileSocket = session.mobileId
        ? io.sockets.sockets.get(session.mobileId)
        : null;
      if (mobileSocket) mobileSocket.emit("extraction-error", errPayload);
    }
  }
}

// Socket.IO
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Desktop creates a session
  socket.on("create-session", (callback) => {
    const token = crypto.randomBytes(16).toString("hex");
    sessions.set(token, {
      desktopId: socket.id,
      mobileId: null,
      images: [],
      presigned: new Set(), // object keys handed out, deleted when the session ends
      received: new Set(), // object keys already counted
      processing: false,
      createdAt: Date.now(),
    });
    socket.join(token);
    console.log(`Session created: ${token}`);
    callback({ token });
  });

  // Mobile joins a session
  socket.on("join-session", ({ token, device }, callback) => {
    const session = sessions.get(token);
    if (!session) {
      callback({ error: "Session not found" });
      return;
    }

    // Prevent double-scan: reject if another phone is already connected
    if (session.mobileId && io.sockets.sockets.get(session.mobileId)) {
      callback({ error: "Session already paired" });
      return;
    }

    session.mobileId = socket.id;
    socket.join(token);

    // Notify desktop with phone info
    io.to(session.desktopId).emit("phone-connected", { device: device || "" });
    console.log(
      `Phone paired to session: ${token}${device ? ` (${device})` : ""}`
    );
    callback({ success: true, uploads: storage ? "s3" : "socket" });
  });

  // Mobile uploads an image as base64 through the socket (used when S3 is not configured)
  socket.on("upload-image", async ({ token, image, index, total }, callback) => {
    const session = sessions.get(token);
    if (!session) return;

    // Guards
    if (!total || total <= 0 || total > 10) return;
    if (!image) return;

    await receiveImage(session, token, Buffer.from(image, "base64"), index, total, callback);
  });

  // Mobile asks for a presigned URL, then PUTs the photo straight to the bucket
  socket.on("request-upload-url", async (req, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const session = sessions.get(req && req.token);
    if (!session) return reply({ error: "Session not found" });
    if (session.mobileId !== socket.id) return reply({ error: "Not paired to this session" });
    if (!storage) return reply({ error: "Direct upload is not configured" });
    if (session.processing) return reply({ error: "Session is already processing" });
    const invalid = validateUploadRequest(req, LIMITS);
    if (invalid) return reply({ error: invalid });

    const key = objectKey(req.token, req.index);
    try {
      const url = await storage.presignPut(key, req.contentType, req.size);
      session.presigned.add(key);
      reply({ url, key, expiresIn: DEFAULT_EXPIRES_IN });
    } catch (err) {
      console.error("Presign error:", err.message);
      reply({ error: "Could not create an upload URL" });
    }
  });

  // Mobile says a PUT finished: fetch the object and join the same path as upload-image
  socket.on("image-uploaded", async (msg, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const { token, key, index, total } = msg || {};
    const session = sessions.get(token);
    if (!session) return reply({ error: "Session not found" });
    if (session.mobileId !== socket.id) return reply({ error: "Not paired to this session" });
    if (!storage) return reply({ error: "Direct upload is not configured" });
    const invalid = validateSlot({ token, index, total }, LIMITS);
    if (invalid) return reply({ error: invalid });
    if (!keyBelongsToSession(key, token)) return reply({ error: "Invalid key" });
    if (session.processing) return reply({ error: "Session is already processing" });
    if (session.received.has(key)) return reply({ error: "Image already received" });

    session.received.add(key);
    let buf;
    try {
      buf = await storage.getObject(key, { maxBytes: LIMITS.maxBytes });
    } catch (err) {
      session.received.delete(key);
      console.error("Fetch error:", err.message);
      return reply({ error: "Uploaded image not found" });
    }
    await receiveImage(session, token, buf, index, total, () => reply({ success: true }));
  });

  socket.on("disconnect", () => {
    for (const [token, session] of sessions) {
      if (session.desktopId === socket.id) {
        // Desktop left - notify mobile, but keep session if processing
        if (session.mobileId) {
          io.to(session.mobileId).emit("desktop-disconnected");
        }
        if (!session.processing) {
          sessions.delete(token);
          releaseObjects(session);
        }
      } else if (session.mobileId === socket.id) {
        // Mobile left - notify desktop
        io.to(session.desktopId).emit("phone-disconnected");
        session.mobileId = null;
      }
    }
  });
});

// Clean old sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(token);
      releaseObjects(session);
    }
  }
}, 5 * 60 * 1000).unref(); // a timer must not keep a test process alive

// Listen only when run directly, so tests can require this file and listen on their own port.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Trakie server running on port ${PORT}`);
  });
}

module.exports = { app, server, io, sessions, storage };
