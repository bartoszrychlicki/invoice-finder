require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getApprovedUnpaidInvoices } = require('./src/sheets_payment');
const { generateNestBankCSV, generateCSVFilename } = require('./src/csv_generator');

async function generatePaymentCSV() {
    console.log('Pobieranie zatwierdzonych nieopłaconych faktur...');
    const invoices = await getApprovedUnpaidInvoices();

    if (invoices.length === 0) {
        console.log('Brak zatwierdzonych faktur do przelewu.');
        return;
    }

    console.log(`Znaleziono ${invoices.length} faktur(y) do opłaty:`);
    invoices.forEach((inv, i) => {
        console.log(`  ${i + 1}. ${inv.number} - ${inv.sellerName} - ${inv.totalAmount} ${inv.currency}`);
    });

    const csvContent = generateNestBankCSV(invoices);

    if (!csvContent) {
        console.log('Nie udało się wygenerować CSV (brak poprawnych kont bankowych?)');
        return;
    }

    const filename = generateCSVFilename();
    const filepath = path.join(process.cwd(), filename);

    fs.writeFileSync(filepath, csvContent, { encoding: 'utf-8' });
    console.log(`\n✅ Plik CSV zapisany: ${filepath}`);
    console.log(`\nZawartość pliku:\n${csvContent}`);
}

generatePaymentCSV();
