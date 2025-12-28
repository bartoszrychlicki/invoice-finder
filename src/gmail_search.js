const { google } = require('googleapis');
const { generateSearchQueries } = require('./openai');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

/**
 * Searches Gmail for a missing invoice transaction.
 */
async function findMissingInvoice(transaction, auth, searchAmount = null) {
    if (transaction.amount > 0) {
        logger.debug(`Skipping search: Income transaction`, { amount: transaction.amount });
        return { found: false, reason: 'income' };
    }

    const internalKeywords = [
        'RYCHLICKI HOLDING',
        'Bartosz Rychlicki',
        'Wewnętrzny',
        'ZUS',
        'Urząd Skarbowy'
    ];

    const counterparty = (transaction.counterparty || '').toLowerCase();
    const description = (transaction.description || '').toLowerCase();

    if (internalKeywords.some(k => counterparty.includes(k.toLowerCase()) || description.includes(k.toLowerCase()))) {
        logger.debug(`Skipping search: Internal/Tax transaction`, { counterparty: transaction.counterparty });
        return { found: false, reason: 'internal' };
    }

    const targetAmount = searchAmount ? Math.abs(searchAmount) : Math.abs(transaction.amount);
    logger.info(`Generating search queries`, { counterparty: transaction.counterparty, target: targetAmount });

    const deterministicQueries = [];
    const amountStr = targetAmount.toFixed(2).replace('.', ',');
    const amountStrDot = targetAmount.toFixed(2);

    deterministicQueries.push(`"${amountStr}" faktura`);
    deterministicQueries.push(`"${amountStrDot}" invoice`);

    if (transaction.counterparty) {
        const cleanName = transaction.counterparty.split(',')[0].replace(/Sp\.? z o\.?o\.?/i, '').trim();
        if (cleanName.length > 3) {
            deterministicQueries.push(`"${cleanName}" faktura`);
            deterministicQueries.push(`"${cleanName}" invoice`);
            deterministicQueries.push(`from:"${cleanName}" has:attachment`);
        }
    }

    const desc = transaction.description || '';
    const potentialNumbers = desc.match(/[A-Z0-9\/-]{5,}/g);
    if (potentialNumbers) {
        potentialNumbers.forEach(num => {
            if (!num.match(/^\d{26}$/) && !num.match(/^\d{4}-\d{2}-\d{2}$/)) {
                deterministicQueries.push(`"${num}"`);
            }
        });
    }

    let queries = [...deterministicQueries];

    if (queries.length < 5) {
        const aiQueries = await generateSearchQueries(transaction);
        if (aiQueries) queries = [...queries, ...aiQueries];
    }

    queries = [...new Set(queries)];

    if (!queries || queries.length === 0) {
        logger.warn(`No queries generated for transaction`, { counterparty: transaction.counterparty });
        return { found: false, reason: 'no_queries' };
    }

    const gmail = google.gmail({ version: 'v1', auth });

    for (const query of queries) {
        logger.debug(`Trying Gmail search query`, { query });
        try {
            const res = await withRetry(() => gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 5
            }));

            if (res.data.messages && res.data.messages.length > 0) {
                for (const message of res.data.messages) {
                    const hasAttachment = await checkForInvoiceAttachment(gmail, message.id);
                    if (hasAttachment) {
                        logger.info(`Invoice found via Gmail search`, { query, messageId: message.id });
                        return { found: true, emailId: message.id, query: query };
                    }
                }
                logger.debug(`Found messages but none have invoice attachments`, { query, count: res.data.messages.length });
            }
        } catch (error) {
            logger.error(`Error executing Gmail search query`, { query, error: error.message });
        }
    }

    logger.info(`Invoice not found after multiple queries`, { counterparty: transaction.counterparty });
    return { found: false, reason: 'not_found' };
}


/**
 * Checks if a message has an invoice attachment.
 */
async function checkForInvoiceAttachment(gmail, messageId) {
    try {
        const message = await withRetry(() => gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['Subject']
        }));

        if (message.data.payload && message.data.payload.parts) {
            for (const part of message.data.payload.parts) {
                const filename = (part.filename || '').toLowerCase();

                if (filename && (
                    filename.endsWith('.pdf') ||
                    filename.endsWith('.jpg') ||
                    filename.endsWith('.jpeg') ||
                    filename.endsWith('.png')
                )) {
                    if (part.body && part.body.attachmentId) {
                        return true;
                    }
                }
            }
        }

        return false;
    } catch (error) {
        logger.error(`Error checking attachment`, { messageId, error: error.message });
        return false;
    }
}

module.exports = { findMissingInvoice };
