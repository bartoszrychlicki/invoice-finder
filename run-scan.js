require('dotenv').config();
const { scanEmails } = require('./src/gmail');

async function runScan() {
    console.log('Starting manual email scan...');
    try {
        const result = await scanEmails(false, 24); // testMode=false, 24 hours
        console.log('Scan complete:', result);
    } catch (error) {
        console.error('Error during scan:', error);
    }
}

runScan();
