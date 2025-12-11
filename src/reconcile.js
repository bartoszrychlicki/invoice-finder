const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const { getAllInvoices, parseAmount, normalizeString } = require('./sheets');
const { findMissingInvoice } = require('./gmail_search');
const config = require('../config.json');

/**
 * Reconciles bank transactions with existing invoices.
 * 
 * @param {Array<Object>} transactions - Parsed bank transactions.
 * @param {Object} sheets - Google Sheets API instance.
 * @param {string} spreadsheetId - ID of the invoice registry.
 * @param {boolean} skipSearch - Whether to skip Gmail search for missing items.
 * @returns {Promise<Object>} - Result object { matched: [], missing: [] }
 */
async function reconcileTransactions(transactions, sheets, spreadsheetId, skipSearch = false) {
    const invoices = await getAllInvoices(sheets, spreadsheetId);
    console.log(`Loaded ${invoices.length} invoices from registry.`);

    const matched = [];
    const missing = [];
    const exempt = [];
    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const [day, month, year] = dateStr.split('-');
        return new Date(`${year}-${month}-${day}`);
    };

    // Helper to parse invoice date YYYY-MM-DD to Date object
    // Note: Sheets might store dates differently, but assuming ISO from logToSheet
    const parseInvoiceDate = (dateStr) => {
        if (!dateStr) return null;
        // Handle YYYY-MM-DD or DD-MM-YYYY or other formats?
        // logToSheet uses: data.issue_date. 
        // OpenAI usually returns YYYY-MM-DD.
        // Let's try to be flexible.
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
        return null;
    };

    for (const tx of transactions) {
        // Skip positive amounts (income) - User confirmed only expenses are relevant.
        if (tx.amount > 0) {
            continue;
        }

        const txAmount = tx.amount;
        const txDate = parseDate(tx.date);

        let bestMatch = null;
        let bestScore = 0;

        // --- STRATEGY 1: EXACT MATCH (Existing) ---
        for (const inv of invoices) {
            if (inv.matched) continue; // Skip already matched invoices

            const invAmount = parseAmount(inv[5]);
            const invDate = parseInvoiceDate(inv[4]);

            if (Math.abs(Math.abs(txAmount) - Math.abs(invAmount)) < 0.05) {
                let score = 50;
                if (txDate && invDate) {
                    const diffTime = Math.abs(txDate - invDate);
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    if (diffDays <= 7) {
                        score += 40;
                        if (diffDays === 0) score += 10;
                    }
                }

                // Counterparty check
                const txDesc = (tx.counterparty + ' ' + tx.description).toLowerCase();
                const invSeller = (inv[7] || '').toLowerCase();
                if (invSeller && txDesc.includes(invSeller)) score += 10;

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = inv;
                }
            }
        }

        // --- STRATEGY 2: FUZZY AMOUNT MATCH (Invoice Number in Description) ---
        // If no exact match found, check if transaction description contains invoice number
        if (!bestMatch) {
            const txDesc = (tx.counterparty + ' ' + tx.description).toLowerCase();

            for (const inv of invoices) {
                if (inv.matched) continue;

                const invNumber = (inv[3] || '').trim().toLowerCase();
                if (invNumber.length < 3) continue; // Skip short numbers to avoid false positives

                // Check if invoice number is in transaction description
                // We need to be careful about substrings, e.g. "12" in "123".
                // Simple includes for now, but maybe boundary check?
                if (txDesc.includes(invNumber)) {
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));

                    // Allow larger tolerance (e.g. 10% or 50 PLN) if number matches explicitly
                    // Volkswagen case: 2961 vs 2922 (diff ~40 PLN)
                    if (diff < 100 || diff < Math.abs(invAmount) * 0.1) {
                        // Strong match on Number, acceptable match on Amount
                        bestMatch = inv;
                        bestScore = 85; // High enough to pass
                        console.log(`    -> Fuzzy Match found! Invoice ${invNumber} in desc. Diff: ${diff.toFixed(2)}`);
                        break;
                    }
                } else if (invNumber.length > 5 && txDesc.replace(/[^a-z0-9]/g, '').includes(invNumber.replace(/[^a-z0-9]/g, ''))) {
                    // Try normalized match
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));
                    if (diff < 100 || diff < Math.abs(invAmount) * 0.1) {
                        bestMatch = inv;
                        bestScore = 85;
                        console.log(`    -> Fuzzy Match (Normalized) found! Invoice ${invNumber} in desc. Diff: ${diff.toFixed(2)}`);
                        break;
                    }
                }
            }
        }

        // --- STRATEGY 3: COUNTERPARTY + FUZZY AMOUNT MATCH ---
        // If still no match, check if Counterparty matches strongly and amount is "close enough" (e.g. interest/fees)
        if (!bestMatch) {
            const txCounterparty = (tx.counterparty || '').toLowerCase();
            const txDesc = (tx.description || '').toLowerCase();

            for (const inv of invoices) {
                if (inv.matched) continue;

                const invSeller = (inv[7] || '').toLowerCase();
                if (!invSeller) continue;

                // Check for strong counterparty match
                // 1. Containment
                const sellerMatch = txCounterparty.includes(invSeller) || invSeller.includes(txCounterparty);

                // 2. First word match (if > 3 chars) - e.g. "Volkswagen"
                const txFirstWord = txCounterparty.split(' ')[0];
                const invFirstWord = invSeller.split(' ')[0];
                const firstWordMatch = txFirstWord.length > 3 && invFirstWord.length > 3 && txFirstWord === invFirstWord;

                // Also check description for seller name if counterparty field is empty/generic
                const descMatch = txDesc.includes(invSeller);

                if (sellerMatch || descMatch || firstWordMatch) {
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));

                    // Tolerance: Up to 50 PLN or 5% difference (Fuzzy Amount)
                    if (diff < 50 || diff < Math.abs(invAmount) * 0.05) {
                        bestMatch = inv;
                        bestScore = 75; // Lower score than exact match
                        console.log(`    -> Counterparty+Fuzzy Amount Match! Seller: ${invSeller}, Diff: ${diff.toFixed(2)}`);
                        break;
                    }

                    // --- STRATEGY 5: PARTIAL MATCH (Many-to-1 / Split Payment) ---
                    // If Tx Amount > Inv Amount (significantly) and Counterparty matches
                    // e.g. Tx 750, Inv 500.
                    if (Math.abs(txAmount) > Math.abs(invAmount) + 50) {
                        // Check if we can explain the difference?
                        // Or just mark as partial match.
                        // Let's mark as partial match if no better match found.
                        // We need to be careful not to overwrite a better match found later?
                        // But we are in a loop. If we find this, should we take it?
                        // Let's store it as a candidate and take it if nothing else works.
                        // For now, let's just take it if score < 70.
                        if (bestScore < 70) {
                            bestMatch = inv;
                            bestScore = 70; // Partial match score
                            bestMatch.partial = true;
                            bestMatch.notes = `Partial Match. Remaining: ${(Math.abs(txAmount) - Math.abs(invAmount)).toFixed(2)}`;
                            console.log(`    -> Partial Match! Seller: ${invSeller}, Tx: ${Math.abs(txAmount)}, Inv: ${Math.abs(invAmount)}`);
                        }
                    }
                }
            }
        }

        // --- STRATEGY 4: COMBINATION MATCH (1-to-Many) ---
        // If still no match, try to find a set of invoices that sum up to this transaction
        if (!bestMatch) {
            // Filter candidates by Counterparty to reduce search space
            const txCounterparty = (tx.counterparty || '').toLowerCase();
            const candidates = invoices.filter(inv => {
                if (inv.matched) return false;
                const invSeller = (inv[7] || '').toLowerCase();
                // Simple containment check
                return invSeller && (txCounterparty.includes(invSeller) || invSeller.includes(txCounterparty));
            });

            if (candidates.length > 1 && candidates.length < 10) { // Limit complexity
                const target = Math.abs(txAmount);
                const combo = findSubsetSum(candidates, target);
                if (combo) {
                    // We found a combination! 
                    // We need to handle multiple invoices for one transaction.
                    // For now, let's just link the FIRST one as the "primary" match 
                    // and log the others? Or change structure to support array of invoices?
                    // The current structure expects `invoice: bestMatch` (single object).
                    // Let's modify the result structure to support `invoices: []`.

                    // For backward compatibility, we'll set `invoice` to the first one,
                    // but add `additionalInvoices` to the match object.
                    bestMatch = combo[0];
                    bestScore = 95;
                    bestMatch.additionalInvoices = combo.slice(1);
                    console.log(`    -> Combination Match found! ${combo.length} invoices sum to ${target}`);
                }
            }
        }

        if (bestMatch && bestScore >= 70) {
            // Mark as matched to avoid reusing
            bestMatch.matched = true;
            if (bestMatch.additionalInvoices) {
                bestMatch.additionalInvoices.forEach(i => i.matched = true);
            }

            matched.push({
                transaction: tx,
                invoice: bestMatch,
                score: bestScore,
                additionalInvoices: bestMatch.additionalInvoices
            });
        } else {
            // Check for Exemptions
            const combinedText = (tx.counterparty + ' ' + tx.description + ' ' + (tx.type || '')).toLowerCase();
            let isExempt = false;
            let exemptionCategory = '';

            if (config.exemptions) {
                for (const rule of config.exemptions) {
                    if (rule.keywords.some(k => combinedText.includes(k.toLowerCase()))) {
                        isExempt = true;
                        exemptionCategory = rule.category;
                        break;
                    }
                }
            }

            // Also check for "Opłaty i prowizje" type explicitly if not caught by keywords
            if (!isExempt && tx.type === 'Opłaty i prowizje') {
                isExempt = true;
                exemptionCategory = 'FEES';
            }

            if (isExempt) {
                exempt.push({ transaction: tx, reason: exemptionCategory });
            } else {
                missing.push(tx);
            }
        }

    }

    // Smart Gmail Search for Missing Invoices
    if (!skipSearch) {
        console.log(`  -> Starting Smart Gmail Search...`);
        const auth = getOAuth2Client();

        // 1. Search for completely missing items
        if (missing.length > 0) {
            console.log(`    -> Searching for ${missing.length} missing items...`);
            for (const tx of missing) {
                const searchResult = await findMissingInvoice(tx, auth);
                tx.gmailStatus = searchResult.found ? 'FOUND' : `NOT FOUND (${searchResult.reason || 'unknown'})`;
                if (searchResult.found) {
                    tx.gmailQuery = searchResult.query;
                    tx.gmailMessageId = searchResult.emailId;
                }
            }
        }

        // 2. Search for missing parts of Partial Matches
        const partialMatches = matched.filter(m => m.invoice.partial);
        if (partialMatches.length > 0) {
            console.log(`    -> Searching for ${partialMatches.length} partial matches (remaining amounts)...`);
            for (const m of partialMatches) {
                const txAmount = Math.abs(m.transaction.amount);
                const invAmount = Math.abs(parseAmount(m.invoice[5]));
                const remaining = txAmount - invAmount;

                if (remaining > 0.01) {
                    console.log(`      -> Checking remaining ${remaining.toFixed(2)} for ${m.transaction.counterparty}...`);
                    const searchResult = await findMissingInvoice(m.transaction, auth, remaining);

                    if (searchResult.found) {
                        m.notes += ` | FOUND REMAINING: ${remaining.toFixed(2)} (Msg: ${searchResult.emailId})`;
                        // Optionally add to "matched" as a secondary invoice?
                        // For now, just note it.
                    } else {
                        m.notes += ` | MISSING REMAINING: ${remaining.toFixed(2)}`;
                    }
                }
            }
        }
    } else {
        console.log(`  -> Skipping Smart Gmail Search (skipSearch=true).`);
    }

    return { matched, missing, exempt };
}

