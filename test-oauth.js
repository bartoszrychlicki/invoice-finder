require('dotenv').config();
const { google } = require('googleapis');

async function testOAuth() {
    console.log('=== Testing OAuth2 Configuration ===\n');

    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

    console.log('Client ID:', GOOGLE_CLIENT_ID?.substring(0, 30) + '...');
    console.log('Client Secret:', GOOGLE_CLIENT_SECRET?.substring(0, 20) + '...');
    console.log('Refresh Token:', GOOGLE_REFRESH_TOKEN?.substring(0, 30) + '...');
    console.log('Redirect URI: https://developers.google.com/oauthplayground\n');

    const oAuth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground'
    );

    oAuth2Client.setCredentials({
        refresh_token: GOOGLE_REFRESH_TOKEN,
    });

    console.log('Attempting to get access token...\n');

    try {
        const { credentials } = await oAuth2Client.refreshAccessToken();
        console.log('✅ SUCCESS! OAuth2 is working correctly!');
        console.log('\nAccess Token (first 50 chars):', credentials.access_token?.substring(0, 50) + '...');
        console.log('Token Type:', credentials.token_type);
        console.log('Expires In:', credentials.expiry_date ? new Date(credentials.expiry_date).toLocaleString() : 'N/A');
        console.log('\n✅ You can now use the /scan endpoint!');
    } catch (error) {
        console.error('❌ ERROR: OAuth2 authentication failed!\n');
        console.error('Error message:', error.message);

        if (error.response?.data) {
            console.error('\nDetailed error:', JSON.stringify(error.response.data, null, 2));
        }

        console.error('\n🔧 Troubleshooting steps:');
        console.error('1. Make sure you clicked the ⚙️ icon in OAuth Playground');
        console.error('2. Check "Use your own OAuth credentials"');
        console.error('3. Enter your Client ID and Client Secret');
        console.error('4. Then authorize and generate the refresh token');
        console.error('5. The redirect URI must be: https://developers.google.com/oauthplayground');
    }
}

testOAuth();
