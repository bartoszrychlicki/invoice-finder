const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const { analyzeAttachment, generateJustification } = require('./openai');
const { logToSheet, isDuplicate } = require('./sheets');
const { convertPdfToImage } = require('./pdf');

const gmail = google.gmail('v1');

/**
 * Scans emails from the current day for attachments, analyzes them,
 * and processes invoices.
 */
async function scanEmails() {
    const auth = getOAuth2Client();
    const userId = 'me';

    // Get timestamp for 24 hours ago to ensure full daily coverage
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const after = Math.floor(oneDayAgo.getTime() / 1000);

    // Search for emails with attachments AND invoice-related keywords
    const keywords = '(faktura OR faktury OR invoice OR rachunek OR paragon OR inv)';
    const query = `has:attachment after:${after} ${keywords}`;
    console.log(`Searching for emails with query: ${query}`);

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

            // Double-check: verify email contains invoice keywords
            // (Gmail query should already filter, but this is extra safety)
            const invoiceKeywords = ['faktura', 'faktury', 'invoice', 'rachunek', 'paragon', 'inv'];
            const emailText = `${subject} ${from} ${to}`.toLowerCase();
            const hasInvoiceKeyword = invoiceKeywords.some(keyword => emailText.includes(keyword));

            if (!hasInvoiceKeyword) {
                console.log(`  -> Skipping: No invoice keywords found in subject/from/to`);
                continue;
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
                                analysisBuffer = await convertPdfToImage(fileBuffer);
                                analysisMimeType = 'image/png';
                                console.log(`    -> Conversion successful.`);
                            } catch (convError) {
                                console.error(`    -> PDF Conversion failed: ${convError.message}`);
                                continue; // Skip this attachment if conversion fails
                            }
                        }

                        // Analyze with OpenAI (using the image buffer)
                        const analysis = await analyzeAttachment(analysisBuffer, analysisMimeType);

                        // Check if analysis is valid
                        if (!analysis || typeof analysis.is_invoice === 'undefined') {
                            console.log(`    -> Analysis failed or returned invalid data`);
                            continue;
                        }

                        if (analysis.is_invoice) {
                            console.log(`    -> Identified as INVOICE. Data:`, analysis.data);

                            // Check for duplicates FIRST (to save OpenAI tokens on justification)
                            const auth = await getOAuth2Client();
                            const sheets = google.sheets({ version: 'v4', auth });
                            const spreadsheetId = process.env.SPREADSHEET_ID;

                            const duplicate = await isDuplicate(sheets, spreadsheetId, analysis.data);

                            // Only generate justification if NOT a duplicate
                            if (!duplicate) {
                                console.log(`    -> Generating creative justification...`);
                                const justification = await generateJustification(analysis.data, process.env.BUSINESS_CONTEXT);
                                analysis.data.justification = justification;
                                console.log(`    -> Justification: ${justification}`);
                            } else {
                                console.log(`    -> Skipping justification generation (duplicate detected)`);
                                analysis.data.justification = 'N/A (duplikat)';
                            }

                            // Log to Sheets (returns duplicate status)
                            const sheetResult = await logToSheet(analysis.data, { from, subject, messageId: message.id });

                            // Check if buyer NIP matches (normalize both for comparison)
                            const expectedBuyerNip = process.env.BUYER_TAX_ID?.replace(/[^0-9]/g, '') || '';
                            const actualBuyerNip = analysis.data.buyer_tax_id?.replace(/[^0-9]/g, '') || '';
                            const nipMatches = expectedBuyerNip && actualBuyerNip === expectedBuyerNip;

                            // Only send email if NOT a duplicate AND buyer NIP matches
                            if (!sheetResult.isDuplicate && nipMatches) {
                                console.log(`    -> Sending email (new invoice with matching buyer NIP)...`);
                                await sendInvoiceEmail(auth, part.filename, mimeType, fileBuffer, analysis.data);
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
        }
        return results;
    } catch (error) {
        console.error('Error scanning emails:', error);
        throw error;
    }
}

async function sendInvoiceEmail(auth, filename, mimeType, fileBuffer, invoiceData) {
    const targetEmail = process.env.TARGET_EMAIL;
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

module.exports = { scanEmails };