/**
 * Generates a reconciliation report in a new Google Sheet.
 * 
 * @param {Object} reconciliationResult - Result from reconcileTransactions.
 * @param {Object} sheets - Google Sheets API instance.
 * @returns {Promise<string>} - URL of the created spreadsheet.
 */
async function generateReport(reconciliationResult, sheets) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
    const title = `Reconciliation Report - ${dateStr} ${timeStr}`;

    // Create new spreadsheet
    const createRes = await sheets.spreadsheets.create({
        requestBody: {
            properties: { title },
            sheets: [
                { properties: { title: 'Summary' } },
                { properties: { title: 'Missing Invoices' } }, // First tab is usually most important
                { properties: { title: 'Matched Transactions' } },
                { properties: { title: 'Exemptions' } }
            ]
        }
    });

    const spreadsheetId = createRes.data.spreadsheetId;
    const spreadsheetUrl = createRes.data.spreadsheetUrl;

    // Prepare data for Missing Invoices
    const missingRows = [
        ['Date', 'Amount', 'Currency', 'Counterparty', 'Description', 'Gmail Status', 'Gmail Query', 'Raw Transaction'],
        ...reconciliationResult.missing.map(tx => [
            tx.date,
            tx.amount,
            tx.currency,
            tx.counterparty,
            tx.description,
            tx.gmailStatus || 'PENDING',
            tx.gmailQuery || '',
            tx.raw
        ])
    ];

    // Prepare data for Matched Transactions
    const matchedRows = [
        ['Bank Date', 'Bank Amount', 'Bank Counterparty', 'Invoice Number', 'Invoice Date', 'Invoice Amount', 'Seller', 'Score', 'Notes'],
        ...reconciliationResult.matched.map(m => {
            let notes = '';
            let invNumber = m.invoice[3];
            let invAmount = m.invoice[5];

            if (m.additionalInvoices && m.additionalInvoices.length > 0) {
                notes = `Combined with: ${m.additionalInvoices.map(i => i[3]).join(', ')}`;
                invNumber += ' + ' + m.additionalInvoices.length + ' others';
                // Sum amounts for display?
                // invAmount = ...
            }

            return [
                m.transaction.date,
                m.transaction.amount,
                m.transaction.counterparty,
                invNumber,
                m.invoice[4], // Issue Date
                invAmount,
                m.invoice[7], // Seller
                m.score,
                notes
            ];
        })
    ];
    // Calculate Summary Metrics
    const totalTransactions = reconciliationResult.matched.length + reconciliationResult.missing.length + reconciliationResult.exempt.length;
    const totalValue = [...reconciliationResult.matched, ...reconciliationResult.missing, ...reconciliationResult.exempt]
        .reduce((sum, item) => sum + Math.abs(item.transaction ? item.transaction.amount : item.amount), 0);

    const missingValue = reconciliationResult.missing.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const matchedValue = reconciliationResult.matched.reduce((sum, m) => sum + Math.abs(m.transaction.amount), 0);

    const healthScore = totalValue > 0 ? (matchedValue / (totalValue - reconciliationResult.exempt.reduce((s, e) => s + Math.abs(e.transaction.amount), 0))) * 100 : 0;
    const estVatGap = missingValue * 0.23; // Estimate 23% VAT

    // Top 5 Missing by Amount
    const topMissing = [...reconciliationResult.missing]
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 5)
        .map(tx => [tx.date, tx.counterparty, tx.amount, tx.gmailStatus]);

    // Prepare Summary Data
    const summaryRows = [
        ['METRIC', 'VALUE', 'NOTES'],
        ['Reconciliation Date', dateStr, ''],
        ['Health Score', `${healthScore.toFixed(1)}%`, 'Matched Value / (Total - Exempt)'],
        ['', '', ''],
        ['Total Transactions', totalTransactions, ''],
        ['Matched Count', reconciliationResult.matched.length, ''],
        ['Missing Count', reconciliationResult.missing.length, 'ACTION REQUIRED'],
        ['Exempt Count', reconciliationResult.exempt.length, ''],
        ['', '', ''],
        ['Total Missing Value', missingValue.toFixed(2), 'PLN (Gross)'],
        ['Est. VAT to Recover', estVatGap.toFixed(2), 'PLN (Assuming 23%)'],
        ['', '', ''],
        ['TOP 5 MISSING INVOICES', '', ''],
        ['Date', 'Counterparty', 'Amount', 'Gmail Status'],
        ...topMissing
    ];

    // Write to sheets
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
                {
                    range: 'Summary!A1', // New Summary Tab
                    values: summaryRows
                },
                {
                    range: 'Missing Invoices!A1',
                    values: missingRows
                },
                {
                    range: 'Matched Transactions!A1',
                    values: matchedRows
                },
                {
                    range: 'Exemptions!A1',
                    values: [
                        ['Date', 'Amount', 'Counterparty', 'Description', 'Reason'],
                        ...reconciliationResult.exempt.map(e => [
                            e.transaction.date,
                            e.transaction.amount,
                            e.transaction.counterparty,
                            e.transaction.description,
                            e.reason
                        ])
                    ]
                }
            ]
        }
    });

    // Formatting (Optional: Bold headers)
    // ... skipping for brevity, but good to have.

    return spreadsheetUrl;
}

/**
* Finds a subset of invoices that sum up to the target amount.
* Uses a recursive approach (Subset Sum Problem).
*/
function findSubsetSum(invoices, target, tolerance = 0.05) {
    function recurse(index, currentSum, currentSubset) {
        if (Math.abs(currentSum - target) <= tolerance) {
            return currentSubset;
        }
        if (index >= invoices.length || currentSum > target + tolerance) {
            return null;
        }

        // Include current invoice
        const invAmount = Math.abs(parseAmount(invoices[index][5]));
        const withInv = recurse(index + 1, currentSum + invAmount, [...currentSubset, invoices[index]]);
        if (withInv) return withInv;

        // Exclude current invoice
        const withoutInv = recurse(index + 1, currentSum, currentSubset);
        if (withoutInv) return withoutInv;

        return null;
    }

    return recurse(0, 0, []);
}

module.exports = { reconcileTransactions, generateReport };
