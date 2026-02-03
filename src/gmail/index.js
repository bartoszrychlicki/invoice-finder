const { google } = require('googleapis');
const { getOAuth2Client } = require('../auth');
const { generateJustification } = require('../openai');
const { logToSheet, isDuplicate } = require('../sheets');
const { saveInvoiceToDrive } = require('../drive');
const { logExecution } = require('../audit_log');
const config = require('../config');
const pLimit = require('p-limit');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const { findEmails, ensureLabel } = require('./search');
const { processAttachment } = require('./attachment_processor');
const { validateBuyer } = require('./validator');
const { markEmailAsProcessed } = require('./post_processor');
const { sendInvoiceEmail, sendErrorEmail } = require('./notifier');
const { getAllInfaktInvoices, checkInfaktDuplicate } = require('../infakt/api');
const { wasSentToInfakt } = require('./sent_checker');

const gmail = google.gmail('v1');

/**
 * Scans emails for invoices and processes them.
 */
async function scanEmails(testMode = false, timeRange = 24) {
    const startTime = new Date();
    const auth = getOAuth2Client();
    const userId = 'me';
    const limit = pLimit(3);

    let processedLabelId = null;
    try {
        processedLabelId = await ensureLabel(auth, userId, 'invoice-processed');
    } catch (e) {
        logger.error('Failed to ensure label exists', { error: e.message });
    }

    // Fetch Infakt invoices if enabled
    let infaktInvoices = [];
    if (config.check_infakt_duplicates) {
        infaktInvoices = await getAllInfaktInvoices();
    }

    const errorLogs = [];
    const results = [];

    try {
        const messages = await findEmails(auth, userId, timeRange);
        logger.info(`Found ${messages.length} messages to scan.`);

        for (const message of messages) {
            try {
                const msgDetails = await withRetry(() => gmail.users.messages.get({
                    auth,
                    userId,
                    id: message.id,
                }));

                const payload = msgDetails.data.payload;
                const parts = payload.parts || [];
                const headers = payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name === 'From')?.value || '(Unknown Sender)';
                const to = headers.find(h => h.name === 'To')?.value || '';

                logger.info(`Processing message`, { subject, id: message.id });

                const targetEmail = config.target_email;
                if (targetEmail) {
                    const toAddresses = to.toLowerCase().split(',').map(addr => addr.trim());
                    if (toAddresses.length === 1 && toAddresses[0].includes(targetEmail.toLowerCase()) && subject.startsWith("Forwarded Invoice:")) {
                        logger.debug(`Skipping system-generated forwarded invoice`);
                        continue;
                    }
                }

                const invoiceKeywords = ['faktura', 'faktury', 'invoice', 'rachunek', 'paragon', 'inv', 'receipt', 'bill', 'dokument sprzedaży', 'dokument sprzedazy', 'fakturka', 'fv', 'korekta', 'korekty', 'credit memo'];
                const emailText = `${subject} ${from} ${to}`.toLowerCase();
                const attachmentFilenames = parts.filter(p => p.filename).map(p => p.filename.toLowerCase()).join(' ');
                const labelNames = (msgDetails.data.labelIds || []).join(' ').toLowerCase();

                const hasKeyword = invoiceKeywords.some(k => emailText.includes(k) || attachmentFilenames.includes(k) || labelNames.includes(k));

                if (!hasKeyword) {
                    logger.debug(`Skipping message: No invoice keywords found`);
                    continue;
                }

                const attachmentParts = parts.filter(p => p.filename && p.body && p.body.attachmentId);
                const attachmentTasks = attachmentParts.map(part => limit(() => processAttachment(auth, userId, { id: message.id, subject }, part, errorLogs)));

                const processedAttachments = (await Promise.all(attachmentTasks)).filter(a => a !== null);

                for (const item of processedAttachments) {
                    const { filename, mimeType, fileBuffer, analysis } = item;

                    if (analysis.is_invoice) {
                        logger.info(`Identified as INVOICE`, { filename });

                        const validation = validateBuyer(analysis, from, subject);
                        logger.info(`Buyer validation result`, {
                            filename,
                            isValid: validation.isValid,
                            reason: validation.reason,
                            expectedNip: validation.details.expectedNip,
                            foundNip: validation.details.foundNip,
                            expectedNames: validation.details.expectedNames,
                            foundName: validation.details.foundName
                        });
                        if (!validation.isValid) {
                            logger.info(`Skipping invoice: ${validation.reason}`, { buyer: analysis.data.buyer_name, buyerNip: analysis.data.buyer_tax_id });
                            continue;
                        }

                        // Check Infakt duplicate
                        const isInfaktDuplicateApi = config.check_infakt_duplicates ? checkInfaktDuplicate(analysis.data, infaktInvoices) : false;
                        const isSentToInfakt = await wasSentToInfakt(auth, filename);
                        const isInfaktDuplicate = isInfaktDuplicateApi || isSentToInfakt;

                        analysis.data.infaktDuplicate = isInfaktDuplicate;

                        const isSheetDuplicate = await isDuplicate(google.sheets({ version: 'v4', auth }), config.spreadsheet_id, analysis.data);

                        // Processing Condition: Process if NOT in Infakt (regardless of Sheet)
                        const shouldProcess = !isInfaktDuplicate;

                        let driveLink = '';
                        if (shouldProcess) {
                            logger.debug(`Generating justification for ${filename}`);
                            try {
                                analysis.data.justification = await generateJustification(analysis.data, config.business_context, config.justification_rules);
                            } catch (e) {
                                logger.error(`Justification error`, { filename, error: e.message });
                                errorLogs.push(`Justification error for ${filename}: ${e.message}`);
                                analysis.data.justification = 'Error';
                            }

                            logger.debug(`Saving to Google Drive`, { filename });
                            try {
                                driveLink = await saveInvoiceToDrive(analysis.data, fileBuffer, mimeType);
                            } catch (e) {
                                logger.error(`Drive error`, { filename, error: e.message });
                                errorLogs.push(`Drive error for ${filename}: ${e.message}`);
                            }
                        } else {
                            const reason = []
                            if (isInfaktDuplicate) reason.push('Infakt duplicate');
                            if (isSheetDuplicate) reason.push('Sheet duplicate'); // Informational
                            analysis.data.justification = `N/A (${reason.join(', ')})`;
                        }

                        // Determine status override for Sheet
                        if (shouldProcess && isSheetDuplicate) {
                            analysis.data.forceLogStatus = 'RESENT';
                        }

                        const sheetResult = await logToSheet(analysis.data, { from, subject, messageId: message.id }, null, null, driveLink);

                        // Send email if processed
                        if (sheetResult.logged && shouldProcess) {
                            if (!testMode) {
                                await sendInvoiceEmail(auth, filename, mimeType, fileBuffer, analysis.data);
                            } else {
                                logger.info(`TEST MODE: Skipping email send`, { filename });
                            }
                        }

                        // DISABLED: Don't archive invoices after processing - keep them in inbox
                        // if (sheetResult.logged) {
                        //     await markEmailAsProcessed(auth, userId, message.id, processedLabelId);
                        // }

                        results.push({
                            messageId: message.id,
                            file: filename,
                            status: sheetResult.isDuplicate ? 'duplicate' : 'processed',
                            duplicateType: sheetResult.duplicateType,
                            data: analysis.data
                        });
                    }
                }
            } catch (msgError) {
                logger.error(`Error processing message`, { id: message.id, error: msgError.message });
                errorLogs.push(`Error processing message ${message.id}: ${msgError.message}`);
            }
        }

        if (errorLogs.length > 0) {
            await sendErrorEmail(auth, errorLogs, startTime);
        }

        const endTime = new Date();
        const duration = (endTime - startTime) / 1000;

        await logExecution({
            status: errorLogs.length > 0 ? 'warning' : 'success',
            invoicesFound: results.length,
            duplicates: results.filter(r => r.status === 'duplicate').length,
            processed: results.filter(r => r.status === 'processed').length,
            duration
        });

        return results;
    } catch (error) {
        logger.error('Fatal error scanning emails', { error: error.message, stack: error.stack });
        errorLogs.push(`Fatal error during scan: ${error.message}`);
        try { await sendErrorEmail(auth, errorLogs, startTime); } catch (e) { }
        throw error;
    }
}

module.exports = { scanEmails };
