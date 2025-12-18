const { google } = require('googleapis');
const { getOAuth2Client } = require('../auth');
const { generateJustification } = require('../openai');
const { logToSheet, isDuplicate } = require('../sheets');
const { saveInvoiceToDrive } = require('../drive');
const { logExecution } = require('../audit_log');
const config = require('../config');
const pLimit = require('p-limit');

const { findEmails, ensureLabel } = require('./search');
const { processAttachment } = require('./attachment_processor');
const { validateBuyer } = require('./validator');
const { markEmailAsProcessed } = require('./post_processor');
const { sendInvoiceEmail, sendErrorEmail } = require('./notifier');

const gmail = google.gmail('v1');

/**
 * Scans emails for invoices and processes them.
 */
async function scanEmails(testMode = false, timeRange = 24) {
    const startTime = new Date();
    const auth = getOAuth2Client();
    const userId = 'me';
    const limit = pLimit(3); // Limit to 3 concurrent attachment operations

    let processedLabelId = null;
    try {
        processedLabelId = await ensureLabel(auth, userId, 'invoice-processed');
    } catch (e) {
        console.error('Failed to ensure label exists:', e.message);
    }

    const errorLogs = [];
    const results = [];

    try {
        const messages = await findEmails(auth, userId, timeRange);
        console.log(`Found ${messages.length} messages.`);

        for (const message of messages) {
            try {
                const msgDetails = await gmail.users.messages.get({
                    auth,
                    userId,
                    id: message.id,
                });

                const payload = msgDetails.data.payload;
                const parts = payload.parts || [];
                const headers = payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name === 'From')?.value || '(Unknown Sender)';
                const to = headers.find(h => h.name === 'To')?.value || '';

                console.log(`Processing message: ${subject} (${message.id})`);

                const targetEmail = config.target_email;
                if (targetEmail) {
                    const toAddresses = to.toLowerCase().split(',').map(addr => addr.trim());
                    if (toAddresses.length === 1 && toAddresses[0].includes(targetEmail.toLowerCase()) && subject.startsWith("Forwarded Invoice:")) {
                        console.log(`  -> Skipping: System generated forwarded invoice`);
                        continue;
                    }
                }

                // Keyword filtering
                const invoiceKeywords = ['faktura', 'faktury', 'invoice', 'rachunek', 'paragon', 'inv', 'receipt', 'bill', 'dokument sprzedaży', 'dokument sprzedazy', 'fakturka', 'fv'];
                const emailText = `${subject} ${from} ${to}`.toLowerCase();
                const attachmentFilenames = parts.filter(p => p.filename).map(p => p.filename.toLowerCase()).join(' ');
                const labelNames = (msgDetails.data.labelIds || []).join(' ').toLowerCase();

                const hasKeyword = invoiceKeywords.some(k => emailText.includes(k) || attachmentFilenames.includes(k) || labelNames.includes(k));

                if (!hasKeyword) {
                    console.log(`  -> Skipping: No invoice keywords found`);
                    continue;
                }

                // Process attachments in parallel (limited)
                const attachmentParts = parts.filter(p => p.filename && p.body && p.body.attachmentId);
                const attachmentTasks = attachmentParts.map(part => limit(() => processAttachment(auth, userId, { id: message.id, subject }, part, errorLogs)));

                const processedAttachments = (await Promise.all(attachmentTasks)).filter(a => a !== null);

                for (const item of processedAttachments) {
                    const { filename, mimeType, fileBuffer, analysis } = item;

                    if (analysis.is_invoice) {
                        console.log(`    -> Identified as INVOICE: ${filename}`);

                        const validation = validateBuyer(analysis, from, subject);
                        if (!validation.isValid) {
                            console.log(`    -> SKIPPING: ${validation.reason}. Buyer: '${analysis.data.buyer_name}'`);
                            continue;
                        }

                        // Duplicate check
                        const duplicate = await isDuplicate(google.sheets({ version: 'v4', auth }), config.spreadsheet_id, analysis.data);

                        let driveLink = '';
                        if (!duplicate) {
                            console.log(`    -> Generating creative justification...`);
                            try {
                                analysis.data.justification = await generateJustification(analysis.data, config.business_context, config.justification_rules);
                            } catch (e) {
                                errorLogs.push(`Justification error for ${filename}: ${e.message}`);
                                analysis.data.justification = 'Error';
                            }

                            console.log(`    -> Saving to Google Drive...`);
                            try {
                                driveLink = await saveInvoiceToDrive(analysis.data, fileBuffer, mimeType);
                            } catch (e) {
                                errorLogs.push(`Drive error for ${filename}: ${e.message}`);
                            }
                        } else {
                            analysis.data.justification = 'N/A (duplikat)';
                        }

                        // Log to Sheets
                        const sheetResult = await logToSheet(analysis.data, { from, subject, messageId: message.id }, null, null, driveLink);

                        if (sheetResult.logged && !sheetResult.isDuplicate) {
                            if (!testMode) {
                                await sendInvoiceEmail(auth, filename, mimeType, fileBuffer, analysis.data);
                            } else {
                                console.log(`    -> TEST MODE: Skipping email send`);
                            }
                        }

                        if (sheetResult.logged) {
                            await markEmailAsProcessed(auth, userId, message.id, processedLabelId);
                        }

                        results.push({
                            messageId: message.id,
                            file: filename,
                            status: sheetResult.isDuplicate ? 'duplicate' : 'processed',
                            data: analysis.data
                        });
                    }
                }
            } catch (msgError) {
                console.error(`Error processing message ${message.id}:`, msgError);
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
        console.error('Fatal error scanning emails:', error);
        errorLogs.push(`Fatal error during scan: ${error.message}`);
        try { await sendErrorEmail(auth, errorLogs, startTime); } catch (e) { }
        throw error;
    }
}

module.exports = { scanEmails };
