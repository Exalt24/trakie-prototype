# Trakie Prototype

AI-powered dispensary receiving assistant. Captures invoice/label photos from a phone, extracts product data with OpenAI vision, and autofills a 16-field receiving form on desktop.

## Architecture

Three components connected via WebSocket:

- **Chrome Extension** - Opens a new tab with a QR code and a 16-field receiving form
- **Node.js/Express + Socket.IO Server** - WebSocket hub and OpenAI OCR processing
- **Mobile Capture Page** - Served by the server, accessed by scanning the QR code

## How It Works

1. Extension opens a new tab with a QR code and an empty form
2. Phone scans the QR code and loads the mobile capture page
3. Socket.IO room links phone and desktop via a session token
4. Phone captures invoice/label photos (camera or gallery)
5. Images are compressed client-side and sent via WebSocket with ack callbacks
6. Server receives images and stores them in memory
7. Images are sent to OpenAI o4-mini with structured function calling
8. AI extracts 16 product fields with confidence scoring (HIGH / MEDIUM / NEEDS_REVIEW)
9. Results are pushed to desktop — fields autofill with animated typing and confidence colors

## Form Fields

Product Name, Brand, Category, Subcategory, THC %, CBD %, Net Weight, Batch Number, Expiration Date, Package ID/METRC Tag, Wholesale Cost, Retail Price, Ingredients, Allergens, Vendor Name, Quantity Received

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Server | Node.js, Express, Socket.IO 4.x, OpenAI API (o4-mini) |
| Extension | Chrome Manifest V3, vanilla JS |
| Mobile | Vanilla HTML/JS, served by Express |
| Storage | None — session state held in memory (prototype) |

## Setup

### Prerequisites

- Node.js 18+
- Chrome
- OpenAI API key

### Install and Run

```bash
cd server && npm install
cp .env.example .env  # Add your OpenAI API key
npm start
```

### Load the Extension

1. Navigate to `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" and select the `extension/` folder

### Configure SERVER_URL

Edit `extension/tab.js:2` to match your server's IP address.

## Technical Decisions

**Why o4-mini** — Best vision model for structured extraction at the time. Function calling ensures consistent JSON output.

**Why Socket.IO rooms** — Each scan creates a session token. Phone and desktop join the same room. Clean isolation without authentication for a prototype.

**Why base64** — Simplest transport over WebSocket. Production would use presigned S3 URLs.

**Client-side compression** — Images resized to 1200px max before upload to stay under reasonable payload sizes.

## Limitations

- `SERVER_URL` is hardcoded in `extension/tab.js:2` and must match your network
- No persistent storage — data is lost on server restart
- No authentication — relies on session tokens only
- Single server only, no horizontal scaling
