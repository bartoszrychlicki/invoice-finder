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
async function generateJustification(invoiceData, businessContext, promptInstructions) {
    if (!businessContext) {
        console.warn("No BUSINESS_CONTEXT provided, skipping justification.");
        return "Brak konfiguracji kontekstu biznesowego.";
    }

    const prompt = `
# ROLA:
Jesteś kreatywnym doradcą podatkowym i ekspertem ds. optymalizacji kosztów w firmie o multidyscyplinarnym profilu działalności. Twoim zadaniem jest przygotowanie profesjonalnego uzasadnienia wydatku dla księgowego.

# CEL:
Stworzenie 2-3 zdaniowego uzasadnienia, które wykazuje logiczny związek przyczynowo-skutkowy pomiędzy poniesionym kosztem a uzyskaniem przychodu, zachowaniem lub zabezpieczeniem źródła przychodów. Uzasadnienie musi być defensywne podatkowo, ale kreatywne w łączeniu faktów.

# KONTEKST BIZNESOWY (MOJE FILARY):
${businessContext}

# TWOJE ZADANIE:
Na podstawie danych z faktury oraz moich "Zasad Specjalnych", napisz uzasadnienie.
1. **Znajdź powiązanie:** Jeśli to elektronika -> powołaj się na programowanie/IT. Jeśli to usługa/spotkanie -> powołaj się na konsulting/sprzedaż. Jeśli to hotel/wyjazd -> powołaj się na spotkanie z inwestorem lub klientem w terenie.
2. **Wskaż cel:** Wyjaśnij, jak ten koszt przekłada się na potencjalny przychód.
3. **Styl:** Profesjonalny, biznesowy, konkretny.

# DANE FAKTURY:
* **Przedmiot zakupu:** ${invoiceData.items || 'N/A'}
* **Sprzedawca:** ${invoiceData.seller_name}
* **Kwota:** ${invoiceData.total_amount} ${invoiceData.currency}

# ZESTAW REGUŁ (ZASTOSUJ BEZWZGLĘDNIE):
${promptInstructions || 'Brak dodatkowych reguł.'}

# OCZEKIWANY OUTPUT:
Tylko gotowy tekst uzasadnienia.
**Język: Polski.**
    `;

    console.log("--- FULL JUSTIFICATION PROMPT ---");
    console.log(prompt);
    console.log("---------------------------------");

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

/**
 * Generates Gmail search queries for a missing transaction.
 * @param {Object} transaction - The transaction object { date, amount, counterparty, description }.
 * @returns {Promise<Array<string>>} - Array of search queries.
 */
async function generateSearchQueries(transaction) {
    // Extract counterparty name (remove address/extra info)
    const counterpartyName = (transaction.counterparty || '').split('|')[0].trim();

    // Detect card transactions (Nest Bank)
    const isCardTransaction = counterpartyName.toLowerCase().includes('nest bank');

    let prompt;

    if (isCardTransaction) {
        // For card transactions, focus on description and amount
        prompt = `Generate Gmail search queries to find an invoice email for a CARD TRANSACTION.

Transaction:
- Description: ${transaction.description}
- Amount: ${Math.abs(transaction.amount)} ${transaction.currency}
- Date: ${transaction.date}

IMPORTANT: This is a card transaction. The invoice is likely from the merchant in the description, NOT from "Nest Bank".

Generate 3-5 search queries focusing on:
1. Merchant name from description + "invoice" or "faktura"
2. Merchant name alone
3. Keywords from description (product/service names)
4. Amount if it's a significant purchase

Return JSON with "queries" array.
Example: {"queries": ["CLAUDE.AI invoice", "ANTHROPIC.COM", "Claude subscription"]}`;
    } else {
        // For regular transactions, use counterparty
        prompt = `Generate Gmail search queries to find an invoice email.

Transaction:
- Counterparty: ${counterpartyName}
- Amount: ${Math.abs(transaction.amount)} ${transaction.currency}
- Date: ${transaction.date}
- Description: ${transaction.description}

Generate 3-5 search queries using Gmail operators. Focus on:
1. Counterparty name + "faktura" or "invoice"
2. Counterparty name alone
3. Keywords from description
4. Invoice number if present in description

Return JSON with "queries" array.
Example: {"queries": ["from:Uber subject:invoice", "Uber faktura", "invoice 750"]}`;
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You generate Gmail search queries. Always return valid JSON with a 'queries' array." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" },
        });

        const content = JSON.parse(response.choices[0].message.content);
        const queries = content.queries || content.search_queries || [];

        // Fallback: if LLM returns empty or invalid, generate basic queries
        if (!queries || queries.length === 0) {
            console.log(`  -> LLM returned no queries, using fallback for: ${counterpartyName}`);
            return generateFallbackQueries(transaction, counterpartyName);
        }

        return queries;
    } catch (error) {
        console.error("Error generating search queries:", error);
        // Fallback to basic queries
        return generateFallbackQueries(transaction, counterpartyName);
    }
}

/**
 * Generates basic fallback queries when LLM fails.
 */
function generateFallbackQueries(transaction, counterpartyName) {
    const queries = [];

    // Query 1: Just counterparty name + "faktura"
    if (counterpartyName) {
        queries.push(`${counterpartyName} faktura`);
        queries.push(`${counterpartyName} invoice`);
        queries.push(`from:${counterpartyName}`);
    }

    // Query 2: Description keywords
    if (transaction.description) {
        const descKeywords = transaction.description.split(/[\s,|]+/).slice(0, 3).join(' ');
        queries.push(`${descKeywords} invoice`);
    }

    // Query 3: Amount-based (rough)
    const amount = Math.abs(transaction.amount);
    queries.push(`${amount} PLN faktura`);

    return queries.slice(0, 5); // Max 5 queries
}

module.exports = { analyzeAttachment, generateJustification, generateSearchQueries };
