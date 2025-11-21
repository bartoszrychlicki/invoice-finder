require('dotenv').config();
const express = require('express');
const { scanEmails } = require('./gmail');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Gmail Invoice Scanner is running.');
});

app.post('/scan', async (req, res) => {
  try {
    console.log('Starting scan...');
    const testMode = req.query.test === 'true';
    if (testMode) {
      console.log('⚠️  RUNNING IN TEST MODE: Email sending will be skipped.');
    }
    const result = await scanEmails(testMode);
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
