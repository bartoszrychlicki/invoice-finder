/**
 * Backfill script to analyze existing invoices and set Foreign column.
 * Uses heuristics (no AI) for speed and cost efficiency.
 * 
 * Usage:
 *   node backfill-foreign.js --dry-run    # Preview changes without writing
 *   node backfill-foreign.js              # Apply changes to spreadsheet
 */

require('dotenv').config();
const { google } = require('googleapis');
const { getOAuth2Client } = require('./src/auth');
const config = require('./src/config');

// Column indices (0-indexed)
const COL = {
    CURRENCY: 6,        // G
    SELLER_NAME: 7,     // H
    SELLER_TAX_ID: 8,   // I
    SELLER_ADDRESS: 19, // T
    FOREIGN: 22         // W
};

/**
 * Determines if a seller is foreign based on invoice data.
 */
function isForeignSeller(row) {
    const taxId = (row[COL.SELLER_TAX_ID] || '').toString().trim();
    const currency = (row[COL.CURRENCY] || '').toString().toUpperCase().trim();
    const address = (row[COL.SELLER_ADDRESS] || '').toString().toLowerCase();
    const name = (row[COL.SELLER_NAME] || '').toString();

    // 1. Tax ID check - Polish NIP is exactly 10 digits
    const digitsOnly = taxId.replace(/[^0-9]/g, '');
    const isPolishNIP = digitsOnly.length === 10 && /^\d{10}$/.test(digitsOnly);

    // EU VAT prefix pattern (2 letters followed by digits)
    const hasEUVATPrefix = /^[A-Z]{2}\d+/i.test(taxId.replace(/\s/g, ''));
    const euVatPrefixes = ['DE', 'GB', 'FR', 'NL', 'BE', 'AT', 'IT', 'ES', 'PT', 'IE', 'DK', 'SE', 'FI', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'LT', 'LV', 'EE', 'CY', 'MT', 'LU', 'GR', 'US'];
    const hasKnownForeignPrefix = euVatPrefixes.some(p => taxId.toUpperCase().startsWith(p));

    // 2. Address contains foreign country
    const foreignCountryPatterns = [
        /\bgermany\b|\bdeutschland\b|\bniemcy\b/i,
        /\bunited kingdom\b|\buk\b|\bwielka brytania\b|\bengland\b/i,
        /\busa\b|\bunited states\b|\bstany zjednoczone\b|\bamerica\b/i,
        /\bfrance\b|\bfrancja\b/i,
        /\bnetherlands\b|\bholandia\b|\bnederland\b/i,
        /\bireland\b|\birlandia\b/i,
        /\bspain\b|\bhiszpania\b|\bespaña\b/i,
        /\bitaly\b|\bwłochy\b|\bitalia\b/i,
        /\baustria\b/i,
        /\bbelgium\b|\bbelgia\b/i,
        /\bswitzerland\b|\bszwajcaria\b|\bschweiz\b/i,
        /\bczech\b|\bczechy\b/i,
        /\bslovakia\b|\bsłowacja\b/i,
        /\bsweden\b|\bszwecja\b/i,
        /\bdenmark\b|\bdania\b/i,
        /\bfinland\b|\bfinlandia\b/i,
        /\bnorway\b|\bnorwegia\b/i,
        /\bportugal\b|\bportugalia\b/i,
        /\bluxembourg\b|\bluksemburg\b/i,
        /\bcanada\b|\bkanada\b/i,
        /\baustralia\b/i,
        /\bjapan\b|\bjaponia\b/i,
        /\bchina\b|\bchiny\b/i,
        /\bsingapore\b|\bsingapur\b/i,
    ];
    const hasForeignAddress = foreignCountryPatterns.some(p => p.test(address));

    // Check for Polish address indicators (to avoid false positives)
    const hasPolishAddress = /\bpolska\b|\bpoland\b|\bpl\s*\d{2}-\d{3}\b/i.test(address) ||
        /\b\d{2}-\d{3}\s+\w+/i.test(address); // Polish postal code format

    // 3. Foreign legal forms in company name
    const foreignLegalForms = /\b(ltd\.?|gmbh|inc\.?|llc|sas|sarl|b\.?v\.?|a\.?g\.?|corp\.?|plc|pty|s\.?a\.?|aps|as|ab)\b/i;
    const hasForeignLegalForm = foreignLegalForms.test(name);

    // Polish legal forms
    const polishLegalForms = /\b(sp\.?\s*z\s*o\.?\s*o\.?|spółka|s\.?a\.?|sp\.?\s*j\.?|sp\.?\s*k\.?)\b/i;
    const hasPolishLegalForm = polishLegalForms.test(name);

    // Decision logic
    // Definite foreign indicators
    if (hasKnownForeignPrefix && !isPolishNIP) return true;
    if (hasEUVATPrefix && !isPolishNIP) return true;
    if (hasForeignAddress && !hasPolishAddress) return true;

    // Probable foreign indicators
    if (hasForeignLegalForm && !isPolishNIP && !hasPolishLegalForm) return true;

    // If we have a valid Polish NIP, it's Polish
    if (isPolishNIP) return false;

    // Default to not foreign if uncertain
    return false;
}

async function backfillForeignColumn(dryRun = false) {
    const auth = getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = config.spreadsheet_id;

    console.log('Fetching all invoices from spreadsheet...');
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'A:W',
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) {
        console.log('No data rows found.');
        return;
    }

    // Skip header row
    const headerRow = rows[0];
    const dataRows = rows.slice(1);

    console.log(`Found ${dataRows.length} invoices to analyze.\n`);

    const updates = [];
    let foreignCount = 0;
    let polishCount = 0;

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNumber = i + 2; // 1-indexed + header
        const invoiceNumber = row[3] || 'N/A';
        const sellerName = row[COL.SELLER_NAME] || 'Unknown';
        const currentForeign = (row[COL.FOREIGN] || '').toUpperCase();

        const isForeign = isForeignSeller(row);
        const newValue = isForeign ? 'TRUE' : 'FALSE';

        // Only update if value is different or empty
        if (currentForeign !== newValue) {
            updates.push({
                range: `W${rowNumber}`,
                values: [[newValue]]
            });

            const symbol = isForeign ? '🌍' : '🇵🇱';
            console.log(`${symbol} Row ${rowNumber}: ${invoiceNumber} | ${sellerName.substring(0, 30)} | ${currentForeign || 'EMPTY'} → ${newValue}`);
        }

        if (isForeign) {
            foreignCount++;
        } else {
            polishCount++;
        }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total invoices: ${dataRows.length}`);
    console.log(`Foreign: ${foreignCount}`);
    console.log(`Polish: ${polishCount}`);
    console.log(`Updates needed: ${updates.length}`);

    if (updates.length === 0) {
        console.log('\nNo updates needed. All values are already correct.');
        return;
    }

    if (dryRun) {
        console.log('\n[DRY RUN] No changes written to spreadsheet.');
        console.log('Run without --dry-run to apply changes.');
        return;
    }

    console.log('\nWriting updates to spreadsheet...');
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: updates
        }
    });

    console.log(`✅ Successfully updated ${updates.length} rows.`);
}

// Main
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

backfillForeignColumn(dryRun).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
