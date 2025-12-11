require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');
const open = require('open');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

// Use the same redirect URI as the main application to ensure it's whitelisted
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
});

console.log('=== OAuth2 Token Generator (Manual Mode) ===\n');
console.log('1. Opening your browser to authenticate...');
console.log('   (If it doesn\'t open, copy this link:)\n');
console.log(authUrl);
console.log('\n2. After you approve access, you will be redirected to the OAuth Playground.');
console.log('3. Look for the "Authorization code" in the URL or on the page.');
console.log('4. Copy that code and paste it below.\n');

// Try to open browser
try {
    open(authUrl);
} catch (e) {
    // Ignore error
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Paste the Authorization Code here: ', async (code) => {
    try {
        const { tokens } = await oAuth2Client.getToken(code);

        console.log('\n✅ SUCCESS! Here is your refresh token:\n');
        console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
        console.log('\nCopy the line above and paste it into your .env file!');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error getting tokens:', error.message);
        process.exit(1);
    }
});
