const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const config = require('./config');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

const LOG_SHEET_TITLE = 'System_Logs';

/**
 * Ensures the log sheet exists.
 */
async function ensureLogSheet(sheets, spreadsheetId) {
    try {
        const spreadsheet = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId }));
        const sheet = spreadsheet.data.sheets.find(s => s.properties.title === LOG_SHEET_TITLE);

        if (!sheet) {
            logger.info(`Creating log sheet`, { title: LOG_SHEET_TITLE });
            await withRetry(() => sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: { title: LOG_SHEET_TITLE }
                        }
                    }]
                }
            }));

            await withRetry(() => sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${LOG_SHEET_TITLE}!A1:F1`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [['Timestamp', 'Status', 'Invoices Found', 'Duplicates', 'Processed', 'Duration (s)']]
                }
            }));
        }
    } catch (error) {
        logger.error(`Error ensuring log sheet exists`, { error: error.message });
    }
}

/**
 * Logs an execution to the Google Sheet.
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
        await withRetry(() => sheets.spreadsheets.values.append({
            spreadsheetId: config.spreadsheet_id,
            range: `${LOG_SHEET_TITLE}!A:F`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
        }));
        logger.info('Execution stats logged to Sheets.');
    } catch (error) {
        logger.error(`Failed to log execution stats`, { error: error.message });
    }
}

/**
 * Retrieves execution logs from the last N days.
 */
async function getRecentExecutions(days = 7) {
    if (!config.spreadsheet_id) return [];

    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const response = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: config.spreadsheet_id,
            range: `${LOG_SHEET_TITLE}!A:F`,
        }));

        const rows = response.data.values || [];
        if (rows.length < 2) return [];

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
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    } catch (error) {
        logger.error(`Error fetching execution logs`, { error: error.message });
        return [];
    }
}

module.exports = { logExecution, getRecentExecutions };
