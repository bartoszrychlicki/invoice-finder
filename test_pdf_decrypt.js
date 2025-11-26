const { convertPdfToImage, decryptPdf } = require('./src/pdf');
const fs = require('fs');
const path = require('path');

// Create a dummy PDF (minimal valid PDF structure)
const dummyPdfPath = path.join(__dirname, 'test_decrypt.pdf');
const dummyPdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 21 >>
stream
BT /F1 24 Tf 100 700 Td (Hello World) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000224 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
295
%%EOF`;

fs.writeFileSync(dummyPdfPath, dummyPdfContent);

async function test() {
    try {
        console.log('Testing PDF conversion (non-protected)...');
        const buffer = fs.readFileSync(dummyPdfPath);
        const result = await convertPdfToImage(buffer, ['WRONG_PASS']);

        if (result.imageBuffer && result.imageBuffer.length > 0) {
            console.log('SUCCESS: Converted non-protected PDF.');
            console.log('Used Password:', result.usedPassword);
        } else {
            console.error('FAILURE: Empty buffer returned.');
        }

        console.log('\nTesting Decryption (non-protected)...');
        const decrypted = await decryptPdf(buffer, null);
        if (decrypted.length > 0) {
            console.log('SUCCESS: Decryption handled null password correctly.');
        }

    } catch (error) {
        console.error('FAILURE:', error);
    } finally {
        if (fs.existsSync(dummyPdfPath)) fs.unlinkSync(dummyPdfPath);
    }
}

test();
