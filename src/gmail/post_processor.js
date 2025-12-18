const { google } = require('googleapis');

const gmail = google.gmail('v1');

/**
 * Marks an email as processed: removes UNREAD/INBOX, adds label.
 */
async function markEmailAsProcessed(auth, userId, messageId, labelId) {
    const addLabelIds = [];
    if (labelId) addLabelIds.push(labelId);

    await gmail.users.messages.modify({
        auth,
        userId,
        id: messageId,
        requestBody: {
            removeLabelIds: ['UNREAD', 'INBOX'],
            addLabelIds: addLabelIds
        }
    });
}

module.exports = { markEmailAsProcessed };
