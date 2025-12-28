require('dotenv').config();
const { getAllInfaktInvoices, areInvoicesTheSame, deleteInvoice } = require('../src/infakt/api');
const { normalizeString } = require('../src/sheets');

async function runDeletion() {
    console.log("Fetching invoices...");
    const invoices = await getAllInfaktInvoices();

    // Filter for December 2025
    const decemberInvoices = invoices.filter(inv => {
        const date = inv.issue_date;
        return date && date.startsWith('2025-12');
    });

    console.log(`Found ${decemberInvoices.length} invoices in December 2025.`);

    // Sort by created_at (oldest first)
    decemberInvoices.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const processedUuids = new Set();
    const duplicatesToDelete = [];

    for (let i = 0; i < decemberInvoices.length; i++) {
        const original = decemberInvoices[i];
        if (processedUuids.has(original.uuid)) continue;

        for (let j = i + 1; j < decemberInvoices.length; j++) {
            const candidate = decemberInvoices[j];
            if (processedUuids.has(candidate.uuid)) continue;

            const comparison = areInvoicesTheSame(original, candidate);

            if (comparison.match) {
                duplicatesToDelete.push({
                    uuid: candidate.uuid,
                    number: candidate.number,
                    reason: comparison.reason,
                    originalUuid: original.uuid
                });
                processedUuids.add(candidate.uuid);
            }
        }
    }

    console.log(`Found ${duplicatesToDelete.length} duplicates to delete.`);

    if (duplicatesToDelete.length === 0) {
        console.log("No duplicates found. Exiting.");
        return;
    }

    console.log("Starting deletion...");
    let deletedCount = 0;

    for (const dup of duplicatesToDelete) {
        console.log(`Deleting duplicate ${dup.number} (UUID: ${dup.uuid}) - Duplicate of ${dup.originalUuid}...`);
        const success = await deleteInvoice(dup.uuid);
        if (success) {
            deletedCount++;
        }
        // Small delay to be nice to API
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`Deleted ${deletedCount} of ${duplicatesToDelete.length} duplicates.`);
}

runDeletion();
