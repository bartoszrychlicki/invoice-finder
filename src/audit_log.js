const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const config = require('./config');

const LOG_SHEET_TITLE = 'System_Logs';

/**
 * Ensures the log sheet exists.
 */
async function ensureLogSheet(sheets, spreadsheetId) {
    try {
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
        const sheet = spreadsheet.data.sheets.find(s => s.properties.title === LOG_SHEET_TITLE);

        if (!sheet) {
            console.log(`Creating sheet '${LOG_SHEET_TITLE}'...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: { title: LOG_SHEET_TITLE }
                        }
                    }]
                }
            });

            // Add headers
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${LOG_SHEET_TITLE}!A1:F1`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [['Timestamp', 'Status', 'Invoices Found', 'Duplicates', 'Processed', 'Duration (s)']]
                }
            });
        }
    } catch (error) {
        console.error(`Error ensuring log sheet exists: ${error.message}`);
        // Don't throw, we might just fail to write logs which is non-critical for the main flow
    }
}

/**
 * Logs an execution to the Google Sheet.
 * @param {Object} stats - Execution statistics.
 * @param {string} stats.status - 'success' or 'error'
 * @param {number} stats.invoicesFound
 * @param {number} stats.duplicates
 * @param {number} stats.processed
 * @param {number} stats.duration
 */
async function logExecution(stats) {
    if (!config.spreadsheet_id) return;

    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });

    await ensureLogSheet(sheets, config.spreadsheet_id);

    const row = [
        new Date().toISOString(),
        stats.status,
        stats.invoicesFound || 0,
        stats.duplicates || 0,
        stats.processed || 0,
        stats.duration || 0
    ];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: config.spreadsheet_id,
            range: `${LOG_SHEET_TITLE}!A:F`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
        });
        console.log('Execution stats logged to Sheets.');
    } catch (error) {
        console.error(`Failed to log execution stats: ${error.message}`);
    }
}

/**
 * Retrieves execution logs from the last N days.
 * @param {number} days - Number of days to look back.
 * @returns {Promise<Array>}
 */
async function getRecentExecutions(days = 7) {
    if (!config.spreadsheet_id) return [];

    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.spreadsheet_id,
            range: `${LOG_SHEET_TITLE}!A:F`,
        });

        const rows = response.data.values || [];
        if (rows.length < 2) return []; // Only header or empty

        const headers = rows[0]; // Timestamp, Status, etc.
        const data = rows.slice(1);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        return data
            .map(row => ({
                timestamp: row[0],
                status: row[1],
                invoices_found: parseInt(row[2]) || 0,
                duplicates: parseInt(row[3]) || 0,
                processed: parseInt(row[4]) || 0,
                duration: parseFloat(row[5]) || 0
            }))
            .filter(item => {
                const itemDate = new Date(item.timestamp);
                return itemDate >= cutoffDate;
            })
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Newest first

    } catch (error) {
        console.error(`Error fetching execution logs: ${error.message}`);
        return [];
    }
}

module.exports = { logExecution, getRecentExecutions };
