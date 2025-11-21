const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const stream = require('stream');

/**
 * Ensures a folder exists in Google Drive.
 * @param {Object} drive - Google Drive API instance.
 * @param {string} folderName - The name of the folder to check/create.
 * @param {string} [parentId] - Optional parent folder ID.
 * @returns {Promise<string>} - The ID of the folder.
 */
async function ensureFolder(drive, folderName, parentId = null) {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    try {
        const res = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files.length > 0) {
            console.log(`  -> Found existing folder: ${folderName} (${res.data.files[0].id})`);
            return res.data.files[0].id;
        } else {
            console.log(`  -> Creating new folder: ${folderName}`);
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };
            if (parentId) {
                fileMetadata.parents = [parentId];
            }
            const file = await drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            });
            return file.data.id;
        }
    } catch (error) {
        console.error(`Error ensuring folder '${folderName}':`, error);
        throw error;
    }
}

/**
 * Uploads a file to Google Drive.
 * @param {Object} drive - Google Drive API instance.
 * @param {string} folderId - The ID of the folder to upload to.
 * @param {string} fileName - The name of the file.
 * @param {Buffer} fileBuffer - The file content.
 * @param {string} mimeType - The MIME type of the file.
 * @returns {Promise<string>} - The web view link of the uploaded file.
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
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
        });
        console.log(`  -> Uploaded file: ${fileName} (ID: ${file.data.id})`);
        return file.data.webViewLink;
    } catch (error) {
        console.error(`Error uploading file '${fileName}':`, error);
        throw error;
    }
}

/**
 * Saves an invoice to Google Drive.
 * Folder structure: MM-YYYY
 * File name: DD-MM-YYYY-[seller_name].ext
 * @param {Object} invoiceData - Extracted invoice data.
 * @param {Buffer} fileBuffer - The original file buffer.
 * @param {string} originalMimeType - The MIME type of the original file.
 * @returns {Promise<string>} - The Drive link to the saved file.
 */
async function saveInvoiceToDrive(invoiceData, fileBuffer, originalMimeType) {
    const auth = getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    try {
        // 1. Determine Folder Name (MM-YYYY)
        let dateObj = new Date();
        if (invoiceData.issue_date) {
            // Try to parse issue_date (YYYY-MM-DD)
            const parts = invoiceData.issue_date.split('-');
            if (parts.length === 3) {
                dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            }
        }

        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const year = dateObj.getFullYear();
        const folderName = `${month}-${year}`;

        // 2. Ensure Folder Exists
        // ID provided by user: 1PBhAFPX5a8Y3ToHhQ_-3JPofC358xgNf
        const parentFolderId = process.env.DRIVE_PARENT_FOLDER_ID || '1PBhAFPX5a8Y3ToHhQ_-3JPofC358xgNf';
        const folderId = await ensureFolder(drive, folderName, parentFolderId);

        // 3. Determine File Name
        // Format: DD-MM-YYYY-[seller_name].ext
        const day = String(dateObj.getDate()).padStart(2, '0');
        const sellerName = (invoiceData.seller_name || 'Unknown').replace(/[^a-zA-Z0-9-_]/g, '_'); // Sanitize

        // Determine extension
        let ext = 'dat';
        if (originalMimeType === 'application/pdf') ext = 'pdf';
        else if (originalMimeType === 'image/jpeg') ext = 'jpg';
        else if (originalMimeType === 'image/png') ext = 'png';

        const fileName = `${day}-${month}-${year}-${sellerName}.${ext}`;

        // 4. Upload File
        const webViewLink = await uploadFile(drive, folderId, fileName, fileBuffer, originalMimeType);

        return webViewLink;

    } catch (error) {
        console.error("Error saving invoice to Drive:", error);
        return null; // Return null so we don't break the whole flow, just log the error
    }
}

module.exports = { saveInvoiceToDrive };
