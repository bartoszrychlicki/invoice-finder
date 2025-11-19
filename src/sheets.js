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
        emailInfo.from,
        emailInfo.subject,
        data.number,
        data.issue_date,
        data.total_amount,
        data.currency,
        data.contractor_name,
        data.contractor_tax_id,
        emailInfo.messageId,
    ];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:J', // Will use the first sheet automatically
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
