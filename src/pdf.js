const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const tmp = require('tmp');

/**
 * Converts the first page of a PDF buffer to a PNG buffer using Ghostscript.
 * @param {Buffer} pdfBuffer 
 * @returns {Promise<Buffer>} PNG image buffer
 */
function convertPdfToImage(pdfBuffer, passwords = []) {
    return new Promise((resolve, reject) => {
        // Create temp file for PDF
        tmp.file({ postfix: '.pdf' }, async (err, pdfPath, fd, cleanupCallback) => {
            if (err) return reject(err);

            try {
                // Write buffer to temp PDF file
                fs.writeFileSync(pdfPath, pdfBuffer);

                // Create temp file for output PNG
                const pngPath = pdfPath + '.png';

                // Helper to run Ghostscript
                const runGhostscript = (password = null) => {
                    return new Promise((gsResolve, gsReject) => {
                        let passwordArg = '';
                        if (password) {
                            // Escape password for shell safety (basic)
                            const safePassword = password.replace(/"/g, '\\"');
                            passwordArg = `-sPDFPassword="${safePassword}"`;
                        }

                        const cmd = `gs -dQUIET -dSAFER -dBATCH -dNOPAUSE -dNOPROMPT -sDEVICE=png16m -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -r300 -dFirstPage=1 -dLastPage=1 ${passwordArg} -sOutputFile="${pngPath}" "${pdfPath}"`;

                        exec(cmd, (error, stdout, stderr) => {
                            if (error) {
                                return gsReject(new Error(`Ghostscript error: ${error.message}`));
                            }
                            if (fs.existsSync(pngPath)) {
                                gsResolve(true);
                            } else {
                                gsReject(new Error('Output PNG file was not created'));
                            }
                        });
                    });
                };

                // 1. Try without password
                try {
                    console.log('    -> Trying PDF conversion (no password)...');
                    await runGhostscript(null);
                } catch (noPassError) {
                    console.log('    -> Conversion failed without password. Trying password list...');

                    let success = false;
                    for (const password of passwords) {
                        try {
                            console.log(`    -> Trying password: ${password.substring(0, 2)}***...`); // Log masked
                            await runGhostscript(password);
                            success = true;
                            console.log('    -> Password accepted!');
                            break;
                        } catch (passError) {
                            // Continue to next password
                        }
                    }

                    if (!success) {
                        throw new Error('PDF Conversion failed: Unable to decrypt PDF with provided passwords.');
                    }
                }

                // Read result
                const pngBuffer = fs.readFileSync(pngPath);

                // Cleanup
                fs.unlinkSync(pngPath);
                cleanupCallback();

                resolve(pngBuffer);

            } catch (error) {
                cleanupCallback();
                reject(error);
            }
        });
    });
}

module.exports = { convertPdfToImage };
