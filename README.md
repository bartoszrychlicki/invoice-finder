# Gmail Invoice Scanner - Deployment Guide

This application scans your Gmail for invoices, processes them with OpenAI, and logs them to Google Sheets.

## Features

1.  **Automated Scanning**: Scans Gmail for attachments (PDF/Images) from the last 24 hours.
2.  **AI Extraction**: Uses OpenAI GPT-4o to extract invoice data (Number, Date, Amount, Seller, Buyer, Items).
3.  **Smart Duplicate Detection**: Uses a scoring system to detect duplicates (even with minor OCR errors) to prevent double logging.
4.  **Creative Cost Justification**: Generates a creative business justification for each expense based on your business context (only for new invoices).
5.  **Buyer NIP Filtering**: Only forwards invoices where the Buyer NIP matches your NIP (`BUYER_TAX_ID`).
6.  **Google Sheets Logging**: Logs all processed documents to a Google Sheet.
7.  **Email Forwarding**: Forwards valid, non-duplicate invoices to a target email address.
8.  **Bank Reconciliation**: Reconciles bank transactions (CSV) with the invoice registry to find missing invoices.

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
    *   Copy `.env.example` to `.env` and fill in the values:
        - `GOOGLE_CLIENT_ID`: Your OAuth Client ID
        - `GOOGLE_CLIENT_SECRET`: Your OAuth Client Secret
        - `GOOGLE_REFRESH_TOKEN`: Your OAuth Refresh Token
        - `OPENAI_API_KEY`: Your OpenAI API Key
        - `TARGET_EMAIL`: Email address to forward invoices to
        - `SPREADSHEET_ID`: ID of the Google Sheet to log data to
        - `BUYER_TAX_ID`: Your NIP (e.g., `9571130261`). Only invoices with this Buyer NIP will be forwarded.
        - `BUSINESS_CONTEXT`: Description of your business for generating cost justifications.

## Google Sheet Structure

Ensure your Google Sheet has the following 15 columns in the first row:

```
Timestamp, Email From, Email Subject, Document Number, Issue Date, Total Amount, Currency, Seller Name, Seller Tax ID, Buyer Name, Buyer Tax ID, Gmail Message ID, Status, Items, Justification
```

## Local Testing

1.  Fill in `.env`.
2.  Run tests to verify logic:
    ```bash
    npm test
    ```
3.  Start the server:
    ```bash
    npm start
    ```
4.  In another terminal, trigger the scan:
    ```bash
    curl -X POST http://localhost:8080/scan
    ```

5.  **Test Mode** (Skips email sending):
    ```bash
    curl -X POST "http://localhost:8080/scan?test=true"
    ```

## Bank Reconciliation

This feature allows you to reconcile your bank transactions (CSV export) with the invoice registry to identify missing invoices.

### Usage

1.  Export your bank history to a CSV file.
2.  Run the reconciliation script:
    ```bash
    node run-reconciliation.js --file path/to/bank_statement.csv
    ```

### How it Works

1.  **Parses** the bank statement CSV.
2.  **Fetches** all invoices from your Google Sheet registry.
3.  **Matches** transactions based on:
    *   **Amount**: Must match within 0.05 tolerance.
    *   **Date**: Must be within +/- 7 days.
4.  **Generates Report**: Creates a new Google Sheet with two tabs:
    *   **Missing Invoices**: Transactions found in the bank statement but not in the registry.
    *   **Matched Transactions**: Successfully paired transactions.
107: 
108: ### Smart Search for Missing Invoices
109: 
110: If a transaction is found in the bank statement but misses a corresponding invoice in the registry, the system automatically triggers a **Smart Search**:
111: 
112: 1.  **Deep Search**: Scans your Gmail specifically for the missing amount and date range (looking for "lost" invoices).
113: 2.  **AI Analysis**: If a potential email is found, it is analyzed by OpenAI.
114: 3.  **Auto-Recovery**: If a valid invoice is found, it is automatically processed, logged to the registry, and then matched with the transaction.
115: 
116: You can disable this feature by adding the `--skip-search` flag:
117: ```bash
118: node run-reconciliation.js --file path/to/bank_statement.csv --skip-search
119: ```

