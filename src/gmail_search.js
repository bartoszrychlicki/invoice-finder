const { google } = require('googleapis');
const { generateSearchQueries } = require('./openai');

/**
 * Searches Gmail for a missing invoice transaction.
 * 
 * @param {Object} transaction - The transaction object.
 * @param {Object} auth - OAuth2 client.
 * @returns {Promise<Object>} - Result { found: boolean, emailId: string, query: string }
 */
async function findMissingInvoice(transaction, auth, searchAmount = null) {
    // 1. Filter out internal transactions and income
    if (transaction.amount > 0) {
        console.log(`  -> Skipping search: Income transaction (${transaction.amount})`);
        return { found: false, reason: 'income' };
    }

    const internalKeywords = [
        'RYCHLICKI HOLDING',
        'Bartosz Rychlicki',
        'Wewnętrzny',
        'ZUS', // Usually paid via dedicated transfer, invoice might not be in email or is specific
        'Urząd Skarbowy'
    ];

    const counterparty = (transaction.counterparty || '').toLowerCase();
    const description = (transaction.description || '').toLowerCase();

    if (internalKeywords.some(k => counterparty.includes(k.toLowerCase()) || description.includes(k.toLowerCase()))) {
        console.log(`  -> Skipping search: Internal/Tax transaction`);
        return { found: false, reason: 'internal' };
    }

    // 2. Generate Search Queries
    const targetAmount = searchAmount ? Math.abs(searchAmount) : Math.abs(transaction.amount);
    console.log(`  -> Generating search queries for: ${transaction.counterparty} (Target: ${targetAmount})`);

    const deterministicQueries = [];
    const amountStr = targetAmount.toFixed(2).replace('.', ','); // Polish format 123,45
    const amountStrDot = targetAmount.toFixed(2); // Dot format 123.45

    // Date range: +/- 5 days
    // Need to parse transaction.date (YYYY-MM-DD or DD-MM-YYYY)
    // reconcile.js uses DD-MM-YYYY for CSV and YYYY-MM-DD for MT940?
    // Let's try to handle both or assume standard Date object if passed?
    // transaction.date is string.

    // Strategy 1: Exact Amount + "faktura"
    deterministicQueries.push(`"${amountStr}" faktura`);
    deterministicQueries.push(`"${amountStrDot}" invoice`);

    // Strategy 2: Counterparty + "faktura"
    if (transaction.counterparty) {
        // Clean counterparty name (remove "Sp. z o.o.", address etc.)
        const cleanName = transaction.counterparty.split(',')[0].replace(/Sp\.? z o\.?o\.?/i, '').trim();
        if (cleanName.length > 3) {
            deterministicQueries.push(`"${cleanName}" faktura`);
            deterministicQueries.push(`"${cleanName}" invoice`);
            deterministicQueries.push(`from:"${cleanName}" has:attachment`);
        }
    }

    // Strategy 3: Invoice Number from Description
    // Extract potential invoice numbers (e.g. "FV/123/2025")
    const desc = transaction.description || '';
    const potentialNumbers = desc.match(/[A-Z0-9\/-]{5,}/g);
    if (potentialNumbers) {
        potentialNumbers.forEach(num => {
            // Filter out obvious non-invoice numbers (like IBANs or dates)
            if (!num.match(/^\d{26}$/) && !num.match(/^\d{4}-\d{2}-\d{2}$/)) {
                deterministicQueries.push(`"${num}"`);
            }
        });
    }

    // Combine with OpenAI queries
    let queries = [...deterministicQueries];

    // Only ask OpenAI if we have few queries or want more variations
    if (queries.length < 5) {
        const aiQueries = await generateSearchQueries(transaction);
        if (aiQueries) queries = [...queries, ...aiQueries];
    }

    // Deduplicate
    queries = [...new Set(queries)];

    if (!queries || queries.length === 0) {
        console.log(`  -> No queries generated.`);
        return { found: false, reason: 'no_queries' };
    }

    const gmail = google.gmail({ version: 'v1', auth });

    // 3. Execute Queries
    for (const query of queries) {
        console.log(`    -> Trying query: [${query}]`);
        try {
            const res = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 5 // Get a few results to check for attachments
            });

            if (res.data.messages && res.data.messages.length > 0) {
                // Check each message for attachments
                for (const message of res.data.messages) {
                    const hasAttachment = await checkForInvoiceAttachment(gmail, message.id);
                    if (hasAttachment) {
                        console.log(`      -> FOUND! Message ID: ${message.id} (has attachment)`);
                        return { found: true, emailId: message.id, query: query };
                    }
                }
                console.log(`      -> Found ${res.data.messages.length} message(s) but none have invoice attachments`);
            }
        } catch (error) {
            console.error(`      -> Error executing query: ${error.message}`);
        }
    }

    console.log(`  -> Not found after trying ${queries.length} queries.`);
    return { found: false, reason: 'not_found' };
}


/**
 * Checks if a message has an invoice attachment (PDF, JPEG, JPG).
 * @param {Object} gmail - Gmail API instance.
 * @param {string} messageId - Message ID.
 * @returns {Promise<boolean>} - True if has invoice attachment.
 */
async function checkForInvoiceAttachment(gmail, messageId) {
    try {
        const message = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['Subject']
        });

        // Check for attachments
        if (message.data.payload && message.data.payload.parts) {
            for (const part of message.data.payload.parts) {
                const filename = (part.filename || '').toLowerCase();
                const mimeType = (part.mimeType || '').toLowerCase();

                // Check if it's a PDF or image attachment
                if (filename && (
                    filename.endsWith('.pdf') ||
                    filename.endsWith('.jpg') ||
                    filename.endsWith('.jpeg') ||
                    filename.endsWith('.png')
                )) {
                    if (part.body && part.body.attachmentId) {
                        return true;
                    }
                }
            }
        }

        return false;
    } catch (error) {
        console.error(`      -> Error checking attachment for ${messageId}: ${error.message}`);
        return false;
    }
}

module.exports = { findMissingInvoice };
