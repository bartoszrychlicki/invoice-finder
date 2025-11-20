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

