const config = require('./config');
const logger = require('./utils/logger');

/**
 * Generates a NestBank-compatible CSV file for bank transfers.
 * 
 * CSV Format (8 columns, semicolon-separated):
 * RACH_OBC;NAZWA;ADRES;RACHUNEK;BANK;KWOTA;TYTUL;DATA_ZLECENIA
 * 
 * @param {Array} invoices - Array of invoice objects from getApprovedUnpaidInvoices()
 * @returns {string} - CSV content ready for import
 */
function generateNestBankCSV(invoices) {
    const senderAccount = config.sender_bank_account;

    if (!senderAccount || senderAccount.length !== 26) {
        throw new Error(`Invalid sender_bank_account in config. Expected 26 digits, got: ${senderAccount?.length || 0}`);
    }

    const lines = [];
    const today = new Date();
    const dataZlecenia = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    for (const invoice of invoices) {
        const rachunek = sanitizeBankAccount(invoice.bankAccount);

        // Validate required fields - NRB must be 26 digits
        if (!rachunek || rachunek.length !== 26) {
            logger.warn(`Skipping invoice ${invoice.number}: invalid bank account (${rachunek?.length || 0} digits, expected 26)`);
            continue;
        }

        // Format fields according to NestBank spec
        const rach_obc = senderAccount; // 26 digits NRB
        const nazwa = formatNameField(invoice.sellerName);
        const adres = formatAddressField(invoice.sellerAddress);
        const bank = ''; // Optional, can be empty
        const kwota = formatAmount(invoice.totalAmount);
        const tytul = formatTitleField(invoice.number);

        // Build CSV line with semicolon separator (8 columns)
        const line = [
            rach_obc,
            nazwa,
            adres,
            rachunek,
            bank,
            kwota,
            tytul,
            dataZlecenia
        ].join(';');

        lines.push(line);
    }

    if (lines.length === 0) {
        return null;
    }

    // NestBank requires CRLF line endings
    return lines.join('\r\n') + '\r\n';
}

/**
 * Formats seller name for NAZWA field.
 * Max 2 lines of 35 characters each, separated by |
 */
function formatNameField(name) {
    if (!name) return '';

    // Remove any existing commas (CSV separator) and quotes
    const clean = name.replace(/[,;"]/g, ' ').trim();

    if (clean.length <= 35) {
        return clean;
    }

    // Split into two lines of max 35 chars each
    const words = clean.split(/\s+/);
    let line1 = '';
    let line2 = '';

    for (const word of words) {
        if (line1.length + word.length + 1 <= 35) {
            line1 += (line1 ? ' ' : '') + word;
        } else if (line2.length + word.length + 1 <= 35) {
            line2 += (line2 ? ' ' : '') + word;
        }
    }

    return line2 ? `${line1}|${line2}` : line1;
}

/**
 * Formats seller address for ADRES field.
 * Max 2 lines of 35 characters each, separated by |
 */
function formatAddressField(address) {
    if (!address) return '';

    // Remove any existing commas and quotes
    const clean = address.replace(/[,;"]/g, ' ').trim();

    if (clean.length <= 35) {
        return clean;
    }

    // Try to find natural break point (street|city)
    const parts = clean.split(/[,\n]+/).map(p => p.trim()).filter(p => p);

    if (parts.length >= 2) {
        const line1 = parts[0].substring(0, 35);
        const line2 = parts.slice(1).join(' ').substring(0, 35);
        return `${line1}|${line2}`;
    }

    // Fallback: just truncate
    return clean.substring(0, 70);
}

/**
 * Formats invoice number for TYTUL field.
 * Max 4 lines of 35 characters each, separated by |
 */
function formatTitleField(invoiceNumber) {
    if (!invoiceNumber) return 'Faktura';

    // Remove commas and quotes
    const clean = invoiceNumber.replace(/[,;"]/g, ' ').trim();
    const title = `Faktura ${clean}`;

    // Max 140 chars total (4 lines × 35)
    if (title.length <= 140) {
        return title;
    }

    return title.substring(0, 140);
}

/**
 * Formats amount in ZŁ.GR format (e.g., 211.59)
 */
function formatAmount(amount) {
    if (typeof amount !== 'number' || isNaN(amount)) {
        return '0.00';
    }
    return amount.toFixed(2);
}

/**
 * Sanitizes bank account number - removes all non-digits
 */
function sanitizeBankAccount(account) {
    if (!account) return '';
    return account.replace(/\D/g, '');
}

/**
 * Generates a filename for the CSV export.
 */
function generateCSVFilename() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `przelewy_${year}${month}${day}.csv`;
}

module.exports = {
    generateNestBankCSV,
    generateCSVFilename,
    formatNameField,
    formatAddressField,
    formatTitleField,
    formatAmount,
    sanitizeBankAccount
};
