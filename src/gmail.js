const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const { analyzeAttachment, generateJustification } = require('./openai');
const { logToSheet, isDuplicate } = require('./sheets');
const { convertPdfToImage, decryptPdf } = require('./pdf');
const { saveInvoiceToDrive } = require('./drive');
const config = require('./config');

const gmail = google.gmail('v1');

/**
 * Scans emails from the current day for attachments, analyzes them,
 * and processes invoices.
 * @param {boolean} testMode - If true, skips sending emails.
 */
async function scanEmails(testMode = false) {
    const startTime = new Date();
    const auth = getOAuth2Client();
    const userId = 'me';

    // Get timestamp for 24 hours ago to ensure full daily coverage
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const after = Math.floor(oneDayAgo.getTime() / 1000);

    // Search for emails with attachments (broader search - we'll filter by filename too)
    // Expanded keywords to catch more invoice-related emails
    const keywords = '(faktura OR faktury OR invoice OR rachunek OR paragon OR inv OR receipt OR bill OR "dokument sprzedaży" OR "dokument zakupu" OR "potwierdzenie zakupu")';
    const query = `has:attachment after:${after} ${keywords}`;
    console.log(`Searching for emails with query: ${query}`);

    const errorLogs = [];

    try {
        const res = await gmail.users.messages.list({
            auth,
            userId,
            q: query,
        });

        const messages = res.data.messages || [];
        console.log(`Found ${messages.length} messages.`);

        const results = [];

        for (const message of messages) {
            try {
                const msgDetails = await gmail.users.messages.get({
                    auth,
                    userId,
                    id: message.id,
                });

                const parts = msgDetails.data.payload.parts || [];
                const headers = msgDetails.data.payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name === 'From')?.value || '(Unknown Sender)';
                const to = headers.find(h => h.name === 'To')?.value || '';

                console.log(`Processing message: ${subject} (${message.id})`);

                // Skip emails sent to TARGET_EMAIL (forwarded invoices from this system)
                const targetEmail = config.target_email;
                if (targetEmail && to.toLowerCase().includes(targetEmail.toLowerCase())) {
                    console.log(`  -> Skipping: Email sent to TARGET_EMAIL (${targetEmail}) - avoiding re-scan of forwarded invoice`);
                    continue;
                }

                // Check if email or attachments contain invoice keywords
                const invoiceKeywords = ['faktura', 'faktury', 'invoice', 'rachunek', 'paragon', 'inv', 'receipt', 'bill'];
                const emailText = `${subject} ${from} ${to}`.toLowerCase();
                const hasInvoiceKeywordInEmail = invoiceKeywords.some(keyword => emailText.includes(keyword));

                // Check attachment filenames for invoice keywords
                const attachmentFilenames = parts
                    .filter(p => p.filename && p.body && p.body.attachmentId)
                    .map(p => p.filename.toLowerCase())
                    .join(' ');
                const hasInvoiceKeywordInFilename = invoiceKeywords.some(keyword => attachmentFilenames.includes(keyword));

                // Check Gmail labels for invoice keywords
                const labels = msgDetails.data.labelIds || [];
                const labelNames = labels.join(' ').toLowerCase();
                const hasInvoiceKeywordInLabels = invoiceKeywords.some(keyword => labelNames.includes(keyword));

                // Process if keywords found in email OR in attachment filenames OR in labels
                if (!hasInvoiceKeywordInEmail && !hasInvoiceKeywordInFilename && !hasInvoiceKeywordInLabels) {
                    console.log(`  -> Skipping: No invoice keywords found in subject/from/to, attachment filenames, or labels`);
                    continue;
                }

                if (hasInvoiceKeywordInFilename && !hasInvoiceKeywordInEmail) {
                    console.log(`  -> Invoice keyword found in attachment filename (not in subject/from/to)`);
                }
                if (hasInvoiceKeywordInLabels && !hasInvoiceKeywordInEmail && !hasInvoiceKeywordInFilename) {
                    console.log(`  -> Invoice keyword found in Gmail labels`);
                }

                for (const part of parts) {
                    if (part.filename && part.body && part.body.attachmentId) {
                        const mimeType = part.mimeType;
                        // Filter for PDF or Images
                        if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
                            // Skip small files (icons, logos, footers) < 20KB
                            if (part.body.size && part.body.size < 20000) {
                                console.log(`  -> Skipping small file: ${part.filename} (${part.body.size} bytes)`);
                                continue;
                            }
                            console.log(`  Found attachment: ${part.filename} (${mimeType})`);

                            const attachment = await gmail.users.messages.attachments.get({
                                auth,
                                userId,
                                messageId: message.id,
                                id: part.body.attachmentId,
                            });

                            const fileBuffer = Buffer.from(attachment.data.data, 'base64');
                            let analysisBuffer = fileBuffer;
                            let analysisMimeType = mimeType;

                            // Convert PDF to Image for OpenAI Vision
                            if (mimeType === 'application/pdf') {
                                console.log(`    -> Converting PDF to Image for analysis...`);
                                try {
                                    const conversionResult = await convertPdfToImage(fileBuffer, config.pdf_passwords || []);
                                    analysisBuffer = conversionResult.imageBuffer;
                                    analysisMimeType = 'image/png';
                                    console.log(`    -> Conversion successful.`);

                                    if (conversionResult.usedPassword) {
                                        console.log(`    -> PDF was password protected. Decrypting for storage...`);
                                        try {
                                            fileBuffer = await decryptPdf(fileBuffer, conversionResult.usedPassword);
                                            console.log(`    -> Decryption successful. File will be saved without password.`);
                                        } catch (decryptError) {
                                            console.error(`    -> Decryption failed: ${decryptError.message}. Saving original file.`);
                                            // Don't treat this as a fatal error for the email report, just log it
                                        }
                                    }
                                } catch (convError) {
                                    console.error(`    -> PDF Conversion failed: ${convError.message}`);
                                    errorLogs.push(`Error converting PDF ${part.filename} in email "${subject}": ${convError.message}`);
                                    continue; // Skip this attachment if conversion fails
                                }
                            }

                            // Analyze with OpenAI (using the image buffer)
                            let analysis;
                            try {
                                analysis = await analyzeAttachment(analysisBuffer, analysisMimeType);
                            } catch (aiError) {
                                console.error(`    -> OpenAI Analysis failed: ${aiError.message}`);
                                errorLogs.push(`Error analyzing attachment ${part.filename} in email "${subject}": ${aiError.message}`);
                                continue;
                            }

                            // Check if analysis is valid
                            if (!analysis || typeof analysis.is_invoice === 'undefined') {
                                console.log(`    -> Analysis failed or returned invalid data`);
                                errorLogs.push(`Analysis returned invalid data for ${part.filename} in email "${subject}"`);
                                continue;
                            }

                            if (analysis.is_invoice) {
                                console.log(`    -> Identified as INVOICE. Data:`, analysis.data);

                                // Check for duplicates FIRST (to save OpenAI tokens on justification)
                                const auth = await getOAuth2Client();
                                const sheets = google.sheets({ version: 'v4', auth });
                                const spreadsheetId = config.spreadsheet_id;

                                const duplicate = await isDuplicate(sheets, spreadsheetId, analysis.data);

                                // Only generate justification if NOT a duplicate
                                let driveLink = '';
                                if (!duplicate) {
                                    console.log(`    -> Generating creative justification...`);
                                    try {
                                        const justification = await generateJustification(analysis.data, config.business_context, config.justification_rules);
                                        analysis.data.justification = justification;
                                        console.log(`    -> Justification: ${justification}`);
                                    } catch (justError) {
                                        console.error(`    -> Justification generation failed: ${justError.message}`);
                                        errorLogs.push(`Error generating justification for ${part.filename}: ${justError.message}`);
                                        analysis.data.justification = 'Error generating justification';
                                    }

                                    // Save to Google Drive
                                    console.log(`    -> Saving to Google Drive...`);
                                    try {
                                        driveLink = await saveInvoiceToDrive(analysis.data, fileBuffer, mimeType);
                                        if (driveLink) {
                                            console.log(`    -> Saved to Drive: ${driveLink}`);
                                        }
                                    } catch (driveError) {
                                        console.error(`    -> Drive save failed: ${driveError.message}`);
                                        errorLogs.push(`Error saving to Drive for ${part.filename}: ${driveError.message}`);
                                    }
                                } else {
                                    console.log(`    -> Skipping justification generation (duplicate detected)`);
                                    analysis.data.justification = 'N/A (duplikat)';
                                }

                                // Log to Sheets (returns duplicate status)
                                const sheetResult = await logToSheet(analysis.data, { from, subject, messageId: message.id }, null, null, driveLink);

                                if (!sheetResult.logged) {
                                    errorLogs.push(`Failed to log invoice to Sheets for ${part.filename} in email "${subject}"`);
                                }

                                // Check if buyer NIP matches (normalize both for comparison)
                                const expectedBuyerNip = config.buyer_tax_id?.replace(/[^0-9]/g, '') || '';
                                const actualBuyerNip = analysis.data.buyer_tax_id?.replace(/[^0-9]/g, '') || '';
                                const nipMatches = expectedBuyerNip && actualBuyerNip === expectedBuyerNip;

                                // Only send email if logged successfully AND NOT a duplicate AND buyer NIP matches
                                if (sheetResult.logged && !sheetResult.isDuplicate && nipMatches) {
                                    if (testMode) {
                                        console.log(`    -> TEST MODE: Skipping email send for ${part.filename}`);
                                    } else {
                                        console.log(`    -> Sending email (new invoice with matching buyer NIP)...`);
                                        try {
                                            await sendInvoiceEmail(auth, part.filename, mimeType, fileBuffer, analysis.data);
                                        } catch (emailError) {
                                            console.error(`    -> Email send failed: ${emailError.message}`);
                                            errorLogs.push(`Error sending invoice email for ${part.filename}: ${emailError.message}`);
                                        }
                                    }
                                } else if (!sheetResult.logged) {
                                    console.error(`    -> Skipping email send (FAILED to log to Google Sheets)`);
                                } else if (sheetResult.isDuplicate) {
                                    console.log(`    -> Skipping email send (duplicate detected)`);
                                } else if (!nipMatches) {
                                    console.log(`    -> Skipping email send (buyer NIP does not match: expected ${expectedBuyerNip}, got ${actualBuyerNip})`);
                                }

                                results.push({
                                    messageId: message.id,
                                    file: part.filename,
                                    status: sheetResult.isDuplicate ? 'duplicate' : 'processed',
                                    data: analysis.data
                                });
                            } else {
                                console.log(`    -> Not an invoice.`);
                            }
                        }
                    }
                }
            } catch (msgError) {
                console.error(`Error processing message ${message.id}:`, msgError);
                errorLogs.push(`Error processing message ${message.id}: ${msgError.message}`);
            }
        }

        if (errorLogs.length > 0) {
            console.log(`Errors encountered during scan. Sending error report...`);
            await sendErrorEmail(auth, errorLogs, startTime);
        }

        return results;
    } catch (error) {
        console.error('Fatal error scanning emails:', error);
        errorLogs.push(`Fatal error during scan: ${error.message}`);
        try {
            await sendErrorEmail(auth, errorLogs, startTime);
        } catch (sendErr) {
            console.error("Failed to send fatal error email:", sendErr);
        }
        throw error;
    }
}

