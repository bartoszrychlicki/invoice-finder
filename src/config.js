const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');

let config = {};

try {
    if (fs.existsSync(configPath)) {
        const rawData = fs.readFileSync(configPath);
        config = JSON.parse(rawData);
    } else {
        console.warn(`Config file not found at ${configPath}. Using defaults or environment variables if available.`);
    }
} catch (error) {
    console.error(`Error loading config from ${configPath}:`, error);
}

// Allow environment variables to override config file
config.admin_email = process.env.ADMIN_EMAIL || config.admin_email;
config.infakt_api_key = process.env.INFAKT_API_KEY || config.infakt_api_key;
config.check_infakt_duplicates = process.env.CHECK_INFAKT_DUPLICATES === 'false' ? false : (config.check_infakt_duplicates !== false);

module.exports = config;
