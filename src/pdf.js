const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const tmp = require('tmp');

/**
 * Converts the first page of a PDF buffer to a PNG buffer using Ghostscript.
 * @param {Buffer} pdfBuffer 
 * @returns {Promise<Buffer>} PNG image buffer
 */
function convertPdfToImage(pdfBuffer) {
    return new Promise((resolve, reject) => {
        // Create temp file for PDF
        tmp.file({ postfix: '.pdf' }, (err, pdfPath, fd, cleanupCallback) => {
            if (err) return reject(err);

            // Write buffer to temp PDF file
            fs.writeFileSync(pdfPath, pdfBuffer);

            // Create temp file for output PNG
            const pngPath = pdfPath + '.png';

            // Ghostscript command to convert first page to PNG
            // -sDEVICE=png16m: 24-bit color PNG
            // -r300: 300 DPI (good quality for OCR/Vision)
            // -dFirstPage=1 -dLastPage=1: Only convert the first page
            const cmd = `gs -dQUIET -dSAFER -dBATCH -dNOPAUSE -dNOPROMPT -sDEVICE=png16m -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -r300 -dFirstPage=1 -dLastPage=1 -sOutputFile="${pngPath}" "${pdfPath}"`;

            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    cleanupCallback();
                    return reject(new Error(`Ghostscript error: ${error.message}`));
                }

                try {
                    if (fs.existsSync(pngPath)) {
                        const pngBuffer = fs.readFileSync(pngPath);

                        // Cleanup
                        fs.unlinkSync(pngPath);
                        cleanupCallback();

                        resolve(pngBuffer);
                    } else {
                        cleanupCallback();
                        reject(new Error('Output PNG file was not created by Ghostscript'));
                    }
                } catch (readError) {
                    cleanupCallback();
                    reject(readError);
                }
            });
        });
    });
}

module.exports = { convertPdfToImage };
