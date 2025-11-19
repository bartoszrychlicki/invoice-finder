const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');

/**
 * Logs invoice data to Google Sheets.
 * @param {Object} data - The extracted invoice data.
 * @param {Object} emailInfo - Metadata about the email.
 */
async function logToSheet(data, emailInfo) {
    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    if (!spreadsheetId) {
        console.warn("No SPREADSHEET_ID configured, skipping logging.");
        return;
    }

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
        console.log("Logged to Google Sheet.");
    } catch (error) {
        console.error("Error logging to Google Sheet:");
        console.error("  Error message:", error.message);
        if (error.response?.data) {
            console.error("  Response data:", JSON.stringify(error.response.data, null, 2));
        }
    }
}

module.exports = { logToSheet };
