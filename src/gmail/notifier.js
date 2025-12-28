const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const gmail = google.gmail('v1');

async function sendInvoiceEmail(auth, filename, mimeType, fileBuffer, invoiceData) {
    const targetEmail = config.target_email;
    if (!targetEmail) {
        logger.warn("No TARGET_EMAIL configured, skipping email send.");
        return;
    }

    const registryUrl = config.registry_url || 'https://docs.google.com/spreadsheets/d/' + config.spreadsheet_id;

    const boundary = "foo_bar_baz";
    const messageParts = [
        `From: me`,
        `To: ${targetEmail}`,
        `Subject: Forwarded Invoice: ${filename}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        `Attached is an invoice processed by the AI Scanner.`,
        ``,
        `📄 Invoice Summary:`,
        `------------------`,
        `Seller: ${invoiceData.seller_name || 'N/A'} (NIP: ${invoiceData.seller_tax_id || 'N/A'})`,
        `Buyer: ${invoiceData.buyer_name || 'N/A'}`,
        `Date: ${invoiceData.issue_date || 'N/A'}`,
        `Amount: ${invoiceData.total_amount || '0.00'} ${invoiceData.currency || ''}`,
        ``,
        `📊 View in Registry:`,
        `${registryUrl}`,
        ``,
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        fileBuffer.toString('base64'),
        ``,
        `--${boundary}--`,
    ];

    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    try {
        await withRetry(() => gmail.users.messages.send({
            auth,
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        }));
        logger.info(`Sent invoice email`, { to: targetEmail, filename });
    } catch (error) {
        logger.error("Error sending invoice email", { error: error.message });
    }
}

async function sendErrorEmail(auth, errorLogs, startTime) {
    const adminEmail = config.admin_email;
    if (!adminEmail) {
        logger.warn("No ADMIN_EMAIL configured, skipping error email.");
        return;
    }

    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    const subject = `Invoice Scanner Error Report - ${endTime.toISOString().split('T')[0]}`;

    const body = [
        `=== INVOICE SCANNER ERROR REPORT ===`,
        ``,
        `Run Started: ${startTime.toISOString()}`,
        `Run Ended: ${endTime.toISOString()}`,
        `Duration: ${duration} seconds`,
        ``,
        `=== ERRORS ENCOUNTERED (${errorLogs.length}) ===`,
        ``,
        ...errorLogs.map((log, index) => `${index + 1}. ${log}`),
        ``,
        `=== DEBUGGING INSTRUCTIONS ===`,
        ``,
        `To debug these errors:`,
        `1. Check Cloud Run logs: gcloud run services logs read gmail-invoice-scanner --region us-central1 --limit 200`,
        `2. Review the error messages above for specific failure points`,
        ``,
        `=== END OF REPORT ===`
    ].join('\n');

    const rawMessage = [
        `From: me`,
        `To: ${adminEmail}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        body
    ].join('\r\n');

    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    try {
        await withRetry(() => gmail.users.messages.send({
            auth,
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        }));
        logger.info(`Sent error report email`, { to: adminEmail });
    } catch (error) {
        logger.error("Failed to send error report email", { error: error.message });
    }
}

module.exports = { sendInvoiceEmail, sendErrorEmail };
