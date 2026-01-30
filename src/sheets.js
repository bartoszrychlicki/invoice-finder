const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const config = require('./config');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

/**
 * Normalizes a string for comparison (removes non-alphanumeric, lowercase).
 */
function normalizeString(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parses amount string to float.
 */
function parseAmount(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const clean = val.toString().replace(',', '.').replace(/[^\d.-]/g, '');
    return parseFloat(clean) || 0;
}

/**
 * Fetches all invoices from the spreadsheet.
 */
async function getAllInvoices(sheets, spreadsheetId) {
    try {
        const response = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'A:U',
        }));
        const rows = response.data.values || [];
        return rows.length > 0 && rows[0][0] === 'Timestamp' ? rows.slice(1) : rows;
    } catch (error) {
        logger.error("Error fetching invoices from Sheets", { error: error.message });
        return [];
    }
}

/**
 * Checks if an invoice already exists in the spreadsheet using a Scoring System.
 */
async function isDuplicate(sheets, spreadsheetId, data) {
    try {
        const dataRows = await getAllInvoices(sheets, spreadsheetId);
        logger.debug(`Checking for duplicates. Found ${dataRows.length} existing rows.`);

        const targetAmount = parseAmount(data.total_amount);
        const targetDate = data.issue_date;
        const targetNumberNorm = normalizeString(data.number);
        const targetSellerNorm = normalizeString(data.seller_tax_id);
        const targetBuyerNorm = normalizeString(data.buyer_tax_id);

        for (const row of dataRows) {
            const existingNumber = row[3];
            const existingIssueDate = row[4];
            const existingAmount = parseAmount(row[5]);
            const existingSellerTaxId = row[8];
            const existingBuyerTaxId = row[10];

            let score = 0;

            if (Math.abs(existingAmount - targetAmount) < 0.05) score += 40;
            if (existingIssueDate === targetDate) score += 30;
            if (targetNumberNorm && normalizeString(existingNumber) === targetNumberNorm) score += 20;
            if (targetSellerNorm && normalizeString(existingSellerTaxId) === targetSellerNorm) score += 20;
            // Buyer NIP match skip (0 pts as per original comment)

            if (score >= 60) {
                logger.debug(`Candidate match score: ${score}/100`, { number: existingNumber, date: existingIssueDate, amount: existingAmount });
            }

            if (score >= 80) {
                logger.info(`Duplicate detected (Score ${score})`, { number: data.number });
                return true;
            }
        }
        return false;
    } catch (error) {
        logger.error("Error checking for duplicates", { error: error.message });
        return false;
    }
}

/**
 * Logs invoice data to Google Sheets.
 */
