const { scanEmails } = require('./gmail/index');
const { sendErrorEmail } = require('./gmail/notifier');

module.exports = { scanEmails, sendErrorEmail };
