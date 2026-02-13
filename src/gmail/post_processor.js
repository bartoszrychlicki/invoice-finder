const { google } = require('googleapis');

const gmail = google.gmail('v1');

/**
 * Marks an email as processed: adds label, optionally archives (removes from INBOX).
 * @param {boolean} archive - If true, removes UNREAD/INBOX labels. Default: true.
 */
async function markEmailAsProcessed(auth, userId, messageId, labelId, archive = true) {
    const addLabelIds = [];
    if (labelId) addLabelIds.push(labelId);

    const removeLabelIds = archive ? ['UNREAD', 'INBOX'] : [];

    await gmail.users.messages.modify({
        auth,
        userId,
        id: messageId,
        requestBody: {
            removeLabelIds,
            addLabelIds
        }
    });
}

module.exports = { markEmailAsProcessed };
