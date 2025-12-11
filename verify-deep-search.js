require('dotenv').config();
const { findMissingInvoice } = require('./src/gmail_search');
const { getOAuth2Client } = require('./src/auth');

async function verifyDeepSearch() {
    const auth = getOAuth2Client();

    // Test Case 1: IDOMI (Partial Match scenario - searching for full amount first)
    const tx1 = {
        date: '19-11-2025',
        amount: -750.00,
        counterparty: 'IDOMI Izabela Dominko',
        description: 'A6/10/2025 REF25/11/19/312943/1',
        type: 'Przelew wychodzący'
    };

    console.log('\n--- Testing Deep Search for IDOMI (Partial: 250 PLN) ---');
    const res1 = await findMissingInvoice(tx1, auth, 250.00);
    console.log('Result:', res1);

    // Test Case 2: Volkswagen (Interest scenario)
    const tx2 = {
        date: '07-11-2025',
        amount: -2961.21,
        counterparty: 'Volkswagen Bank GmbH',
        description: 'Leasing samochodu (GD 8L351) zgodnie z umową REF25/11/07/108194/1',
        type: 'Przelew wychodzący'
    };

    console.log('\n--- Testing Deep Search for Volkswagen ---');
    const res2 = await findMissingInvoice(tx2, auth);
    console.log('Result:', res2);
}

verifyDeepSearch();
