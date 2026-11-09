# LIFESPAN: permanent
# Draws the second OCR fixture (invoice-harbor.png): a plain text invoice with three rows,
# so the parser is not tuned to one layout. Run: python make-invoice-fixture.py
from PIL import Image, ImageDraw, ImageFont

font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 30)
bold = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 38)
img = Image.new("RGB", (1500, 760), "white")
d = ImageDraw.Draw(img)
d.text((60, 50), "Harbor Leaf Supply Co", font=bold, fill="black")
d.text((60, 105), "88 Quay Road, Astoria, OR 97103", font=font, fill="black")
d.text((1000, 50), "Date: 11/02/2026", font=font, fill="black")
d.text((60, 190), "Sold By: Harbor Leaf Supply Co     Ship To: Test Dispensary Demo", font=font, fill="black")
d.text((60, 260), "Product   Product Detail   Quantity   Price   Total", font=bold, fill="black")
rows = [
    "Harbor Citrus Drops 5mg    B1 (HLS-3301-02)    30 ea / 1 case    6.00    180.00",
    "Harbor Cocoa Squares 50mg    B2 (HLS-3318-11)    10 ea / 1 case    12.50    125.00",
    "Harbor Lemon Tonic 20mg    B3 (HLS-3342-05)    8 ea / 1 case    9.25    74.00",
]
for i, r in enumerate(rows):
    d.text((60, 330 + i * 60), r, font=font, fill="black")
d.text((900, 560), "Total Due: $379.00", font=bold, fill="black")
img.save("invoice-harbor.png")
