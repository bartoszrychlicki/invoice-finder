require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = require('open');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'http://localhost:3000/oauth2callback'
);

const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/spreadsheets'
];

const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
});

console.log('=== OAuth2 Token Generator ===\n');
console.log('This will help you generate a valid refresh token.\n');
console.log('Starting local server on http://localhost:3000...\n');

const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/oauth2callback') > -1) {
        const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
        const code = qs.get('code');

        res.end('Authentication successful! Please return to the console.');

        try {
            const { tokens } = await oAuth2Client.getToken(code);

            console.log('\n✅ SUCCESS! Here is your refresh token:\n');
            console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
            console.log('\nCopy the line above and paste it into your .env file!');

            server.close();
            process.exit(0);
        } catch (error) {
            console.error('\n❌ Error getting tokens:', error.message);
            server.close();
            process.exit(1);
        }
    }
});

server.listen(3000, () => {
    console.log('Opening browser for authentication...\n');
    console.log('If the browser does not open automatically, visit this URL:\n');
    console.log(authUrl);
    console.log('\n');

    // Try to open browser (may not work on all systems)
    try {
        open(authUrl);
    } catch (e) {
        console.log('Could not open browser automatically. Please copy the URL above.');
    }
});
