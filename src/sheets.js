const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');

/**
 * Checks if an invoice already exists in the spreadsheet.
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

        // Check for duplicates based on key fields
        // Row structure: [Timestamp, From, Subject, Number, IssueDate, Amount, Currency, SellerName, SellerTaxID, BuyerName, BuyerTaxID, MessageID, Status]

        console.log(`  -> Checking for duplicates. Looking for: Number=${data.number}, Date=${data.issue_date}, Amount=${data.total_amount}, SellerNIP=${data.seller_tax_id}, BuyerNIP=${data.buyer_tax_id}`);
        console.log(`  -> Found ${dataRows.length} existing rows in sheet`);

        for (const row of dataRows) {
            const existingNumber = row[3];
            const existingIssueDate = row[4];
            const existingAmount = parseFloat(row[5]);
            const existingSellerTaxId = row[8];
            const existingBuyerTaxId = row[10];

            // Match criteria: same number, date, amount, and tax IDs
            const numberMatch = existingNumber === data.number;
            const dateMatch = existingIssueDate === data.issue_date;
            const amountMatch = Math.abs(existingAmount - data.total_amount) < 0.01; // Float comparison
            const sellerMatch = existingSellerTaxId === data.seller_tax_id;
            const buyerMatch = existingBuyerTaxId === data.buyer_tax_id;

            if (numberMatch && dateMatch && amountMatch && sellerMatch && buyerMatch) {
                console.log(`  -> DUPLICATE FOUND: Document ${data.number} already exists in sheet`);
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error("Error checking for duplicates:", error.message);
        // If we can't check, assume it's not a duplicate to avoid blocking new invoices
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
    ];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:M', // Extended to column M to accommodate all fields
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
