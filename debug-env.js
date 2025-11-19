require('dotenv').config();

console.log('=== Environment Variables Check ===\n');

const requiredVars = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'OPENAI_API_KEY',
    'TARGET_EMAIL',
    'SPREADSHEET_ID'
];

let allPresent = true;

requiredVars.forEach(varName => {
    const value = process.env[varName];
    const status = value ? '✓' : '✗';
    const display = value ? `${value.substring(0, 20)}...` : 'NOT SET';

    console.log(`${status} ${varName}: ${display}`);

    if (!value) {
        allPresent = false;
    }
});

console.log('\n=== Summary ===');
if (allPresent) {
    console.log('✓ All required environment variables are set!');
} else {
    console.log('✗ Some environment variables are missing. Please check your .env file.');
}

console.log('\n=== OAuth2 Configuration ===');
console.log('Redirect URI: https://developers.google.com/oauthplayground');
console.log('\nMake sure this redirect URI is added to your OAuth 2.0 Client ID in Google Cloud Console!');
