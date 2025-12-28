require('dotenv').config();
const { getAllInfaktInvoices, checkInfaktDuplicate } = require('./src/infakt/api');
const { normalizeString } = require('./src/sheets');


async function run() {
    console.log("Fetching all Infakt invoices...");
    const invoices = await getAllInfaktInvoices();
    console.log(`Fetched ${invoices.length} invoices.`);

    const targetNumber = 'Invoice-ET6U76ZX-0001';
    console.log(`Searching for target number: ${targetNumber} (normalized: ${normalizeString(targetNumber)})`);

    const matches = invoices.filter(inv => normalizeString(inv.number) === normalizeString(targetNumber));

    if (matches.length === 0) {
        console.log("No exact matches found by number.");
        // Fuzzy search?
        const fuzzy = invoices.filter(inv => inv.number.includes('ET6U76ZX'));
        console.log("Partial matches:", fuzzy.map(f => `${f.number} (Net: ${f.net_price}, Gross: ${f.gross_price})`));
    } else {
        console.log(`Found ${matches.length} matches:`);
        matches.forEach(m => {
            console.log(`- ID: ${m.id}, Number: ${m.number}, Net: ${m.net_price}, Gross: ${m.gross_price}, Status: ${m.status}`);
        });
    }

    // Identify the specific duplicates from the screenshot if possible
    // The screenshot shows multiple entries.
    // If they exist in API, we should see them here.
}

run();
