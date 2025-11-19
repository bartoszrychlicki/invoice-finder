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
    You are an expert accountant assistant. Analyze the attached document.
    1. Determine if it is an invoice or a receipt (is_invoice: true/false).
    2. If true, extract the following fields:
       - number (invoice number)
       - issue_date (YYYY-MM-DD)
       - total_amount (number)
       - currency (ISO code)
       - contractor_name
       - contractor_tax_id
       - my_company_name
       - my_company_tax_id
    
    Return ONLY a valid JSON object with this structure:
    {
      "is_invoice": boolean,
      "data": {
         "number": string | null,
         "issue_date": string | null,
         "total_amount": number | null,
         "currency": string | null,
         "contractor_name": string | null,
         "contractor_tax_id": string | null,
         "my_company_name": string | null,
         "my_company_tax_id": string | null
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

