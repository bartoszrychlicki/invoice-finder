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

module.exports = config;
