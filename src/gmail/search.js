const { google } = require('googleapis');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const gmail = google.gmail('v1');

/**
 * Searches for emails that might contain invoices.
 */
async function findEmails(auth, userId, timeRange) {
    let queryTimePart = '';
    if (typeof timeRange === 'number') {
        const lookbackTime = new Date();
        lookbackTime.setHours(lookbackTime.getHours() - timeRange);
        const after = Math.floor(lookbackTime.getTime() / 1000);
        queryTimePart = `after:${after}`;
    } else if (typeof timeRange === 'object' && timeRange.after && timeRange.before) {
        queryTimePart = `after:${timeRange.after} before:${timeRange.before}`;
    } else {
        const lookbackTime = new Date();
        lookbackTime.setHours(lookbackTime.getHours() - 24);
        const after = Math.floor(lookbackTime.getTime() / 1000);
        queryTimePart = `after:${after}`;
    }

    const keywords = '(faktura OR faktury OR invoice OR rachunek OR paragon OR inv OR receipt OR bill OR "dokument sprzedaży" OR "dokument zakupu" OR "potwierdzenie zakupu" OR fakturka OR fv)';
    const query = `has:attachment ${queryTimePart} ${keywords}`;
    logger.debug(`Searching Gmail`, { query });

    try {
        const res = await withRetry(() => gmail.users.messages.list({
            auth,
            userId,
            q: query,
        }));
        return res.data.messages || [];
    } catch (error) {
        logger.error("Error listing messages from Gmail", { error: error.message });
        return [];
    }
}

/**
 * Ensures a label exists in the user's Gmail.
 */
async function ensureLabel(auth, userId, labelName) {
    try {
        const res = await withRetry(() => gmail.users.labels.list({ auth, userId }));
        const labels = res.data.labels || [];
        const existing = labels.find(l => l.name === labelName);

        if (existing) {
            return existing.id;
        }

        logger.info(`Label not found, creating it`, { labelName });
        const created = await withRetry(() => gmail.users.labels.create({
            auth,
            userId,
            requestBody: {
                name: labelName,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
            }
        }));
        logger.info(`Label created`, { labelName, id: created.data.id });
        return created.data.id;
    } catch (error) {
        logger.error(`Error ensuring label`, { labelName, error: error.message });
        throw error;
    }
}

module.exports = { findEmails, ensureLabel };
