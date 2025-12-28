const express = require('express');
const { scanEmails } = require('./gmail');
const { getRecentExecutions } = require('./audit_log');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Gmail Invoice Scanner is running.');
});

app.get('/health', async (req, res) => {
  try {
    const { checkTokenHealth } = require('./auth');
    await checkTokenHealth();

    const logs = await getRecentExecutions(7);

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      execution_logs: logs
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/scan', async (req, res) => {
  try {
    logger.info('Starting scan...');
    const testMode = req.query.test === 'true';
    const hours = parseInt(req.query.hours) || 24;

    if (testMode) {
      logger.warn('RUNNING IN TEST MODE: Email sending will be skipped.');
    }
    logger.info(`Scanning emails`, { hours });

    const result = await scanEmails(testMode, hours);
    logger.info('Scan complete', { resultCount: result.length });
    res.status(200).send({ status: 'success', data: result });
  } catch (error) {
    logger.error('Error during scan', { error: error.message, stack: error.stack });
    res.status(500).send({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
