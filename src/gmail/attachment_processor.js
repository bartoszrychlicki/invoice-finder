const { google } = require('googleapis');
const { analyzeAttachment } = require('../openai');
const { convertPdfToImage, decryptPdf } = require('../pdf');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const gmail = google.gmail('v1');

/**
 * Processes a single attachment.
 */
async function processAttachment(auth, userId, message, part, errorLogs) {
    const mimeType = part.mimeType;
    const isPdf = mimeType === 'application/pdf' || (mimeType === 'application/octet-stream' && part.filename.toLowerCase().endsWith('.pdf'));
    const subject = message.subject;

    if (part.body.size && part.body.size < 20000) {
        logger.debug(`Skipping small file`, { filename: part.filename, size: part.body.size });
        return null;
    }

    logger.debug(`Processing attachment`, { filename: part.filename, mimeType });

    try {
        const attachment = await withRetry(() => gmail.users.messages.attachments.get({
            auth,
            userId,
            messageId: message.id,
            id: part.body.attachmentId,
        }));

        const fileBufferOriginal = Buffer.from(attachment.data.data, 'base64');
        let fileBuffer = fileBufferOriginal;
        let analysisBuffer = fileBuffer;
        let analysisMimeType = mimeType;

        if (isPdf) {
            logger.debug(`Converting PDF to Image`, { filename: part.filename });
            try {
                const conversionResult = await convertPdfToImage(fileBuffer, config.pdf_passwords || []);
                analysisBuffer = conversionResult.imageBuffer;
                analysisMimeType = 'image/png';
                logger.debug(`Conversion successful`);

                if (conversionResult.usedPassword) {
                    logger.debug(`PDF decrypted for storage`);
                    try {
                        fileBuffer = await decryptPdf(fileBuffer, conversionResult.usedPassword);
                    } catch (decryptError) {
                        logger.error(`Decryption failed`, { error: decryptError.message });
                    }
                }
            } catch (convError) {
                logger.error(`PDF Conversion failed`, { filename: part.filename, error: convError.message });
                errorLogs.push(`Error converting PDF ${part.filename} in email "${subject}": ${convError.message}`);
                return null;
            }
        }

        let analysis;
        try {
            analysis = await analyzeAttachment(analysisBuffer, analysisMimeType);
        } catch (aiError) {
            logger.error(`OpenAI Analysis failed`, { filename: part.filename, error: aiError.message });
            errorLogs.push(`Error analyzing attachment ${part.filename} in email "${subject}": ${aiError.message}`);
            return null;
        }

        if (!analysis || typeof analysis.is_invoice === 'undefined') {
            logger.warn(`Analysis failed or returned invalid data`, { filename: part.filename });
            errorLogs.push(`Analysis returned invalid data for ${part.filename} in email "${subject}"`);
            return null;
        }

        return {
            filename: part.filename,
            mimeType: mimeType,
            fileBuffer: fileBuffer,
            analysis: analysis
        };
    } catch (error) {
        logger.error(`Error processing attachment`, { filename: part.filename, error: error.message });
        errorLogs.push(`Error processing attachment ${part.filename}: ${error.message}`);
        return null;
    }
}

module.exports = { processAttachment };

module.exports = { processAttachment };
