require('dotenv').config();
const { saveInvoiceToDrive } = require('./src/drive');

async function testDriveUpload() {
    console.log('Testing Google Drive Upload...');

    const mockInvoiceData = {
        issue_date: '2023-11-21',
        seller_name: 'Test_Vendor_Inc',
        number: 'INV-12345'
    };

    const mockFileBuffer = Buffer.from('This is a test invoice content for Google Drive upload.', 'utf-8');
    const mockMimeType = 'text/plain'; // Using text/plain for simplicity, code handles mapping

    try {
        const link = await saveInvoiceToDrive(mockInvoiceData, mockFileBuffer, mockMimeType);
        if (link) {
            console.log('✅ Success! File uploaded to Drive.');
            console.log('🔗 Link:', link);
        } else {
            console.error('❌ Failed to upload file (returned null). Check logs for details.');
        }
    } catch (error) {
        console.error('❌ Error during test:', error);
    }
}

testDriveUpload();
