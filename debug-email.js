require('dotenv').config();
const { google } = require('googleapis');
const { getOAuth2Client } = require('./src/auth');

async function debugEmail() {
    const auth = getOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });

    // Try to find the email
    const query = 'subject:Faktura from:"Bartosz Rychlicki" has:attachment';
    console.log(`Searching with query: ${query}`);

    const res = await gmail.users.messages.list({
        auth,
        userId: 'me',
        q: query,
        maxResults: 5
    });

    const messages = res.data.messages || [];
    console.log(`Found ${messages.length} messages.`);

    if (messages.length === 0) {
        console.log("No messages found! Check if query matches or if email is older/archived.");
        return;
    }

    // Inspect the most recent one (likely the one in screenshot)
    const messageId = messages[0].id;
    console.log(`Inspecting message ID: ${messageId}`);

    const msgDetails = await gmail.users.messages.get({
        auth,
        userId: 'me',
        id: messageId,
    });

    const payload = msgDetails.data.payload;
    const headers = payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value;
    const from = headers.find(h => h.name === 'From')?.value;
    const date = headers.find(h => h.name === 'Date')?.value;

    console.log(`Subject: ${subject}`);
    console.log(`From: ${from}`);
    console.log(`Date: ${date}`);
    console.log(`Snippet: ${msgDetails.data.snippet}`);

    const parts = payload.parts || [];
    console.log(`Parts found: ${parts.length}`);

    for (const part of parts) {
        console.log(`-- Part --`);
        console.log(`   MimeType: ${part.mimeType}`);
        console.log(`   Filename: ${part.filename}`);
        console.log(`   Size: ${part.body.size}`);
        console.log(`   AttachmentId: ${part.body.attachmentId ? 'Yes' : 'No'}`);
        
        if (part.body.size < 20000) {
            console.log(`   ⚠️ WARNING: Size < 20000 bytes. Main logic skips this!`);
        }
    }
}

debugEmail().catch(console.error);
