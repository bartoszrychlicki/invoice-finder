require('dotenv').config();
const { google } = require('googleapis');

async function checkTokenScopes() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        console.error('Missing credentials in .env');
        return;
    }

    const oAuth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground'
    );

    oAuth2Client.setCredentials({
        refresh_token: GOOGLE_REFRESH_TOKEN
    });

    try {
        const { token } = await oAuth2Client.getAccessToken();
        const tokenInfo = await oAuth2Client.getTokenInfo(token);

        console.log('=== Token Scope Verification ===');
        console.log('Scopes found:', tokenInfo.scopes);

        const requiredScopes = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ];

        const missingScopes = requiredScopes.filter(scope => !tokenInfo.scopes.includes(scope));

        if (missingScopes.length > 0) {
            console.error('❌ MISSING SCOPES:', missingScopes);
        } else {
            console.log('✅ All required scopes are present!');
        }

    } catch (error) {
        console.error('Error checking token:', error.message);
    }
}

checkTokenScopes();
