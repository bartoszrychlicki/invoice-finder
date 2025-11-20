const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Analyzes an image attachment using OpenAI GPT-4o to extract invoice data.
 * @param {Buffer} imageBuffer - The image buffer.
 * @param {string} mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png').
 * @returns {Promise<Object>} - The extracted data or null if failed.
 */
async function analyzeAttachment(imageBuffer, mimeType) {
    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `
    Analyze this image. Is it a fiscal document (invoice, receipt, bill)?
    
    STRICT RULES:
    - If it is a logo, icon, marketing banner, email footer, random photo, or screenshot without financial data -> Return {"is_invoice": false, "data": null}
    - If it is a valid fiscal document -> Return {"is_invoice": true, "data": {...}}
    
    EXTRACT THESE FIELDS:
    - number: Document number (e.g. "F/2023/01").
    - issue_date: Date of issue (YYYY-MM-DD).
    - total_amount: Total gross amount (float).
    - currency: Currency code (e.g. PLN, EUR).
    - seller_name: Name of the seller/vendor.
    - seller_tax_id: Tax ID (NIP) of the seller.
    - buyer_name: Name of the buyer.
    - buyer_tax_id: Tax ID (NIP) of the buyer.
    - items: A comma-separated string of the main product/service names listed on the invoice (e.g. "Hosting Service, Domain Renewal").

    SPECIAL RULE FOR BUYER:
    - If you see NIP "9571130261", that is the BUYER (Rychlicki Holding Sp. z o.o.).
    - Do NOT confuse buyer and seller.
    
    Return ONLY raw JSON. No markdown formatting.
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
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
        console.error("Error analyzing attachment with OpenAI:", error);
        if (error.response) {
            console.error("  Error type:", error.response.data.error.type);
            console.error("  Error message:", error.response.data.error.message);
        }
        return null;
    }
}

/**
 * Generates a creative cost justification for an invoice based on business context.
 * @param {Object} invoiceData - The extracted invoice data (seller, items, amount).
 * @param {string} businessContext - Description of the user's business.
 * @returns {Promise<string>} - The generated justification or "Brak uzasadnienia".
 */
async function generateJustification(invoiceData, businessContext) {
    if (!businessContext) {
        console.warn("No BUSINESS_CONTEXT provided, skipping justification.");
        return "Brak konfiguracji kontekstu biznesowego.";
    }

    const prompt = `
    I am a business owner operating in the following context:
    "${businessContext}"

    I have an invoice with the following details:
    - Seller: ${invoiceData.seller_name}
    - Items: ${invoiceData.items || 'N/A'}
    - Amount: ${invoiceData.total_amount} ${invoiceData.currency}

    ROLE: You are a creative and resourceful accountant.
    TASK: Write a short (1-2 sentences) justification for this cost in Polish. Explain how this purchase potentially supports my business, generates revenue, or is necessary for operations.
    
    GUIDELINES:
    - Be creative but plausible. Find a link between the purchase and my business goals.
    - If the link is obvious (e.g. hosting for a software company), state it clearly.
    - If the link is tenuous (e.g. coffee), explain it as "fuel for meetings" or "office supply".
    - If there is absolutely no way to justify it (e.g. personal vacation), write "Brak uzasadnienia".
    - Return ONLY the text of the justification. No quotes.
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: prompt }
            ],
            max_tokens: 150,
        });

        const justification = response.choices[0].message.content.trim();
        return justification;
    } catch (error) {
        console.error("Error generating justification:", error);
        return "Błąd generowania uzasadnienia.";
    }
}

module.exports = { analyzeAttachment, generateJustification };
