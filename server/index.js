require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const { extractFromImages } = require("./ocr");

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
    callback({ success: true });
  });

  // Mobile uploads an image
  socket.on("upload-image", async ({ token, image, index, total }, callback) => {
    const session = sessions.get(token);
    if (!session) return;

    // Guards
    if (session.processing) return;
    if (!total || total <= 0 || total > 10) return;
    if (!image) return;

    // Store image buffer
    const buf = Buffer.from(image, "base64");
    session.images.push(buf);
    const sizeMB = (buf.length / 1024 / 1024).toFixed(1);

    // Notify desktop of progress
    io.to(session.desktopId).emit("image-received", {
      index,
      total,
      received: session.images.length,
    });

    if (typeof callback === 'function') callback();

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
        console.log(
          `OCR complete: ${result.products.length} products extracted`
        );

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

        const errPayload = { message: err.message };
        const desktopSocket = io.sockets.sockets.get(session.desktopId);
        if (desktopSocket) desktopSocket.emit("extraction-error", errPayload);

        const mobileSocket = session.mobileId
          ? io.sockets.sockets.get(session.mobileId)
          : null;
        if (mobileSocket) mobileSocket.emit("extraction-error", errPayload);
      }
    }
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
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trakie server running on port ${PORT}`);
});
