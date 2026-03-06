const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Validate API key at startup
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "your-api-key-here") {
  console.error("ERROR: Set OPENAI_API_KEY in .env file");
  process.exit(1);
}

const EXTRACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "extract_product_data",
      description:
        "Extract cannabis product data from invoice and/or label images for dispensary receiving",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_name: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                brand: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                category: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                subcategory: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                thc_percent: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                cbd_percent: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                net_weight: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                batch_number: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                expiration_date: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                package_id: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                wholesale_cost: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                retail_price: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                ingredients: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                allergens: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                vendor_name: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
                quantity_received: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    confidence: {
                      type: "string",
                      enum: ["HIGH", "MEDIUM", "NEEDS_REVIEW"],
                    },
                  },
                  required: ["value", "confidence"],
                  additionalProperties: false,
                },
              },
              required: [
                "product_name",
                "brand",
                "category",
                "subcategory",
                "thc_percent",
                "cbd_percent",
                "net_weight",
                "batch_number",
                "expiration_date",
                "package_id",
                "wholesale_cost",
                "retail_price",
                "ingredients",
                "allergens",
                "vendor_name",
                "quantity_received",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["products"],
        additionalProperties: false,
      },
    },
  },
];

// UNBIASED prompt - works for ANY cannabis invoice/label, not just specific images
const SYSTEM_PROMPT = `You are a cannabis dispensary inventory receiving assistant. You extract product data from document images (invoices, product labels, COAs) into structured form fields.

TASK: Extract data for ALL products visible across all provided images. Each product needs 16 fields.

CONFIDENCE RULES:
- "HIGH": Field is clearly readable in the image
- "MEDIUM": Field is partially readable, inferred, or derived from context
- "NEEDS_REVIEW": Field cannot be determined from the images at all - set value to ""

FIELD-BY-FIELD INSTRUCTIONS:

1. PRODUCT NAME: Use the full product name as shown on invoice or label, including brand, variant, and flavor.

2. BRAND: The manufacturer or brand name. Often printed prominently on labels. On invoices, may appear in the product name or vendor column.

3. CATEGORY: Infer from product type. Common categories: Flower, Edible, Concentrate, Pre-Roll, Topical, Tincture, Vape, Capsule, Beverage. Set confidence to "MEDIUM" since this is inferred.

4. SUBCATEGORY: More specific type. Examples: Gummy, Chocolate, Brownie, Cartridge, Live Resin, Joint. Set confidence to "MEDIUM" since this is inferred.

5. THC %: Look for lab-tested potency on the label, NOT the marketing dosage in the product name.
   - Labels have a potency section (e.g., "THC: 9.10 MG per serving") - use THAT value
   - Product names often show rounded marketing numbers (e.g., "10mg Gummy") - IGNORE those
   - Include both per-serving and per-pack values if available
   - Format: "[per-serving value] mg per serving ([per-pack value] mg per pack)"

6. CBD %: Same rules as THC. Use lab potency values from the label, not product name.

7. NET WEIGHT / UNIT COUNT: Check the Nutrition Facts panel carefully for ALL of these:
   - "Servings Per Package" (e.g., 10)
   - "Serving Size" INCLUDING the gram weight (e.g., "One Gummy 6g" - the "6g" is critical, don't omit it)
   - Combine into format like: "10 gummies, 6g each (60g total)"
   - Also check for net weight printed elsewhere on the label
   - The gram weight per serving is often printed right after the serving description in small text - look carefully

8. BATCH / LOT NUMBER: Look for "LOT#", "Batch#", or batch codes.
   - On invoices, batch info may be in a "Product Detail" column in formats like "B1 (ABC-123)" - the batch number is the code in parentheses (e.g., "ABC-123"), not the B1/B2 prefix.
   - On labels, look for "LOT#:" followed by a code.

9. EXPIRATION DATE: Look for "EXP", "Expiration Date", "Best By", "Use By" on the label.

10. PACKAGE ID / METRC TAG: The barcode number printed below barcode lines on the label.
    - Extract as continuous digits with NO spaces (e.g., "850063095044")
    - If barcode is unreadable, blurry, or no label is provided: set value to "0" and confidence to "HIGH"
    - This is per Steven's instruction: unreadable barcode = zero, not empty, not flagged

11. WHOLESALE COST PER UNIT: From the invoice "Price" or "Unit Price" column. Include "$" sign.

12. RETAIL PRICE: Rarely on invoices or labels. Set value to "" and confidence to "NEEDS_REVIEW" unless explicitly shown.

13. INGREDIENTS: Extract VERBATIM from the label.
    - Copy exactly as printed - do NOT correct spelling, do NOT add words, do NOT rephrase
    - Preserve original punctuation and comma placement
    - If label has a typo, keep the typo

14. ALLERGENS: Cannabis labels often have MULTIPLE allergen sections scattered across the label. You MUST check ALL of these:
    - "MAJOR ALLERGENS:" section
    - "ALLERGY WARNING:" section
    - "CAUTION:" section mentioning allergens
    - "Contains:" section
    - Facility warnings (e.g., "Made in a facility that processes...")
    Combine ALL allergen info into one field. Example: "Major Allergens: None. Made in a facility that processes milk, peanuts, tree nuts, soy, and gluten."

15. VENDOR NAME: From the invoice header, "Vendor", "Sold By", "From", or company name at top of invoice.

16. QUANTITY RECEIVED: From the invoice Quantity column. Include full text (e.g., "20 ea / 1 case").

MULTI-IMAGE / MULTI-PRODUCT RULES:
- If images include an invoice with multiple line items, extract ALL products
- If a product label is provided, match it to the corresponding invoice line item by product name, batch number, or other identifying info
- Products with a matching label: fill ALL 16 fields from combined invoice + label data
- Products WITHOUT a matching label: fill invoice fields (name, brand, vendor, cost, quantity, batch from invoice) and set label-only fields (THC, CBD, net weight, ingredients, allergens, expiration) to "" with "NEEDS_REVIEW". Set package_id to "0" with "HIGH" confidence.

IMAGE READING TIPS:
- Labels may be rotated 90 or 180 degrees - mentally rotate and read carefully
- Dense small text on labels contains critical compliance data - read thoroughly
- Scan the ENTIRE label surface, not just the obvious front
- Look for Nutrition Facts panels, warning sections, and fine print`;

