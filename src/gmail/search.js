const { google } = require('googleapis');

const gmail = google.gmail('v1');

/**
 * Searches for emails that might contain invoices.
 * @param {Object} auth - OAuth2 client.
 * @param {string} userId - Gmail user ID.
 * @param {number|Object} timeRange - Number of hours or range object.
 * @returns {Promise<Array>} - List of message objects.
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
    console.log(`Searching for emails with query: ${query}`);

    const res = await gmail.users.messages.list({
        auth,
        userId,
        q: query,
    });

    return res.data.messages || [];
}

/**
 * Ensures a label exists in the user's Gmail.
 */
async function ensureLabel(auth, userId, labelName) {
    try {
        const res = await gmail.users.labels.list({ auth, userId });
        const labels = res.data.labels || [];
        const existing = labels.find(l => l.name === labelName);

        if (existing) {
            return existing.id;
        }

        console.log(`Label '${labelName}' not found. Creating it...`);
        const created = await gmail.users.labels.create({
            auth,
            userId,
            requestBody: {
                name: labelName,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
            }
        });
        console.log(`Label '${labelName}' created (ID: ${created.data.id}).`);
        return created.data.id;
    } catch (error) {
        console.error(`Error ensuring label '${labelName}':`, error.message);
        throw error;
    }
}

module.exports = { findEmails, ensureLabel };
