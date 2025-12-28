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
 * Checks if a candidate invoice exists in Infakt.
 * Matches by Number AND (Net Price OR Gross Price).
 */
function checkInfaktDuplicate(candidate, infaktInvoices) {
    if (!infaktInvoices || infaktInvoices.length === 0) {
        return false;
    }

    const targetNumberRaw = normalizeString(candidate.number);
    if (!targetNumberRaw || targetNumberRaw.length < 3) return false; // Safety check for very short numbers

    const targetNet = parseAmount(candidate.net_amount || candidate.total_amount);
    const targetGross = parseAmount(candidate.total_amount);

    for (const invoice of infaktInvoices) {
        const existingNet = parseAmount(invoice.net_price);
        const existingGross = parseAmount(invoice.gross_price);

        // Check Price First (Strong Signal)
        const netMatch = Math.abs(existingNet - targetNet) < 0.05;
        const grossMatch = Math.abs(existingGross - targetGross) < 0.05;

        if (netMatch || grossMatch) {
            const existingNumberRaw = normalizeString(invoice.number);

            // Heuristic: If one contains the other
            // e.g. "invoiceet6u76zx0001" contains "et6u76zx0001"
            const oneContainsOther = targetNumberRaw.includes(existingNumberRaw) || existingNumberRaw.includes(targetNumberRaw);

            // Ensure the MATCHED common part is significant (e.g. at least 5 chars)
            // In this case, if one includes the other, the length of the shorter one is the overlap.
            const minLength = Math.min(targetNumberRaw.length, existingNumberRaw.length);

            if (oneContainsOther && minLength >= 5) {
                logger.info(`Infakt duplicate found (Fuzzy Match)`, {
                    candidate: candidate.number,
                    infaktNumber: invoice.number,
                    infaktId: invoice.id,
                    matchedBy: netMatch ? 'Net Price' : 'Gross Price'
                });
                return true;
            }
        }
    }

    return false;
}

module.exports = {
    getAllInfaktInvoices,
    checkInfaktDuplicate
};
