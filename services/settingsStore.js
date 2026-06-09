const fs   = require('fs');
const path = require('path');

const FILE = process.env.VERCEL
    ? '/tmp/settings.json'
    : path.join(__dirname, '../data/settings.json');

function load() {
    // Env vars take priority (Vercel dashboard / .env)
    const fromEnv = {
        fbAppId:     process.env.FB_APP_ID     || '',
        fbAppSecret: process.env.FB_APP_SECRET || '',
    };
    try {
        const file = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        return {
            fbAppId:     fromEnv.fbAppId     || file.fbAppId     || '',
            fbAppSecret: fromEnv.fbAppSecret || file.fbAppSecret || '',
        };
    } catch {
        return fromEnv;
    }
}

function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { load, save };
