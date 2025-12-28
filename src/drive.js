const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const stream = require('stream');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

/**
 * Ensures a folder exists in Google Drive.
 */
async function ensureFolder(drive, folderName, parentId = null) {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    try {
        const res = await withRetry(() => drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        }));

        if (res.data.files.length > 0) {
            logger.debug(`Found existing folder`, { folderName, id: res.data.files[0].id });
            return res.data.files[0].id;
        } else {
            logger.info(`Creating new folder`, { folderName });
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };
            if (parentId) {
                fileMetadata.parents = [parentId];
            }
            const file = await withRetry(() => drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            }));
            return file.data.id;
        }
    } catch (error) {
        logger.error(`Error ensuring folder`, { folderName, error: error.message });
        throw error;
    }
}

/**
 * Uploads a file to Google Drive.
 */
async function uploadFile(drive, folderId, fileName, fileBuffer, mimeType) {
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    const fileMetadata = {
        name: fileName,
        parents: [folderId],
    };
    const media = {
        mimeType: mimeType,
        body: bufferStream,
    };

    try {
        const file = await withRetry(() => drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
        }));
        logger.info(`Uploaded file to Drive`, { fileName, id: file.data.id });
        return file.data.webViewLink;
    } catch (error) {
        logger.error(`Error uploading file to Drive`, { fileName, error: error.message });
        throw error;
    }
}

/**
 * Saves an invoice to Google Drive.
 */
async function saveInvoiceToDrive(invoiceData, fileBuffer, originalMimeType) {
    const auth = getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    try {
        let dateObj = new Date();
        if (invoiceData.issue_date) {
            const parts = invoiceData.issue_date.split('-');
            if (parts.length === 3) {
                dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            }
        }

        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const year = dateObj.getFullYear();
        const folderName = `${month}-${year}`;

        const parentFolderId = process.env.DRIVE_PARENT_FOLDER_ID || '1PBhAFPX5a8Y3ToHhQ_-3JPofC358xgNf';
        const folderId = await ensureFolder(drive, folderName, parentFolderId);

        const day = String(dateObj.getDate()).padStart(2, '0');
        const sellerName = (invoiceData.seller_name || 'Unknown').replace(/[^a-zA-Z0-9-_]/g, '_');

        let ext = 'dat';
        if (originalMimeType === 'application/pdf') ext = 'pdf';
        else if (originalMimeType === 'image/jpeg') ext = 'jpg';
        else if (originalMimeType === 'image/png') ext = 'png';

        const fileName = `${day}-${month}-${year}-${sellerName}.${ext}`;
        const webViewLink = await uploadFile(drive, folderId, fileName, fileBuffer, originalMimeType);

        return webViewLink;
    } catch (error) {
        logger.error("Error saving invoice to Drive", { error: error.message });
        return null;
    }
}

module.exports = { saveInvoiceToDrive };
