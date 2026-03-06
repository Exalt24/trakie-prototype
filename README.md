# Trakie Prototype

Prototype of the core Trakie flow. A dispensary worker scans a QR code on their desktop, captures invoice and label photos on their phone, and the receiving form fills itself. Built for the vault room at 9am with three deliveries waiting.

## Architecture

Three components connected via WebSocket:

- **Chrome Extension** - Opens a new tab with a QR code and a 16-field receiving form
- **Node.js/Express + Socket.IO Server** - WebSocket hub and OpenAI vision processing
- **Mobile Capture Page** - Served by the server, accessed by scanning the QR code

```
Phone (camera) --> Socket.IO --> Server (o4-mini) --> Socket.IO --> Extension (form autofill)
```

## How It Works

1. Extension opens a new tab with a QR code and an empty form
2. Phone scans the QR code and loads the mobile capture page
3. Socket.IO room links phone and desktop via a unique session token
4. Phone captures invoice/label photos (camera or gallery)
5. Images compressed client-side and sent via WebSocket with ack callbacks
6. Server receives images, stores in memory
7. Images sent to OpenAI o4-mini with structured function calling
8. AI extracts all products from the invoice, matches labels by batch number, scores each field's confidence (HIGH / MEDIUM / NEEDS_REVIEW)
9. Results pushed to desktop, fields autofill with animation and confidence colors

## Form Fields (16)

| Section | Fields |
|---------|--------|
| Product Identity | Product Name, Brand, Category, Subcategory |
| Compliance | THC %, CBD %, Net Weight, Batch Number, Expiration Date, Package ID/METRC Tag |
| Pricing | Wholesale Cost, Retail Price |
| Product Details | Ingredients, Allergens |
| Receiving | Vendor Name, Quantity Received |

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Server | Node.js, Express, Socket.IO 4.x, OpenAI API (o4-mini) |
| Extension | Chrome Manifest V3, vanilla JS |
| Mobile | Vanilla HTML/JS, served by Express |
| Storage | None - session state in memory (prototype) |

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

Edit `extension/tab.js:2` to match your server's IP address. For local development that's your machine's LAN IP (e.g., `http://192.168.x.x:3000`), since the phone needs to reach the server over the same network.

## Technical Decisions

**o4-mini over a separate OCR service** - I originally considered piping Google Cloud Vision or Textract into an LLM for structuring. But o4-mini with function calling handles both reading and structuring in one pass. Tested a few vision models on the provided images and this was the most accurate on dense, rotated label text. Simpler pipeline, fewer failure points.

**Socket.IO rooms for pairing** - Each QR scan creates a session token. Phone and desktop join the same room. Same pattern as WhatsApp Web. Clean isolation without authentication for a prototype.

**Structured function calling** - The AI returns typed JSON with all 16 fields and confidence levels through OpenAI's function calling. No regex parsing, no post-processing of raw text.

**Client-side compression** - Images resized to 1200px max before upload so we're not pushing full-resolution photos over the WebSocket. Production would use presigned S3 URLs instead of base64.

**Multi-product extraction** - The AI extracts all line items from an invoice and matches label photos to the corresponding product by batch number. Products without a matching label get invoice fields filled and compliance fields flagged for manual entry.

## Limitations

- `SERVER_URL` hardcoded in `extension/tab.js:2` - must match your network
- No persistent storage - data lost on server restart
- No authentication - session tokens only
- No field validation - prototype scope
- Single server, no horizontal scaling
