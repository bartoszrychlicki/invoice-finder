const fs = require('fs');
const readline = require('readline');

/**
 * Parses a bank statement file.
 * Currently supports CSV format from the provided sample.
 * 
 * @param {string} filePath - Path to the bank statement file.
 * @returns {Promise<Array<Object>>} - Array of normalized transaction objects.
 */
async function parseBankStatement(filePath) {
    const fileStream = fs.createReadStream(filePath);

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const transactions = [];
    let isHeader = true;
    let headerMap = {};

    // Expected CSV Header:
    // Data księgowania,Data operacji,Rodzaj operacji,Kwota,Waluta,Dane kontrahenta,Numer rachunku kontrahenta,Tytuł operacji,Saldo po operacji

    for await (const line of rl) {
        // Skip empty lines or metadata lines (before the actual header)
        if (!line.trim()) continue;

        // Simple heuristic to find the header line
        if (line.includes('Data księgowania') && line.includes('Kwota')) {
            const headers = line.split(',');
            headers.forEach((h, i) => headerMap[h.trim()] = i);
            isHeader = false;
            continue;
        }

        if (isHeader) continue;

        // Parse CSV line (handling quoted values if necessary, though sample seems simple)
        // For now, simple split by comma, but might need regex for quoted fields containing commas
        // The sample shows simple commas, but let's be robust.
        // Actually, the sample has "Nest Bank S.A.|ul Wołoska..." which contains spaces but no commas in the text fields shown so far.
        // However, "Kwota" is like "-80.3".
        // Let's use a regex to split by comma but ignore commas inside quotes if they exist.
        const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
        // The above regex is too simple. Let's stick to split(',') for now as the sample looks clean, 
        // but we need to handle the case where "Kwota" might have comma as decimal separator? 
        // Sample says: "-80.3", "324.14". It uses DOT.
        // Wait, one line: "22 5,26" in description?
        // "Kwota VAT: 22 5,26" is in "Tytuł operacji".
        // So we definitely need to handle commas inside fields if they are quoted.
        // But the sample CSV provided by user does NOT look quoted!
        // Example: ...,Przelewy wychodzące,-1204.63,PLN,PKO Leasing S.A.|ul. Świętokrzyska 36 00-116Warszawa,04102010263491000181815160,leasing umowa nr 25/021345, Nr fakt ury: LM/25/09/132141, Kwota VAT: 22 5,26, Identyfikator: 7251735694,21075.58
        // Wait, "leasing umowa nr ..., Kwota VAT: 22 5,26, ..." -> This title contains commas!
        // And it is NOT quoted in the sample provided in the prompt?
        // Let's look closely at the prompt sample.
        // 20-11-2025,20-11-2025,Przelewy wychodzące,-1204.63,PLN,PKO Leasing S.A.|ul. Świętokrzyska 36 00-116Warszawa,04102010263491000181815160,leasing umowa nr 25/021345, Nr fakt ury: LM/25/09/132141, Kwota VAT: 22 5,26, Identyfikator: 7251735694,21075.58
        // If this is a standard CSV, it's broken because the title contains commas and isn't quoted.
        // OR, maybe the user pasted it and it lost quotes?
        // OR, maybe it's not a standard CSV.
        // Let's assume for a moment that the "Title" is the LAST field or second to last?
        // Header: Data księgowania,Data operacji,Rodzaj operacji,Kwota,Waluta,Dane kontrahenta,Numer rachunku kontrahenta,Tytuł operacji,Saldo po operacji
        // Count: 9 columns.
        // Let's look at the problematic line again.
        // 1: 20-11-2025
        // 2: 20-11-2025
        // 3: Przelewy wychodzące
        // 4: -1204.63
        // 5: PLN
        // 6: PKO Leasing S.A.|ul. Świętokrzyska 36 00-116Warszawa
        // 7: 04102010263491000181815160
        // 8: leasing umowa nr 25/021345, Nr fakt ury: LM/25/09/132141, Kwota VAT: 22 5,26, Identyfikator: 7251735694
        // 9: 21075.58
        //
        // It seems the "Title" field swallows everything until the last comma?
        // Yes, "Saldo po operacji" is the last column.
        // So we can parse by finding the first 7 commas, and then finding the LAST comma. Everything in between is the title.

        const parts = line.split(',');
        if (parts.length < 9) continue; // Skip malformed lines

        // Extract known fixed columns from start
        const datePosted = parts[0];
        const dateOp = parts[1];
        const type = parts[2];
        const amountStr = parts[3];
        const currency = parts[4];
        // Counterparty might contain commas? Unlikely for "Dane kontrahenta" usually, but let's be safe.
        // Actually, looking at the sample: "Nest Bank S.A.|ul Wołoska..." - pipe separator used inside?
        // "II Urząd Skarbowy Gdańsk"
        // "RYCHLICKI HOLDING..."
        // It seems column 6 (index 5) is safe-ish.

        // Let's try to reconstruct based on known indices.
        // We know the last column is Balance.
        const balance = parts[parts.length - 1];

        // We know the first 7 columns are standard (indices 0-6).
        // 0: Data księgowania
        // 1: Data operacji
        // 2: Rodzaj operacji
        // 3: Kwota
        // 4: Waluta
        // 5: Dane kontrahenta
        // 6: Numer rachunku kontrahenta

        // So Title is from index 7 to (length - 2).
        // Wait, length-1 is the last item.
        // So Title is parts.slice(7, parts.length - 1).join(',')

        const counterparty = parts[5];
        const title = parts.slice(7, parts.length - 1).join(',');

        const amount = parseFloat(amountStr);

        transactions.push({
            date: dateOp, // Using Operation Date as primary
            amount: amount,
            currency: currency,
            counterparty: counterparty,
            description: title,
            raw: line
        });
    }

    return transactions;
}

