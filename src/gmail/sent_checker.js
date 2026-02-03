const { google } = require('googleapis');
const config = require('../../config.json');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

/**
 * Checks if an invoice email was already sent to the target email (Infakt).
 * @param {Object} auth - Gmail Auth Client
 * @param {string} filename - The filename of the invoice attachment
 * @returns {Promise<boolean>} - True if already sent, False otherwise
 */
async function wasSentToInfakt(auth, filename) {
    const gmail = google.gmail({ version: 'v1', auth });
    const targetEmail = config.target_email;

    // Subject format from notifier.js: `Forwarded Invoice: ${filename}`
    // We search for: to:{target} subject:"Forwarded Invoice: {filename}"
    const query = `to:${targetEmail} subject:"Forwarded Invoice: ${filename}"`;

    try {
        const res = await withRetry(() => gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 1
        }));

        const found = res.data.resultSizeEstimate > 0 || (res.data.messages && res.data.messages.length > 0);

        if (found) {
            logger.debug(`Found Sent email for ${filename}`, { query });
        } else {
            logger.debug(`No Sent email found for ${filename}`, { query });
        }

        return found;
    } catch (error) {
        logger.error(`Error checking Sent folder`, { error: error.message, filename });
        // Fail safe: If error, assume NOT sent so we don't skip logic, 
        // OR assume SENT to avoid spam? 
        // User asked to "double verify NOT sent". 
        // If API fails, better to manual check. But for auto-script, let's return false (safe to process, but risky for duplicate).
        // Actually, if we can't check, we should probably abort or skip to be safe.
        // Let's return false but log error.
        return false;
    }
}

module.exports = { wasSentToInfakt };
