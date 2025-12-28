const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');
const { normalizeString, parseAmount } = require('../sheets'); // Will need to ensure these are exported from sheets.js

const INFAKT_API_URL = 'https://app.infakt.pl/api/v3';

let cachedInvoices = null;

/**
 * Fetches all cost invoices from Infakt.
 * caches the result in memory for the duration of the process.
 */
async function getAllInfaktInvoices() {
    if (cachedInvoices) {
        return cachedInvoices;
    }

    if (!config.infakt_api_key) {
        logger.warn('Infakt API key is missing. Skipping Infakt check.');
        return [];
    }

    logger.info('Fetching invoices from Infakt API...');

    let allInvoices = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    try {
        while (hasMore) {
            const url = `${INFAKT_API_URL}/documents/costs.json?limit=${limit}&offset=${offset}`;
            const response = await axios.get(url, {
                headers: {
                    'X-inFakt-ApiKey': config.infakt_api_key
                }
            });

            const entities = response.data.entities || [];
            allInvoices = allInvoices.concat(entities);

            if (entities.length < limit) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }

        logger.info(`Fetched ${allInvoices.length} invoices from Infakt.`);
        cachedInvoices = allInvoices;
        return allInvoices;

    } catch (error) {
        logger.error('Error fetching invoices from Infakt', { error: error.message });
        if (error.response) {
            logger.error('Infakt API Error Response', { status: error.response.status, data: error.response.data });
        }
        return [];
    }
}

/**
 * Helper to extract comparable fields from any invoice object (Infakt or internal).
 */
function getInvoiceDetails(inv) {
    return {
        numberRaw: normalizeString(inv.number),
        net: parseAmount(inv.net_amount || inv.net_price),
        gross: parseAmount(inv.total_amount || inv.gross_price)
    };
}

/**
 * Core logic to check if two invoices are duplicates.
 */
function areInvoicesTheSame(invA, invB) {
    const A = getInvoiceDetails(invA);
    const B = getInvoiceDetails(invB);

    if (!A.numberRaw || A.numberRaw.length < 3) return { match: false };
    if (!B.numberRaw || B.numberRaw.length < 3) return { match: false };

    // Check Price (Strong Signal)
    const netMatch = Math.abs(A.net - B.net) < 0.05;
    const grossMatch = Math.abs(A.gross - B.gross) < 0.05;

    if (netMatch || grossMatch) {
        // Heuristic: If one contains the other
        const oneContainsOther = A.numberRaw.includes(B.numberRaw) || B.numberRaw.includes(A.numberRaw);

        // Ensure the MATCHED common part is significant (e.g. at least 5 chars)
        const minLength = Math.min(A.numberRaw.length, B.numberRaw.length);

        if (oneContainsOther && minLength >= 5) {
            return {
                match: true,
                reason: netMatch ? 'Net Price' : 'Gross Price'
            };
        }
    }
    return { match: false };
}

/**
 * Checks equality specifically for 'document_scan' types where filename is a strong signal.
 */
function areInfaktScansTheSame(invA, invB) {
    // 1. Check Filename (Strongest Signal for Scans)
    // 1. Check Filename (Strongest Signal for Scans)
    // Normalize aggressively: Keep only alphanumeric to ignore spacing/dashes differences
    const normalizeFilename = (s) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

    const fileA = invA.attachments && invA.attachments[0] ? normalizeFilename(invA.attachments[0].file_name) : null;
    const fileB = invB.attachments && invB.attachments[0] ? normalizeFilename(invB.attachments[0].file_name) : null;

    if (fileA && fileB && fileA === fileB) {
        // Secondary check: Price should also match to be safe
        const A = getInvoiceDetails(invA);
        const B = getInvoiceDetails(invB);
        const netMatch = Math.abs(A.net - B.net) < 0.05;
        const grossMatch = Math.abs(A.gross - B.gross) < 0.05;

        if (netMatch || grossMatch) {
            return { match: true, reason: 'Filename & Price' };
        }
    }

    // 2. Fallback to standard check
    return areInvoicesTheSame(invA, invB);
}

/**
 * Checks if a candidate invoice exists in Infakt.
 * Matches by Number AND (Net Price OR Gross Price).
 */
function checkInfaktDuplicate(candidate, infaktInvoices) {
    if (!infaktInvoices || infaktInvoices.length === 0) {
        return false;
    }

    for (const invoice of infaktInvoices) {
        const result = areInvoicesTheSame(candidate, invoice);
        if (result.match) {
            logger.info(`Infakt duplicate found (Fuzzy Match)`, {
                candidate: candidate.number,
                infaktNumber: invoice.number,
                infaktId: invoice.id,
                matchedBy: result.reason
            });
            return true;
        }
    }

    return false;
}

module.exports = {
    getAllInfaktInvoices,
    checkInfaktDuplicate,
    areInvoicesTheSame,
    areInfaktScansTheSame
};
