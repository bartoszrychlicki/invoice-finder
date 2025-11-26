const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const { getAllInvoices, parseAmount, normalizeString } = require('./sheets');
const config = require('../config.json');

/**
 * Reconciles bank transactions with existing invoices.
 * 
 * @param {Array<Object>} transactions - Parsed bank transactions.
 * @param {Object} sheets - Google Sheets API instance.
 * @param {string} spreadsheetId - ID of the invoice registry.
 * @returns {Promise<Object>} - Result object { matched: [], missing: [] }
 */
async function reconcileTransactions(transactions, sheets, spreadsheetId) {
    const invoices = await getAllInvoices(sheets, spreadsheetId);
    console.log(`Loaded ${invoices.length} invoices from registry.`);

    const matched = [];
    const missing = [];

    // Helper to parse date DD-MM-YYYY to Date object
    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const [day, month, year] = dateStr.split('-');
        return new Date(`${year}-${month}-${day}`);
    };

    // Helper to parse invoice date YYYY-MM-DD to Date object
    // Note: Sheets might store dates differently, but assuming ISO from logToSheet
    const parseInvoiceDate = (dateStr) => {
        if (!dateStr) return null;
        // Handle YYYY-MM-DD or DD-MM-YYYY or other formats?
        // logToSheet uses: data.issue_date. 
        // OpenAI usually returns YYYY-MM-DD.
        // Let's try to be flexible.
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
        return null;
    };

    for (const tx of transactions) {
        // Skip positive amounts (income) if we are only looking for expenses?
        // User said: "transakcje na zestawieniu bankowym versus te, których brakuje"
        // Usually invoices are expenses (negative on bank) or income (positive).
        // The registry contains both?
        // Let's assume we reconcile EVERYTHING.

        const txAmount = tx.amount;
        const txDate = parseDate(tx.date);

        let bestMatch = null;
        let bestScore = 0;

        for (const inv of invoices) {
            // Invoice row structure from sheets.js:
            // 0: Timestamp, 1: From, 2: Subject, 3: Number, 4: Issue Date, 5: Amount, ...
            const invAmount = parseAmount(inv[5]);
            const invDate = parseInvoiceDate(inv[4]);

            // 1. Amount Match (Critical)
            // Bank amount is usually negative for expenses. Invoice amount is usually positive in the sheet?
            // Let's check the sheet sample or code.
            // In `logToSheet`, it logs `data.total_amount`.
            // OpenAI extraction usually extracts the absolute amount on the invoice.
            // Bank transaction is negative for expense.
            // So we should compare ABSOLUTE values.

            if (Math.abs(Math.abs(txAmount) - Math.abs(invAmount)) < 0.05) {
                // Potential match
                let score = 50;

                // 2. Date Match (+/- 7 days)
                if (txDate && invDate) {
                    const diffTime = Math.abs(txDate - invDate);
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    if (diffDays <= 7) {
                        score += 40;
                        if (diffDays === 0) score += 10; // Exact match bonus
                    }
                }

                // 3. Counterparty/Description fuzzy match (Optional bonus)
                // If we have a high score already, we might not need this, but it helps break ties.
                const txDesc = (tx.counterparty + ' ' + tx.description).toLowerCase();
                const invSeller = (inv[7] || '').toLowerCase(); // Seller Name
                const invBuyer = (inv[9] || '').toLowerCase(); // Buyer Name

                if (invSeller && txDesc.includes(invSeller)) score += 10;
                // if (invBuyer && txDesc.includes(invBuyer)) score += 5; // Less likely for expenses

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = inv;
                }
            }
        }

        if (bestMatch && bestScore >= 80) { // Threshold 80 (Amount + Date within 7 days = 90)
            matched.push({ transaction: tx, invoice: bestMatch, score: bestScore });
        } else {
            missing.push(tx);
        }
    }

    return { matched, missing };
}

/**
 * Generates a reconciliation report in a new Google Sheet.
 * 
 * @param {Object} reconciliationResult - Result from reconcileTransactions.
 * @param {Object} sheets - Google Sheets API instance.
 * @returns {Promise<string>} - URL of the created spreadsheet.
 */
async function generateReport(reconciliationResult, sheets) {
    const title = `Reconciliation Report - ${new Date().toISOString().split('T')[0]}`;

    // Create new spreadsheet
    const createRes = await sheets.spreadsheets.create({
        requestBody: {
            properties: { title },
            sheets: [
                { properties: { title: 'Missing Invoices' } }, // First tab is usually most important
                { properties: { title: 'Matched Transactions' } }
            ]
        }
    });

    const spreadsheetId = createRes.data.spreadsheetId;
    const spreadsheetUrl = createRes.data.spreadsheetUrl;

    // Prepare data for Missing Invoices
    const missingRows = [
        ['Date', 'Amount', 'Currency', 'Counterparty', 'Description', 'Raw Transaction'],
        ...reconciliationResult.missing.map(tx => [
            tx.date,
            tx.amount,
            tx.currency,
            tx.counterparty,
            tx.description,
            tx.raw
        ])
    ];

    // Prepare data for Matched Transactions
    const matchedRows = [
        ['Bank Date', 'Bank Amount', 'Bank Counterparty', 'Invoice Number', 'Invoice Date', 'Invoice Amount', 'Seller', 'Score'],
        ...reconciliationResult.matched.map(m => [
            m.transaction.date,
            m.transaction.amount,
            m.transaction.counterparty,
            m.invoice[3], // Number
            m.invoice[4], // Issue Date
            m.invoice[5], // Amount
            m.invoice[7], // Seller
            m.score
        ])
    ];

    // Write to sheets
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
                {
                    range: 'Missing Invoices!A1',
                    values: missingRows
                },
                {
                    range: 'Matched Transactions!A1',
                    values: matchedRows
                }
            ]
        }
    });

    // Formatting (Optional: Bold headers)
    // ... skipping for brevity, but good to have.

    return spreadsheetUrl;
}

module.exports = { reconcileTransactions, generateReport };