async function extractFromImages(imageBuffers) {
  if (!imageBuffers || imageBuffers.length === 0) {
    throw new Error("No images provided");
  }

  const imageMessages = imageBuffers.map((buf) => ({
    type: "image_url",
    image_url: {
      url: `data:image/jpeg;base64,${buf.toString("base64")}`,
      detail: "high",
    },
  }));

  let response;
  try {
    response = await openai.chat.completions.create({
      model: "o4-mini",
      messages: [
        {
          role: "developer",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract all product data from these ${imageBuffers.length} dispensary image(s). They may include invoices, product labels, or both. Extract every product you can identify and merge data from multiple sources where products match.`,
            },
            ...imageMessages,
          ],
        },
      ],
      tools: EXTRACTION_TOOLS,
      tool_choice: {
        type: "function",
        function: { name: "extract_product_data" },
      },
      reasoning_effort: "high",
      max_completion_tokens: 8192,
    });
  } catch (err) {
    if (err.status === 429) {
      throw new Error("API rate limited. Please wait a moment and try again.");
    }
    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
      throw new Error("AI processing timed out. Try with fewer or smaller images.");
    }
    throw err;
  }

  // Validate response structure
  const choice = response.choices?.[0];
  if (!choice) {
    throw new Error("Empty response from AI");
  }

  if (choice.finish_reason === "length") {
    console.warn("WARNING: Response was truncated (max_tokens reached)");
  }

  const toolCalls = choice.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    throw new Error(
      "AI did not return structured data. " +
        (choice.message?.content || "No content")
    );
  }

  let result;
  try {
    result = JSON.parse(toolCalls[0].function.arguments);
  } catch (parseErr) {
    throw new Error("AI returned malformed data: " + parseErr.message);
  }

  if (!result.products || !Array.isArray(result.products)) {
    throw new Error("AI response missing products array");
  }

  if (result.products.length === 0) {
    throw new Error(
      "No products detected in images. Try capturing clearer photos."
    );
  }

  // Detailed logging
  console.log("\n========== OCR EXTRACTION RESULTS ==========");
  console.log(`Products extracted: ${result.products.length}`);
  console.log(`Model: ${response.model}`);
  console.log(
    `Tokens: ${response.usage.prompt_tokens} prompt, ${response.usage.completion_tokens} completion`
  );

  result.products.forEach((product, i) => {
    console.log(`\n--- Product ${i + 1}: ${product.product_name.value} ---`);
    for (const [key, val] of Object.entries(product)) {
      const flag =
        val.confidence === "NEEDS_REVIEW"
          ? " [NEEDS REVIEW]"
          : val.confidence === "MEDIUM"
            ? " [MEDIUM]"
            : "";
      const displayVal =
        val.value.length > 100
          ? val.value.substring(0, 100) + "..."
          : val.value;
      console.log(`  ${key}: ${displayVal || "(empty)"}${flag}`);
    }
  });

  console.log("\n========== END RESULTS ==========\n");

  // Post-processing validation
  result.products.forEach((product) => {
    // Package ID: strip spaces, ensure "0" for empty/unreadable
    if (product.package_id) {
      product.package_id.value = product.package_id.value.replace(/\s/g, "");
      if (
        !product.package_id.value ||
        product.package_id.confidence === "NEEDS_REVIEW"
      ) {
        product.package_id.value = "0";
        product.package_id.confidence = "HIGH";
      }
    }

    // Allergens: if just "None"/"NONE" with no facility info, flag for review
    if (
      product.allergens &&
      /^(none|n\/a)$/i.test(product.allergens.value.trim())
    ) {
      product.allergens.confidence = "MEDIUM";
    }

    // Wholesale cost: ensure "$" prefix for consistency
    if (
      product.wholesale_cost &&
      product.wholesale_cost.value &&
      /^\d/.test(product.wholesale_cost.value)
    ) {
      product.wholesale_cost.value = "$" + product.wholesale_cost.value;
    }
  });

  return result;
}

module.exports = { extractFromImages };
