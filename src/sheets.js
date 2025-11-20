const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');

/**
 * Checks if an invoice already exists in the spreadsheet.
 * @param {Object} sheets - Google Sheets API instance.
 * @param {string} spreadsheetId - The spreadsheet ID.
 * @param {Object} data - The invoice data to check.
 * @returns {Promise<boolean>} - True if duplicate found, false otherwise.
 */
/**
 * Normalizes a string for comparison (removes non-alphanumeric, lowercase).
 */
function normalizeString(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parses amount string to float.
 */
function parseAmount(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    // Replace comma with dot, remove non-numeric chars except dot and minus
    const clean = val.toString().replace(',', '.').replace(/[^\d.-]/g, '');
    return parseFloat(clean) || 0;
}

/**
 * Checks if an invoice already exists in the spreadsheet using a Scoring System.
 * Threshold for duplicate is 80 points.
 * 
 * Scoring:
 * - Amount Match: 40 pts
 * - Date Match: 30 pts
 * - Number Match (Normalized): 20 pts
 * - Seller NIP Match (Normalized): 20 pts
 * - Buyer NIP Match (Normalized): 10 pts
 * 
 * @param {Object} sheets - Google Sheets API instance.
 * @param {string} spreadsheetId - The spreadsheet ID.
 * @param {Object} data - The invoice data to check.
 * @returns {Promise<boolean>} - True if duplicate found, false otherwise.
 */
async function isDuplicate(sheets, spreadsheetId, data) {
    try {
        // Fetch all existing rows from the sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'A:M', // All columns
        });

        const rows = response.data.values || [];

        // Skip header row if exists
        const dataRows = rows.length > 0 && rows[0][0] === 'Timestamp' ? rows.slice(1) : rows;

        console.log(`  -> Checking for duplicates (Scoring System). Found ${dataRows.length} existing rows.`);

        const targetAmount = parseAmount(data.total_amount);
        const targetDate = data.issue_date;
        const targetNumberNorm = normalizeString(data.number);
        const targetSellerNorm = normalizeString(data.seller_tax_id);
        const targetBuyerNorm = normalizeString(data.buyer_tax_id);

        for (const row of dataRows) {
            const existingNumber = row[3];
            const existingIssueDate = row[4];
            const existingAmount = parseAmount(row[5]);
            const existingSellerTaxId = row[8];
            const existingBuyerTaxId = row[10];

            let score = 0;

            // 1. Amount Match (40 pts)
            if (Math.abs(existingAmount - targetAmount) < 0.05) {
                score += 40;
            }

            // 2. Date Match (30 pts)
            if (existingIssueDate === targetDate) {
                score += 30;
            }

            // 3. Number Match (Normalized) (20 pts)
            if (targetNumberNorm && normalizeString(existingNumber) === targetNumberNorm) {
                score += 20;
            }

            // 4. Seller NIP Match (Normalized) (20 pts)
            if (targetSellerNorm && normalizeString(existingSellerTaxId) === targetSellerNorm) {
                score += 20;
            }

            // 5. Buyer NIP Match (Normalized) (10 pts)
            if (targetBuyerNorm && normalizeString(existingBuyerTaxId) === targetBuyerNorm) {
                score += 10;
            }

            // Log high scores for debugging
            if (score >= 60) {
                console.log(`    Candidate Row Score: ${score}/100. (Num: ${existingNumber}, Date: ${existingIssueDate}, Amt: ${existingAmount})`);
            }

            // Threshold check
            if (score >= 80) {
                console.log(`  -> DUPLICATE FOUND (Score ${score}): Document ${data.number} matches existing record.`);
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error("Error checking for duplicates:", error.message);
        return false;
    }
}

/**
 * Logs invoice data to Google Sheets.
 * @param {Object} data - The extracted invoice data.
 * @param {Object} emailInfo - Metadata about the email.
 * @returns {Promise<Object>} - Returns {isDuplicate: boolean, logged: boolean}
 */
async function logToSheet(data, emailInfo) {
    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    if (!spreadsheetId) {
        console.warn("No SPREADSHEET_ID configured, skipping logging.");
        return { isDuplicate: false, logged: false };
    }

    // Check for duplicates
    const duplicate = await isDuplicate(sheets, spreadsheetId, data);

    const status = duplicate ? 'DUPLICATE' : 'NEW';

    const row = [
        new Date().toISOString(), // Timestamp
        emailInfo.from,           // Email From
        emailInfo.subject,        // Email Subject
        data.number,              // Document Number
        data.issue_date,          // Issue Date
        data.total_amount,        // Total Amount
        data.currency,            // Currency
        data.seller_name,         // Seller Name
        data.seller_tax_id,       // Seller NIP/Tax ID
        data.buyer_name,          // Buyer Name
        data.buyer_tax_id,        // Buyer NIP/Tax ID
        emailInfo.messageId,      // Gmail Message ID
        status,                   // Status (NEW or DUPLICATE)
        data.items || '',         // Items
        data.justification || ''  // Creative Justification
    ];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:O', // Extended to column O (15 columns)
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [row],
            },
        });
        console.log(`Logged to Google Sheet with status: ${status}`);
        return { isDuplicate: duplicate, logged: true };
    } catch (error) {
        console.error("Error logging to Google Sheet:");
        console.error("  Error message:", error.message);
        if (error.response?.data) {
            console.error("  Response data:", JSON.stringify(error.response.data, null, 2));
        }
        return { isDuplicate: duplicate, logged: false };
    }
}

module.exports = { logToSheet };
