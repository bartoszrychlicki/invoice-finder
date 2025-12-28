const retry = require('async-retry');
const logger = require('./logger');

async function withRetry(fn, options = {}) {
    return retry(fn, {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 5000,
        onRetry: (error, attempt) => {
            logger.warn(`Retry attempt ${attempt} for function ${fn.name || 'anonymous'}. Error: ${error.message}`);
        },
        ...options
    });
}

module.exports = { withRetry };