async function logToSheet(data, emailInfo, injectedSheets = null, injectedSpreadsheetId = null, driveLink = '') {
    const auth = getOAuth2Client();
    const sheets = injectedSheets || google.sheets({ version: 'v4', auth });
    const spreadsheetId = injectedSpreadsheetId || config.spreadsheet_id;

    if (!spreadsheetId) {
        logger.warn("No SPREADSHEET_ID configured, skipping logging.");
        return { isDuplicate: false, logged: false };
    }

    // Check Sheet Duplicate
    const isSheetDuplicate = await isDuplicate(sheets, spreadsheetId, data);

    // Check Infakt Duplicate (passed from caller via emailInfo or separate arg, 
    // but better to keep signature compatible or use a new argument object).
    // For now, let's assume `data` might have an `infaktDuplicate` flag or we change signature.
    // The previous signature was: logToSheet(data, emailInfo, injectedSheets, injectedSpreadsheetId, driveLink)
    // To minimize breakage, let's check if `data.infaktDuplicate` is present.
    const isInfaktDuplicate = data.infaktDuplicate || false;

    let status = 'NEW';
    let duplicateType = null;

    if (data.forceLogStatus) {
        status = data.forceLogStatus;
        if (isSheetDuplicate) duplicateType = 'sheet'; // Still track type
    } else {
        if (isSheetDuplicate && isInfaktDuplicate) {
            status = 'DUPLICATE_BOTH';
            duplicateType = 'both';
        } else if (isSheetDuplicate) {
            status = 'DUPLICATE_SHEET';
            duplicateType = 'sheet';
        } else if (isInfaktDuplicate) {
            status = 'DUPLICATE_INFAKT';
            duplicateType = 'infakt';
        }
    }

    const row = [
        new Date().toISOString(),
        emailInfo.from,
        emailInfo.subject,
        data.number,
        data.issue_date,
        data.total_amount,
        data.currency,
        data.seller_name,
        data.seller_tax_id ? data.seller_tax_id.replace(/[\s-]/g, '') : '',
        data.buyer_name,
        data.buyer_tax_id ? data.buyer_tax_id.replace(/[\s-]/g, '') : '',
        emailInfo.messageId,
        status,
        data.items || '',
        data.justification || '',
        driveLink || '',
        data.payment_status || 'UNKNOWN',
        data.payment_due_date || '',
        data.bank_account ? data.bank_account.replace(/[\s-]/g, '') : '',
        data.seller_address || '',
        '',  // Approved - user will check manually
        '',  // Payment Date - filled when CSV is generated
        data.is_foreign ? 'TRUE' : 'FALSE'  // Column W - Foreign seller
    ];

    try {
        const appendResponse = await withRetry(() => sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Arkusz1!A:W',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [row],
            },
        }));

        // Verify the write was successful by checking the response
        const updatedRange = appendResponse.data.updates?.updatedRange;
        const updatedRows = appendResponse.data.updates?.updatedRows;

        if (!updatedRange || updatedRows !== 1) {
            logger.error(`Sheet write verification FAILED - API claimed success but no rows updated`, {
                number: data.number,
                updatedRange,
                updatedRows
            });

            // Send alert email
            await sendWriteFailureAlert(auth, data, 'API returned success but updatedRows !== 1');
            return { isDuplicate: !!duplicateType, logged: false, verificationFailed: true };
        }

        // Double-check by reading back the last row
        const verifyResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: updatedRange
        });

        const writtenRow = verifyResponse.data.values?.[0];
        const writtenNumber = writtenRow?.[3];

        // Normalize both numbers for comparison (Google Sheets may auto-format invoice numbers)
        const normalizedExpected = normalizeString(data.number);
        const normalizedActual = normalizeString(writtenNumber);

        // Check if numbers match after normalization OR if one contains the other
        // (handles cases like "1/01/2026" being formatted to "01/01/2026")
        const numbersMatch = normalizedActual === normalizedExpected ||
            normalizedActual.includes(normalizedExpected) ||
            normalizedExpected.includes(normalizedActual);

        if (!writtenRow || !numbersMatch) {
            logger.error(`Sheet write verification FAILED - data mismatch after write`, {
                number: data.number,
                expectedNumber: data.number,
                actualNumber: writtenNumber,
                normalizedExpected,
                normalizedActual
            });

            await sendWriteFailureAlert(auth, data, `Data mismatch: expected "${data.number}" but got "${writtenNumber}"`);
            return { isDuplicate: !!duplicateType, logged: false, verificationFailed: true };
        }

        logger.info(`Logged to Google Sheet (verified)`, { status, number: data.number, range: updatedRange });

        return {
            isDuplicate: !!duplicateType,
            duplicateType: duplicateType,
            logged: true
        };
    } catch (error) {
        logger.error(`Failed to log to Google Sheet after retries`, { error: error.message, number: data.number });

        // Send alert email on exception
        await sendWriteFailureAlert(auth, data, error.message);
        return { isDuplicate: !!duplicateType, logged: false };
    }
}

/**
 * Sends an email alert when sheet write verification fails.
 */
async function sendWriteFailureAlert(auth, data, reason) {
    const config = require('./config');
    const gmail = google.gmail({ version: 'v1', auth });
    const adminEmail = config.admin_email;

    if (!adminEmail) {
        logger.warn('No ADMIN_EMAIL configured, cannot send write failure alert');
        return;
    }

    const subject = `ALERT: Sheet Write Failure - ${data.number || 'Unknown Invoice'}`;
    const body = [
        `=== SHEET WRITE FAILURE ALERT ===`,
        ``,
        `Timestamp: ${new Date().toISOString()}`,
        `Invoice Number: ${data.number || 'N/A'}`,
        `Seller: ${data.seller_name || 'N/A'}`,
        `Amount: ${data.total_amount} ${data.currency}`,
        ``,
        `Failure Reason: ${reason}`,
        ``,
        `ACTION REQUIRED: Please manually verify this invoice in the spreadsheet.`,
        ``,
        `=== END OF ALERT ===`
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
        await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage }
        });
        logger.info(`Sent sheet write failure alert`, { to: adminEmail, invoice: data.number });
    } catch (e) {
        logger.error(`Failed to send write failure alert email`, { error: e.message });
    }
}

module.exports = { logToSheet, isDuplicate, normalizeString, parseAmount, getAllInvoices };
