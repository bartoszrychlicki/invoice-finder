const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const config = require('./config');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

// Column indices for new payment-related fields (0-indexed)
const COLUMN_INDEX = {
    TIMESTAMP: 0,
    NUMBER: 3,
    ISSUE_DATE: 4,
    TOTAL_AMOUNT: 5,
    CURRENCY: 6,
    SELLER_NAME: 7,
    SELLER_TAX_ID: 8,
    PAYMENT_STATUS: 16,       // Column Q
    PAYMENT_DUE_DATE: 17,     // Column R
    BANK_ACCOUNT: 18,         // Column S
    SELLER_ADDRESS: 19,       // Column T
    APPROVED: 20,             // Column U
    PAYMENT_DATE: 21          // Column V
};

/**
 * Gets all approved unpaid invoices that haven't been paid yet.
 * Returns invoices where:
 * - Payment Status = "UNPAID"
 * - Approved = TRUE (or "TRUE", checkbox)
 * - Payment Date is empty
 */
async function getApprovedUnpaidInvoices(injectedSheets = null, injectedSpreadsheetId = null) {
    const auth = getOAuth2Client();
    const sheets = injectedSheets || google.sheets({ version: 'v4', auth });
    const spreadsheetId = injectedSpreadsheetId || config.spreadsheet_id;

    try {
        const response = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'A:V',
        }));

        const rows = response.data.values || [];
        if (rows.length === 0) {
            return [];
        }

        // Skip header row
        const dataRows = rows[0][0] === 'Timestamp' ? rows.slice(1) : rows;
        const approvedUnpaid = [];

        dataRows.forEach((row, index) => {
            const paymentStatus = (row[COLUMN_INDEX.PAYMENT_STATUS] || '').toUpperCase();
            const approved = (row[COLUMN_INDEX.APPROVED] || '').toUpperCase();
            const paymentDate = row[COLUMN_INDEX.PAYMENT_DATE] || '';
            const bankAccount = row[COLUMN_INDEX.BANK_ACCOUNT] || '';

            // Check if approved AND unpaid AND not yet processed
            const isApproved = approved === 'TRUE' || approved === '1' || approved === 'TAK' || approved === 'YES';
            const isUnpaid = paymentStatus === 'UNPAID';
            const notProcessed = !paymentDate;
            const hasBankAccount = bankAccount.length >= 20; // Polish NRB is 26 digits

            if (isApproved && isUnpaid && notProcessed && hasBankAccount) {
                approvedUnpaid.push({
                    rowIndex: index + 2, // 1-indexed + header row
                    number: row[COLUMN_INDEX.NUMBER],
                    issueDate: row[COLUMN_INDEX.ISSUE_DATE],
                    totalAmount: parseFloat((row[COLUMN_INDEX.TOTAL_AMOUNT] || '0').toString().replace(',', '.')),
                    currency: row[COLUMN_INDEX.CURRENCY],
                    sellerName: row[COLUMN_INDEX.SELLER_NAME],
                    sellerTaxId: row[COLUMN_INDEX.SELLER_TAX_ID],
                    sellerAddress: row[COLUMN_INDEX.SELLER_ADDRESS] || '',
                    bankAccount: bankAccount,
                    paymentDueDate: row[COLUMN_INDEX.PAYMENT_DUE_DATE]
                });
            }
        });

        logger.info(`Found ${approvedUnpaid.length} approved unpaid invoices for payment`);
        return approvedUnpaid;
    } catch (error) {
        logger.error('Error fetching approved unpaid invoices', { error: error.message });
        throw error;
    }
}

/**
 * Validates that there are no duplicate invoice numbers in the list.
 * Returns { valid: boolean, duplicates: string[] }
 */
function validateNoDuplicatePayments(invoices) {
    const numbersSeen = new Set();
    const duplicates = [];

    for (const invoice of invoices) {
        const normalized = (invoice.number || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (numbersSeen.has(normalized)) {
            duplicates.push(invoice.number);
        } else {
            numbersSeen.add(normalized);
        }
    }

    return {
        valid: duplicates.length === 0,
        duplicates
    };
}

/**
 * Marks invoices as paid by setting Payment Date column.
 * @param {number[]} rowIndices - Array of row indices (1-indexed as in Sheets)
 */
async function markInvoicesAsPaid(rowIndices, injectedSheets = null, injectedSpreadsheetId = null) {
    const auth = getOAuth2Client();
    const sheets = injectedSheets || google.sheets({ version: 'v4', auth });
    const spreadsheetId = injectedSpreadsheetId || config.spreadsheet_id;

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const requests = rowIndices.map(rowIndex => ({
        range: `Arkusz1!V${rowIndex}`,
        values: [[today]]
    }));

    try {
        await withRetry(() => sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        }));

        logger.info(`Marked ${rowIndices.length} invoices as paid`, { rowIndices, date: today });
        return true;
    } catch (error) {
        logger.error('Error marking invoices as paid', { error: error.message });
        throw error;
    }
}

module.exports = {
    getApprovedUnpaidInvoices,
    validateNoDuplicatePayments,
    markInvoicesAsPaid,
    COLUMN_INDEX
};
