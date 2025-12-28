const { google } = require('googleapis');
const { getOAuth2Client } = require('./auth');
const { getAllInvoices, parseAmount, normalizeString } = require('./sheets');
const { findMissingInvoice } = require('./gmail_search');
const config = require('../config.json');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

/**
 * Reconciles bank transactions with existing invoices.
 */
async function reconcileTransactions(transactions, sheets, spreadsheetId, skipSearch = false) {
    const invoices = await getAllInvoices(sheets, spreadsheetId);
    logger.info(`Loaded invoices from registry`, { count: invoices.length });

    const matched = [];
    const missing = [];
    const exempt = [];
    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const [day, month, year] = dateStr.split('-');
        return new Date(`${year}-${month}-${day}`);
    };

    const parseInvoiceDate = (dateStr) => {
        if (!dateStr) return null;
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
        return null;
    };

    for (const tx of transactions) {
        if (tx.amount > 0) {
            continue;
        }

        const txAmount = tx.amount;
        const txDate = parseDate(tx.date);

        let bestMatch = null;
        let bestScore = 0;

        for (const inv of invoices) {
            if (inv.matched) continue;

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

                const txDesc = (tx.counterparty + ' ' + tx.description).toLowerCase();
                const invSeller = (inv[7] || '').toLowerCase();
                if (invSeller && txDesc.includes(invSeller)) score += 10;

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = inv;
                }
            }
        }

        if (!bestMatch) {
            const txDesc = (tx.counterparty + ' ' + tx.description).toLowerCase();

            for (const inv of invoices) {
                if (inv.matched) continue;

                const invNumber = (inv[3] || '').trim().toLowerCase();
                if (invNumber.length < 3) continue;

                if (txDesc.includes(invNumber)) {
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));

                    if (diff < 100 || diff < Math.abs(invAmount) * 0.1) {
                        bestMatch = inv;
                        bestScore = 85;
                        logger.debug(`Fuzzy Match found by invoice number`, { invNumber, diff: diff.toFixed(2) });
                        break;
                    }
                } else if (invNumber.length > 5 && txDesc.replace(/[^a-z0-9]/g, '').includes(invNumber.replace(/[^a-z0-9]/g, ''))) {
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));
                    if (diff < 100 || diff < Math.abs(invAmount) * 0.1) {
                        bestMatch = inv;
                        bestScore = 85;
                        logger.debug(`Fuzzy Match (Normalized) found`, { invNumber, diff: diff.toFixed(2) });
                        break;
                    }
                }
            }
        }

        if (!bestMatch) {
            const txCounterparty = (tx.counterparty || '').toLowerCase();
            const txDesc = (tx.description || '').toLowerCase();

            for (const inv of invoices) {
                if (inv.matched) continue;

                const invSeller = (inv[7] || '').toLowerCase();
                if (!invSeller) continue;

                const sellerMatch = txCounterparty.includes(invSeller) || invSeller.includes(txCounterparty);
                const txFirstWord = txCounterparty.split(' ')[0];
                const invFirstWord = invSeller.split(' ')[0];
                const firstWordMatch = txFirstWord.length > 3 && invFirstWord.length > 3 && txFirstWord === invFirstWord;
                const descMatch = txDesc.includes(invSeller);

                if (sellerMatch || descMatch || firstWordMatch) {
                    const invAmount = parseAmount(inv[5]);
                    const diff = Math.abs(Math.abs(txAmount) - Math.abs(invAmount));

                    if (diff < 50 || diff < Math.abs(invAmount) * 0.05) {
                        bestMatch = inv;
                        bestScore = 75;
                        logger.debug(`Counterparty+Fuzzy Amount Match!`, { invSeller, diff: diff.toFixed(2) });
                        break;
                    }

                    if (Math.abs(txAmount) > Math.abs(invAmount) + 50) {
                        if (bestScore < 70) {
                            bestMatch = inv;
                            bestScore = 70;
                            bestMatch.partial = true;
                            bestMatch.notes = `Partial Match. Remaining: ${(Math.abs(txAmount) - Math.abs(invAmount)).toFixed(2)}`;
                            logger.debug(`Partial Match found`, { invSeller, tx: Math.abs(txAmount), inv: Math.abs(invAmount) });
                        }
                    }
                }
            }
        }

        if (!bestMatch) {
            const txCounterparty = (tx.counterparty || '').toLowerCase();
            const candidates = invoices.filter(inv => {
                if (inv.matched) return false;
                const invSeller = (inv[7] || '').toLowerCase();
                return invSeller && (txCounterparty.includes(invSeller) || invSeller.includes(txCounterparty));
            });

            if (candidates.length > 1 && candidates.length < 10) {
                const target = Math.abs(txAmount);
                const combo = findSubsetSum(candidates, target);
                if (combo) {
                    bestMatch = combo[0];
                    bestScore = 95;
                    bestMatch.additionalInvoices = combo.slice(1);
                    logger.info(`Combination Match found`, { count: combo.length, target });
                }
            }
        }

        if (bestMatch && bestScore >= 70) {
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

    if (!skipSearch) {
        logger.info(`Starting Smart Gmail Search`);
        const auth = getOAuth2Client();

        if (missing.length > 0) {
            logger.info(`Searching for missing items`, { count: missing.length });
            for (const tx of missing) {
                const searchResult = await findMissingInvoice(tx, auth);
                tx.gmailStatus = searchResult.found ? 'FOUND' : `NOT FOUND (${searchResult.reason || 'unknown'})`;
                if (searchResult.found) {
                    tx.gmailQuery = searchResult.query;
                    tx.gmailMessageId = searchResult.emailId;
                }
            }
        }

        const partialMatches = matched.filter(m => m.invoice.partial);
        if (partialMatches.length > 0) {
            logger.info(`Searching for partial match remaining amounts`, { count: partialMatches.length });
            for (const m of partialMatches) {
                const txAmount = Math.abs(m.transaction.amount);
                const invAmount = Math.abs(parseAmount(m.invoice[5]));
                const remaining = txAmount - invAmount;

                if (remaining > 0.01) {
                    logger.debug(`Checking remaining amount`, { counterparty: m.transaction.counterparty, remaining: remaining.toFixed(2) });
                    const searchResult = await findMissingInvoice(m.transaction, auth, remaining);

                    if (searchResult.found) {
                        m.notes += ` | FOUND REMAINING: ${remaining.toFixed(2)} (Msg: ${searchResult.emailId})`;
                    } else {
                        m.notes += ` | MISSING REMAINING: ${remaining.toFixed(2)}`;
                    }
                }
            }
        }
    } else {
        logger.info(`Skipping Smart Gmail Search (skipSearch=true).`);
    }

    return { matched, missing, exempt };
}

