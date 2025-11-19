const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Analyzes an attachment (image or PDF) to determine if it's an invoice/receipt
 * and extracts relevant data.
 * 
 * @param {Buffer} fileBuffer - The file content.
 * @param {string} mimeType - The MIME type of the file.
 * @returns {Promise<Object>} - The extraction result.
 */
async function analyzeAttachment(fileBuffer, mimeType) {
    const base64File = fileBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64File}`;

    const prompt = `
    You are an expert accountant assistant. Your task is to strictly filter and analyze documents.
    
    STEP 1: CLASSIFICATION (CRITICAL)
    Analyze the image visually. Is it a valid fiscal document (Invoice, Receipt, Bill, Paragon)?
    
    It is NOT a fiscal document if it is:
    - A company logo or icon (e.g., a small house, envelope, phone icon).
    - A marketing banner or email footer.
    - A random photo or screenshot not related to a transaction.
    - A document without clear financial data (amounts, dates, tax IDs).
    
    If it is NOT a fiscal document, return {"is_invoice": false, "data": null} immediately. DO NOT HALLUCINATE DATA.
    
    STEP 2: EXTRACTION - BUYER vs SELLER
    Only if it IS a valid fiscal document, extract the following fields.
    
    IMPORTANT: Distinguish between BUYER (nabywca/purchaser) and SELLER (sprzedawca/vendor):
    - SELLER is the company/person ISSUING the document (who is selling goods/services)
    - BUYER is the company/person RECEIVING the document (who is purchasing)
    
    SPECIAL RULE FOR RECEIPTS (Paragon):
    - If you see NIP: 9571130261 anywhere on the document, this is the BUYER's NIP (Rychlicki Holding Sp. z o.o.)
    - The SELLER information should be found elsewhere on the receipt (usually at the top)
    
    Extract these fields:
       - number (document number/invoice number)
       - issue_date (date of issue, format: YYYY-MM-DD)
       - total_amount (total amount as number, use dot for decimals)
       - currency (ISO code, e.g., PLN, USD, EUR)
       - seller_name (name of the company/person SELLING)
       - seller_tax_id (NIP/VAT ID of SELLER)
       - buyer_name (name of the company/person BUYING)
       - buyer_tax_id (NIP/VAT ID of BUYER - if you see 9571130261, this is the buyer)
    
    Return ONLY a valid JSON object with this structure:
    {
      "is_invoice": boolean,
      "data": {
         "number": string | null,
         "issue_date": string | null,
         "total_amount": number | null,
         "currency": string | null,
         "seller_name": string | null,
         "seller_tax_id": string | null,
         "buyer_name": string | null,
         "buyer_tax_id": string | null
      }
    }
  `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o", // Or gpt-4-turbo
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: dataUrl,
                            },
                        },
                    ],
                },
            ],
            response_format: { type: "json_object" },
        });

        const content = response.choices[0].message.content;
        return JSON.parse(content);
    } catch (error) {
        console.error("Error analyzing attachment with OpenAI:");
        console.error("  Error message:", error.message);
        console.error("  Error type:", error.constructor.name);
        if (error.response) {
            console.error("  Response status:", error.response.status);
            console.error("  Response data:", error.response.data);
        }
        // Fallback - return a valid structure
        return { is_invoice: false, data: null, error: error.message };
    }
}

module.exports = { analyzeAttachment };

