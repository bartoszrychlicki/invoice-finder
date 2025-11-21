const { google } = require('googleapis');

const getOAuth2Client = () => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        throw new Error('Missing Google OAuth2 credentials in environment variables.');
    }



    const oAuth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID.trim(),
        GOOGLE_CLIENT_SECRET.trim(),
        'https://developers.google.com/oauthplayground'
    );

    oAuth2Client.setCredentials({
        refresh_token: GOOGLE_REFRESH_TOKEN.trim(),
    });

    return oAuth2Client;
};

module.exports = { getOAuth2Client };