const iconv = require('iconv-lite');

/**
 * Parses an MT940 bank statement file.
 * 
 * @param {string} filePath - Path to the MT940 file.
 * @returns {Promise<Array<Object>>} - Array of normalized transaction objects.
 */
async function parseMT940(filePath) {
    const buffer = fs.readFileSync(filePath);
    // Try to decode as Windows-1250 (common for Polish banks)
    // If that fails or looks wrong, we might need detection, but win1250 is a safe bet for PL.
    const content = iconv.decode(buffer, 'win1250');

    const lines = content.split(/\r?\n/);
    const transactions = [];

    let currentTx = null;
    let buffer86 = ''; // Buffer for :86: lines

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith(':61:')) {
            // Save previous transaction if exists
            if (currentTx) {
                parse86(currentTx, buffer86);
                transactions.push(currentTx);
            }

            // Start new transaction
            // Format: :61:YYMMDD[MMDD]D/CAmountNTypeRef//BankRef
            // Example: :61:2511071107DN3000,00NTRFNONREF//25/11/07/110875/1
            // Regex to capture: Date(6), EntryDate(4, optional), DC(1 or 2), Amount(comma), N(1), Type(3), Ref

            // Simple parsing strategy:
            // 1. Remove :61:
            const raw = line.substring(4);
            const dateYYMMDD = raw.substring(0, 6);

            // Find the D or C (Debit/Credit)
            // It might be D, C, RD, RC. Usually index 10 or 6?
            // If EntryDate (4 digits) is present, D/C is at index 10.
            // If not, D/C is at index 6.
            // In sample: 251107 1107 DN... -> EntryDate is present.
            // Let's check if chars at 6-9 are digits.
            let dcIndex = 6;
            if (/^\d{4}/.test(raw.substring(6, 10))) {
                dcIndex = 10;
            }

            // Extract D/C
            // Could be 'D', 'C', 'RC', 'RD'.
            // We look for the first non-digit char after date.
            // Actually, let's just use regex from the start of raw string.
            const match = raw.match(/^(\d{6})(\d{4})?([A-Z]{1,2})([0-9,]+)([A-Z])([A-Z]{3})/);

            if (match) {
                const dateStr = match[1]; // YYMMDD
                const dc = match[3]; // D or C
                const amountStr = match[4].replace(',', '.');
                const type = match[6]; // TRF, etc.

                let amount = parseFloat(amountStr);
                if (dc.includes('D')) {
                    amount = -amount; // Debit = Outgoing = Negative
                }

                // Parse Date: YYMMDD -> YYYY-MM-DD
                // Assuming 20xx
                const year = '20' + dateStr.substring(0, 2);
                const month = dateStr.substring(2, 4);
                const day = dateStr.substring(4, 6);
                const formattedDate = `${year}-${month}-${day}`; // YYYY-MM-DD

                // Note: The CSV parser used DD-MM-YYYY or YYYY-MM-DD?
                // CSV parser used: parts[1] (Data operacji) which was "24-11-2025" (DD-MM-YYYY).
                // reconcile.js parseDate expects DD-MM-YYYY.
                // So let's return DD-MM-YYYY to be consistent with CSV parser output format expected by reconcile.js
                // reconcile.js: const [day, month, year] = dateStr.split('-');
                const dateForReconcile = `${day}-${month}-${year}`;

                currentTx = {
                    date: dateForReconcile,
                    amount: amount,
                    currency: 'PLN', // Default or extract from :60F: header? Assuming PLN for now.
                    type: type,
                    raw: line
                };
                buffer86 = '';
            }
        } else if (line.startsWith(':86:')) {
            buffer86 += line.substring(4);
        } else if (currentTx && !line.startsWith(':')) {
            // Continuation of previous tag (likely 86)
            buffer86 += line;
        } else if (line.startsWith(':')) {
            // Some other tag, finish previous tx
            if (currentTx) {
                parse86(currentTx, buffer86);
                transactions.push(currentTx);
                currentTx = null;
                buffer86 = '';
            }
        }
    }

    // Push last one
    if (currentTx) {
        parse86(currentTx, buffer86);
        transactions.push(currentTx);
    }

    return transactions;
}

function parse86(tx, buffer) {
    // Parse the :86: content which contains sub-tags like <00, <20 etc.
    // Example: <00Przelew...<20Title...<27Name...
    // We want to extract Description and Counterparty.

    // Strategy: Split by '<' and look at the code.
    const parts = buffer.split('<');
    let description = '';
    let counterparty = '';
    let typeDesc = '';

    for (const part of parts) {
        if (part.length < 2) continue;
        const code = part.substring(0, 2);
        const value = part.substring(2).trim();

        if (code === '00') typeDesc = value;
        else if (code >= '20' && code <= '26') description += value + ' ';
        else if (code >= '27' && code <= '29') counterparty += value + ' ';
        else if (code >= '60' && code <= '63') counterparty += value + ' '; // Sometimes address
    }

    tx.description = (typeDesc + ' ' + description).trim();
    tx.counterparty = counterparty.trim();

    // Clean up extra spaces
    tx.description = tx.description.replace(/\s+/g, ' ');
    tx.counterparty = tx.counterparty.replace(/\s+/g, ' ');
}

module.exports = { parseBankStatement, parseMT940 };