## Deployment to Cloud Run

1.  **Using Deploy Script**:
    The project includes a `deploy.sh` script that handles deployment and environment variables (including special characters).
    ```bash
    ./deploy.sh
    ```

2.  **Manual Deployment**:
    ```bash
    # Create env.yaml with your variables first
    gcloud run deploy gmail-invoice-scanner \
      --image gcr.io/YOUR_PROJECT_ID/gmail-invoice-scanner \
      --platform managed \
      --region us-central1 \
      --allow-unauthenticated \
      --env-vars-file env.yaml
    ```

## Schedule with Cloud Scheduler

1.  Create a job:
    ```bash
    gcloud scheduler jobs create http daily-invoice-scan \
      --schedule="0 8 * * *" \
      --uri="SERVICE_URL/scan" \
      --http-method=POST \
      --time-zone="Europe/Warsaw"
    ```
    *Replace `SERVICE_URL` with the URL provided by Cloud Run.*

## Manual Workflow Triggering

You can manually trigger the invoice scanning workflow at any time using either the command line or Google Cloud Console.

### Using Command Line (curl)

1. **Basic scan (last 24 hours)**:
   ```bash
   curl -X POST "https://gmail-invoice-scanner-had6oiddya-uc.a.run.app/scan"
   ```

2. **Custom time range** (e.g., last 48 hours):
   ```bash
   curl -X POST "https://gmail-invoice-scanner-had6oiddya-uc.a.run.app/scan?hours=48"
   ```

3. **Test mode** (processes but doesn't send emails):
   ```bash
   curl -X POST "https://gmail-invoice-scanner-had6oiddya-uc.a.run.app/scan?test=true"
   ```

4. **Combined** (custom time range + test mode):
   ```bash
   curl -X POST "https://gmail-invoice-scanner-had6oiddya-uc.a.run.app/scan?hours=48&test=true"
   ```

**Note**: Replace the URL with your actual Cloud Run service URL (you can find it in the deployment output or Cloud Console).

### Using Google Cloud Console

1. **Navigate to Cloud Run**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Select your project
   - Navigate to **Cloud Run** from the left menu
   - Click on the `gmail-invoice-scanner` service

2. **Open Testing Tab**:
   - Click on the **"TESTING"** tab at the top
   - Or use the **"Test"** button in the service details

3. **Configure Request**:
   - **Method**: Select `POST`
   - **Path**: Enter `/scan`
   - **Query parameters** (optional):
     - Add `hours` with value like `48` for custom time range
     - Add `test` with value `true` for test mode
   - Click **"Test"**

4. **View Results**:
   - The response will show the processing results
   - Check **"LOGS"** tab for detailed execution logs

### Using gcloud CLI

1. **Get your service URL**:
   ```bash
   gcloud run services describe gmail-invoice-scanner \
     --region us-central1 \
     --format 'value(status.url)'
   ```

2. **Trigger the workflow**:
   ```bash
   SERVICE_URL=$(gcloud run services describe gmail-invoice-scanner --region us-central1 --format 'value(status.url)')
   curl -X POST "${SERVICE_URL}/scan?hours=24"
   ```

3. **View logs in real-time**:
   ```bash
   gcloud run services logs read gmail-invoice-scanner \
     --region us-central1 \
     --limit 200
   ```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | integer | 24 | Number of hours to look back for emails |
| `test` | boolean | false | If `true`, skips sending forwarding emails |

### Examples

- **Scan last week**: `?hours=168`
- **Scan last month**: `?hours=720`
- **Test last 3 days**: `?hours=72&test=true`


## Monitoring

*   Check Cloud Run logs for execution details.
*   Check Google Sheet for logged invoices.

## Troubleshooting

### Error: `unauthorized_client`
See "Prerequisites" section about Redirect URI.

### Error: Missing OpenAI API Key
Ensure `OPENAI_API_KEY` is set in your `.env` file.

### No emails found
- Check that you have emails with attachments from the last 24 hours.
- Verify Gmail API is enabled in Google Cloud Console.
- Ensure your email is added as a test user in OAuth consent screen.
