require('dotenv').config();
const { parseBankStatement } = require('./src/bank_parser');
const { reconcileTransactions, generateReport } = require('./src/reconcile');
const { getOAuth2Client } = require('./src/auth');
const { google } = require('googleapis');
const config = require('./config.json');
const path = require('path');
const fs = require('fs');

async function main() {
    const args = process.argv.slice(2);
    const fileArgIndex = args.indexOf('--file');

    if (fileArgIndex === -1 || !args[fileArgIndex + 1]) {
        console.error('Usage: node run-reconciliation.js --file <path_to_bank_statement>');
        process.exit(1);
    }

    const filePath = args[fileArgIndex + 1];
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    console.log(`Starting reconciliation for file: ${filePath}`);

    try {
        // 1. Parse Bank Statement
        console.log('Parsing bank statement...');
        const transactions = await parseBankStatement(filePath);
        console.log(`Parsed ${transactions.length} transactions.`);

        // 2. Authenticate
        const auth = getOAuth2Client();
        const sheets = google.sheets({ version: 'v4', auth });

        // 3. Reconcile
        console.log('Reconciling with invoice registry...');
        const result = await reconcileTransactions(transactions, sheets, config.spreadsheet_id);

        console.log(`Reconciliation Complete.`);
        console.log(`  Matched: ${result.matched.length}`);
        console.log(`  Missing: ${result.missing.length}`);

        // 4. Generate Report
        console.log('Generating report...');
        const reportUrl = await generateReport(result, sheets);
        console.log(`Report generated successfully!`);
        console.log(`URL: ${reportUrl}`);

    } catch (error) {
        console.error('Error during reconciliation:', error);
        process.exit(1);
    }
}

main();
