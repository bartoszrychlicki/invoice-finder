require('dotenv').config();
const config = require('./src/config');
const { getAllInfaktInvoices, checkInfaktDuplicate } = require('./src/infakt/api');
const logger = require('./src/utils/logger');

async function verify() {
    console.log('--- Verifying Infakt Integration ---');
    console.log(`API Key present: ${!!config.infakt_api_key}`);
    console.log(`Check enabled: ${config.check_infakt_duplicates}`);

    if (!config.infakt_api_key) {
        console.error('CRITICAL: API Key missing!');
        return;
    }

    try {
        console.log('Fetching invoices...');
        const invoices = await getAllInfaktInvoices();
        console.log(`Fetched ${invoices.length} invoices.`);

        if (invoices.length > 0) {
            const sample = invoices[0];
            console.log('Sample invoice:', JSON.stringify(sample, null, 2));

            console.log('Testing duplicate check (POSITIVE)...');
            const candidate = {
                number: sample.number,
                total_amount: sample.gross_price,
                net_amount: sample.net_price
            };
            const isDup = checkInfaktDuplicate(candidate, invoices);
            console.log(`Expected TRUE, Got: ${isDup}`);
            if (!isDup) console.error('FAILED: Positive duplicate check failed.');

            console.log('Testing duplicate check (NEGATIVE)...');
            const nonCandidate = {
                number: 'NON_EXISTENT_INVOICE_NUMBER_12345',
                total_amount: 123.45
            };
            const isNotDup = checkInfaktDuplicate(nonCandidate, invoices);
            console.log(`Expected FALSE, Got: ${isNotDup}`);
            if (isNotDup) console.error('FAILED: Negative duplicate check failed.');

        } else {
            console.warn('No invoices returned from API. Cannot verify duplicate logic.');
        }

    } catch (e) {
        console.error('Verification failed with error:', e);
    }
}

verify();