async function sendInvoiceEmail(auth, filename, mimeType, fileBuffer, invoiceData) {
    const targetEmail = config.target_email;
    if (!targetEmail) {
        console.warn("No TARGET_EMAIL configured, skipping email send.");
        return;
    }

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
        `https://docs.google.com/spreadsheets/d/1uhyd9OBXjWRL2zFgbrBoMI9llnne1ncmXAxIsIx4De4/edit?usp=sharing`,
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
        await gmail.users.messages.send({
            auth,
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        });
        console.log(`Sent invoice email to ${targetEmail}`);
    } catch (error) {
        console.error("Error sending email:", error);
    }
}

async function sendErrorEmail(auth, errorLogs, startTime) {
    const adminEmail = config.admin_email;
    if (!adminEmail) {
        console.warn("No ADMIN_EMAIL configured, skipping error email.");
        return;
    }

    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // Use plain text subject without emoji to avoid encoding issues
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
        `3. Common issues:`,
        `   - PDF conversion failures: Check if PDF is password-protected or corrupted`,
        `   - OpenAI API errors: Verify API key and rate limits`,
        `   - Google Sheets/Drive errors: Check OAuth token validity`,
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
        await gmail.users.messages.send({
            auth,
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        });
        console.log(`Sent error report email to ${adminEmail}`);
    } catch (error) {
        console.error("Failed to send error report email:", error);
    }
}

module.exports = { scanEmails, sendErrorEmail };