/**
 * Generates a reconciliation report in a new Google Sheet.
 */
async function generateReport(reconciliationResult, sheets) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
    const title = `Reconciliation Report - ${dateStr} ${timeStr}`;

    logger.info(`Generating report`, { title });

    const createRes = await withRetry(() => sheets.spreadsheets.create({
        requestBody: {
            properties: { title },
            sheets: [
                { properties: { title: 'Summary' } },
                { properties: { title: 'Missing Invoices' } },
                { properties: { title: 'Matched Transactions' } },
                { properties: { title: 'Exemptions' } }
            ]
        }
    }));

    const spreadsheetId = createRes.data.spreadsheetId;
    const spreadsheetUrl = createRes.data.spreadsheetUrl;

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

    const matchedRows = [
        ['Bank Date', 'Bank Amount', 'Bank Counterparty', 'Invoice Number', 'Invoice Date', 'Invoice Amount', 'Seller', 'Score', 'Notes'],
        ...reconciliationResult.matched.map(m => {
            let notes = '';
            let invNumber = m.invoice[3];
            let invAmount = m.invoice[5];

            if (m.additionalInvoices && m.additionalInvoices.length > 0) {
                notes = `Combined with: ${m.additionalInvoices.map(i => i[3]).join(', ')}`;
                invNumber += ' + ' + m.additionalInvoices.length + ' others';
            }

            return [
                m.transaction.date,
                m.transaction.amount,
                m.transaction.counterparty,
                invNumber,
                m.invoice[4],
                invAmount,
                m.invoice[7],
                m.score,
                notes
            ];
        })
    ];

    const totalTransactions = reconciliationResult.matched.length + reconciliationResult.missing.length + reconciliationResult.exempt.length;
    const totalValue = [...reconciliationResult.matched, ...reconciliationResult.missing, ...reconciliationResult.exempt]
        .reduce((sum, item) => sum + Math.abs(item.transaction ? item.transaction.amount : item.amount), 0);

    const missingValue = reconciliationResult.missing.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const matchedValue = reconciliationResult.matched.reduce((sum, m) => sum + Math.abs(m.transaction.amount), 0);

    const healthScore = totalValue > 0 ? (matchedValue / (totalValue - reconciliationResult.exempt.reduce((s, e) => s + Math.abs(e.transaction.amount), 0))) * 100 : 0;
    const estVatGap = missingValue * 0.23;

    const topMissing = [...reconciliationResult.missing]
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 5)
        .map(tx => [tx.date, tx.counterparty, tx.amount, tx.gmailStatus]);

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

    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
                {
                    range: 'Summary!A1',
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
    }));

    logger.info(`Report generated successfully`, { spreadsheetId });
    return spreadsheetUrl;
}

/**
* Finds a subset of invoices that sum up to the target amount.
*/
function findSubsetSum(invoices, target, tolerance = 0.05) {
    function recurse(index, currentSum, currentSubset) {
        if (Math.abs(currentSum - target) <= tolerance) {
            return currentSubset;
        }
        if (index >= invoices.length || currentSum > target + tolerance) {
            return null;
        }

        const invAmount = Math.abs(parseAmount(invoices[index][5]));
        const withInv = recurse(index + 1, currentSum + invAmount, [...currentSubset, invoices[index]]);
        if (withInv) return withInv;

        const withoutInv = recurse(index + 1, currentSum, currentSubset);
        if (withoutInv) return withoutInv;

        return null;
    }

    return recurse(0, 0, []);
}

module.exports = { reconcileTransactions, generateReport };

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
