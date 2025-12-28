require('dotenv').config();
const { getAllInfaktInvoices, areInvoicesTheSame, areInfaktScansTheSame } = require('../src/infakt/api');
const { normalizeString, parseAmount } = require('../src/sheets');
const fs = require('fs');
const path = require('path');


async function findDuplicates() {
    console.log("Fetching invoices...");
    const invoices = await getAllInfaktInvoices();

    // Debug: Log structure of a single invoice to check for 'id' field and attachments
    if (invoices.length > 0) {
        // Find a Twilio invoice if possible to inspect
        const twilio = invoices.find(inv => inv.seller_name && inv.seller_name.toLowerCase().includes('twilio'));
        if (twilio) {
            console.log("--- Sample Twilio Invoice ---");
            console.log(JSON.stringify({
                uuid: twilio.uuid,
                number: twilio.number,
                kind: twilio.kind,
                attachments: twilio.attachments // Log attachments to see filename structure
            }, null, 2));
        } else {
            console.log("--- Sample Invoice (No Twilio found) ---");
            console.log(JSON.stringify({
                uuid: invoices[0].uuid,
                number: invoices[0].number,
                kind: invoices[0].kind,
                attachments: invoices[0].attachments
            }, null, 2));
        }
    }

    // Filter for December 2025 (By Upload Date - created_at)
    // This catches invoices issued in Nov but uploaded in Dec
    const decemberInvoices = invoices.filter(inv => {
        const date = inv.created_at;
        return date && date.startsWith('2025-12');
    });

    console.log(`Found ${decemberInvoices.length} invoices in December 2025.`);

    // Sort by created_at 
    decemberInvoices.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const duplicates = [];
    const processedUuids = new Set();
    const kindCounts = {};

    for (const inv of decemberInvoices) {
        kindCounts[inv.kind] = (kindCounts[inv.kind] || 0) + 1;
    }
    console.log("Invoices by Kind:", kindCounts);

    for (let i = 0; i < decemberInvoices.length; i++) {
        const original = decemberInvoices[i];
        if (processedUuids.has(original.uuid)) continue;

        for (let j = i + 1; j < decemberInvoices.length; j++) {
            const candidate = decemberInvoices[j];
            if (processedUuids.has(candidate.uuid)) continue;

            const comparison = areInfaktScansTheSame(original, candidate);

            if (comparison.match) {
                if (duplicates.length === 0) {
                    console.log("DEBUG: First Duplicate Pair Attachments Check");
                    console.log("Original UUID:", original.uuid);
                    console.log("Original Attachments:", JSON.stringify(original.attachments));
                    console.log("Candidate UUID:", candidate.uuid);
                    console.log("Candidate Attachments:", JSON.stringify(candidate.attachments));
                }
                const origFile = (original.attachments && original.attachments[0]) ? original.attachments[0].file_name : 'No Attachment';
                const dupFile = (candidate.attachments && candidate.attachments[0]) ? candidate.attachments[0].file_name : 'No Attachment';

                duplicates.push({
                    original: {
                        id: original.id,
                        uuid: original.uuid,
                        kind: original.kind,
                        number: original.number,
                        invoice_date: original.issue_date,
                        gross_price: original.gross_price,
                        client: original.seller_name || 'N/A',
                        created_at: original.created_at
                    },
                    duplicate: {
                        id: candidate.id,
                        uuid: candidate.uuid,
                        kind: candidate.kind,
                        number: candidate.number,
                        invoice_date: candidate.issue_date,
                        gross_price: candidate.gross_price,
                        created_at: candidate.created_at
                    },
                    reason: comparison.reason,
                    original_filename: origFile,
                    duplicate_filename: dupFile
                });
                processedUuids.add(candidate.uuid);
            }
        }
    }

    console.log(`Found ${duplicates.length} duplicate pairs.`);

    // Output JSON for the agent to read and format into Artifact
    console.log('JSON_OUTPUT_START');
    console.log(JSON.stringify(duplicates, null, 2));
    console.log('JSON_OUTPUT_END');
}

findDuplicates();
