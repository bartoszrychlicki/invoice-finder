const { google } = require('googleapis');
const { analyzeAttachment } = require('../openai');
const { convertPdfToImage, decryptPdf } = require('../pdf');
const config = require('../config');

const gmail = google.gmail('v1');

/**
 * Processes a single attachment.
 */
async function processAttachment(auth, userId, message, part, errorLogs) {
    const mimeType = part.mimeType;
    const isPdf = mimeType === 'application/pdf' || (mimeType === 'application/octet-stream' && part.filename.toLowerCase().endsWith('.pdf'));
    const subject = message.subject;

    // Skip small files (icons, logos, footers) < 20KB
    if (part.body.size && part.body.size < 20000) {
        console.log(`  -> Skipping small file: ${part.filename} (${part.body.size} bytes)`);
        return null;
    }

    console.log(`  Found attachment: ${part.filename} (${mimeType})`);

    const attachment = await gmail.users.messages.attachments.get({
        auth,
        userId,
        messageId: message.id,
        id: part.body.attachmentId,
    });

    const fileBufferOriginal = Buffer.from(attachment.data.data, 'base64');
    let fileBuffer = fileBufferOriginal;
    let analysisBuffer = fileBuffer;
    let analysisMimeType = mimeType;

    // Convert PDF to Image for OpenAI Vision
    if (isPdf) {
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
                }
            }
        } catch (convError) {
            console.error(`    -> PDF Conversion failed: ${convError.message}`);
            errorLogs.push(`Error converting PDF ${part.filename} in email "${subject}": ${convError.message}`);
            return null;
        }
    }

    // Analyze with OpenAI
    let analysis;
    try {
        analysis = await analyzeAttachment(analysisBuffer, analysisMimeType);
    } catch (aiError) {
        console.error(`    -> OpenAI Analysis failed: ${aiError.message}`);
        errorLogs.push(`Error analyzing attachment ${part.filename} in email "${subject}": ${aiError.message}`);
        return null;
    }

    if (!analysis || typeof analysis.is_invoice === 'undefined') {
        console.log(`    -> Analysis failed or returned invalid data`);
        errorLogs.push(`Analysis returned invalid data for ${part.filename} in email "${subject}"`);
        return null;
    }

    return {
        filename: part.filename,
        mimeType: mimeType,
        fileBuffer: fileBuffer,
        analysis: analysis
    };
}

module.exports = { processAttachment };
