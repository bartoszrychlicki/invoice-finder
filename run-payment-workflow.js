require('dotenv').config();
const logger = require('./src/utils/logger');

async function runPaymentWorkflow() {
    try {
        console.log('=== WORKFLOW: Generowanie CSV i wysyłka mailem ===\n');

        const { getApprovedUnpaidInvoices, validateNoDuplicatePayments, markInvoicesAsPaid } = require('./src/sheets_payment');
        const { generateNestBankCSV, generateCSVFilename } = require('./src/csv_generator');
        const { sendPaymentCSV } = require('./src/gmail/notifier');
        const { getOAuth2Client } = require('./src/auth');

        // Step 1: Get approved unpaid invoices
        console.log('1. Pobieranie zatwierdzonych nieopłaconych faktur...');
        const invoices = await getApprovedUnpaidInvoices();

        if (invoices.length === 0) {
            console.log('   ❌ Brak zatwierdzonych nieopłaconych faktur.');
            return;
        }

        console.log(`   ✅ Znaleziono ${invoices.length} faktur(y):`);
        invoices.forEach((inv, i) => {
            console.log(`      ${i + 1}. ${inv.number} - ${inv.sellerName} - ${inv.totalAmount} ${inv.currency}`);
        });

        // Step 2: Validate for duplicates
        console.log('\n2. Sprawdzanie duplikatów...');
        const validation = validateNoDuplicatePayments(invoices);
        if (!validation.valid) {
            console.log(`   ❌ Wykryto duplikaty: ${validation.duplicates.join(', ')}`);
            return;
        }
        console.log('   ✅ Brak duplikatów.');

        // Step 3: Generate CSV
        console.log('\n3. Generowanie pliku CSV...');
        const csvContent = generateNestBankCSV(invoices);

        if (!csvContent) {
            console.log('   ❌ Nie udało się wygenerować CSV.');
            return;
        }

        const filename = generateCSVFilename();
        console.log(`   ✅ CSV wygenerowany: ${filename}`);

        // Step 4: Send email
        console.log('\n4. Wysyłanie maila z CSV...');
        const auth = getOAuth2Client();
        const invoiceSummary = invoices.map(inv => ({
            number: inv.number,
            sellerName: inv.sellerName,
            amount: inv.totalAmount
        }));

        const emailSent = await sendPaymentCSV(auth, csvContent, filename, invoices.length, invoiceSummary);

        if (!emailSent) {
            console.log('   ❌ Wysyłka maila nie powiodła się.');
            return;
        }
        console.log('   ✅ Mail wysłany!');

        // Step 5: Mark invoices as paid
        console.log('\n5. Oznaczanie faktur jako opłacone...');
        const rowIndices = invoices.map(inv => inv.rowIndex);
        await markInvoicesAsPaid(rowIndices);
        console.log('   ✅ Faktury oznaczone jako opłacone.');

        const totalAmount = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
        console.log(`\n=== SUKCES ===`);
        console.log(`Faktur: ${invoices.length}`);
        console.log(`Łączna kwota: ${totalAmount.toFixed(2)} PLN`);
        console.log(`Plik: ${filename}`);

    } catch (error) {
        console.error('Błąd:', error.message);
        logger.error('Payment workflow error', { error: error.message, stack: error.stack });
    }
}

runPaymentWorkflow();
