# Gmail Invoice Scanner - Deployment Guide

This application scans your Gmail for invoices, processes them with OpenAI, and logs them to Google Sheets.

## Prerequisites

1.  **Google Cloud Project**: Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2.  **Enable APIs**: Enable Gmail API, Google Sheets API, Cloud Run API, Cloud Build API, and Cloud Scheduler API.
3.  **OAuth Consent Screen**: Configure the OAuth consent screen (External -> Test Users -> Add your email).
4.  **Credentials**: Create OAuth 2.0 Client ID credentials (Web Application).
    *   **IMPORTANT**: In "Authorized redirect URIs", add: `https://developers.google.com/oauthplayground`
    *   This is critical - without this exact URI, you'll get `unauthorized_client` errors.
5.  **OpenAI API Key**: Get an API key from OpenAI.

## Configuration

1.  **Generate Refresh Token**:
    *   **IMPORTANT**: Before starting, configure OAuth Playground to use YOUR credentials:
        - Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
        - Click the **⚙️ (Settings)** icon in the top right corner
        - Check **"Use your own OAuth credentials"**
        - Enter your **OAuth Client ID** and **OAuth Client secret** from Google Cloud Console
        - Click **"Close"**
    *   Now proceed with token generation:
        - In Step 1, select the following scopes:
          - `https://www.googleapis.com/auth/gmail.readonly`
          - `https://www.googleapis.com/auth/gmail.send`
          - `https://www.googleapis.com/auth/spreadsheets`
        - Click **"Authorize APIs"** and sign in with your Google account
        - In Step 2, click **"Exchange authorization code for tokens"**
        - Copy the **Refresh token** (NOT the Access token!)
    *   **Common mistake**: If you skip the Settings step (⚙️), the token will NOT work with your Client ID!

2.  **Environment Variables**:
    *   Copy `.env.example` to `.env` (for local testing) or prepare them for Cloud Run.

## Local Testing

1.  Fill in `.env`.
2.  Run `npm start`.
3.  In another terminal, trigger the scan:
    ```bash
    curl -X POST http://localhost:8080/scan
    ```

## Deployment to Cloud Run

1.  **Build and Push Docker Image**:
    ```bash
    gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/gmail-invoice-scanner
    ```

2.  **Deploy to Cloud Run**:
    ```bash
    gcloud run deploy gmail-invoice-scanner \
      --image gcr.io/YOUR_PROJECT_ID/gmail-invoice-scanner \
      --platform managed \
      --region us-central1 \
      --allow-unauthenticated \
      --set-env-vars="GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,GOOGLE_REFRESH_TOKEN=...,OPENAI_API_KEY=...,TARGET_EMAIL=...,SPREADSHEET_ID=..."
    ```
    *Note: `--allow-unauthenticated` is used here so Cloud Scheduler can trigger it easily. For better security, use authentication and configure Scheduler with a service account.*

## Schedule with Cloud Scheduler

1.  Create a job:
    ```bash
    gcloud scheduler jobs create http scan-invoices-daily \
      --schedule="0 23 * * *" \
      --uri="SERVICE_URL/scan" \
      --http-method=POST \
      --time-zone="Europe/Warsaw"
    ```
    *Replace `SERVICE_URL` with the URL provided by Cloud Run.*

## Monitoring

*   Check Cloud Run logs for execution details.
*   Check Google Sheet for logged invoices.

## Troubleshooting

### Error: `unauthorized_client`

This error occurs when OAuth2 configuration is incorrect. Follow these steps:

1. **Verify Redirect URI in Google Cloud Console**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
   - Click on your OAuth 2.0 Client ID
   - Under "Authorized redirect URIs", ensure `https://developers.google.com/oauthplayground` is listed
   - If not, add it and click Save

2. **Regenerate Refresh Token**:
   - Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   - Click the gear icon (⚙️) in the top right
   - Check "Use your own OAuth credentials"
   - Enter your Client ID and Client Secret
   - In Step 1, select:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/spreadsheets`
   - Click "Authorize APIs"
   - In Step 2, click "Exchange authorization code for tokens"
   - Copy the new **Refresh token** and update your `.env` file

3. **Verify Environment Variables**:
   - Ensure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` are correctly set in `.env`
   - Make sure there are no extra spaces or quotes

### Error: Missing OpenAI API Key

Ensure `OPENAI_API_KEY` is set in your `.env` file.

### No emails found

- Check that you have emails with attachments from today
- Verify Gmail API is enabled in Google Cloud Console
- Ensure your email is added as a test user in OAuth consent screen

