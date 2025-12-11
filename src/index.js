require('dotenv').config();
const express = require('express');
const { scanEmails } = require('./gmail');
const { getRecentExecutions } = require('./audit_log');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Gmail Invoice Scanner is running.');
});

app.get('/health', async (req, res) => {
  try {
    const { checkTokenHealth } = require('./auth');
    await checkTokenHealth();

    const logs = await getRecentExecutions(7); // Last 7 days

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      execution_logs: logs
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/scan', async (req, res) => {
  try {
    console.log('Starting scan...');
    const testMode = req.query.test === 'true';
    const hours = parseInt(req.query.hours) || 24;

    if (testMode) {
      console.log('⚠️  RUNNING IN TEST MODE: Email sending will be skipped.');
    }
    console.log(`📅 Scanning emails from the last ${hours} hours`);

    const result = await scanEmails(testMode, hours);
    console.log('Scan complete:', result);
    res.status(200).send({ status: 'success', data: result });
  } catch (error) {
    console.error('Error during scan:', error);
    res.status(500).send({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
