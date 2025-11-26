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

module.exports = { parseBankStatement };
