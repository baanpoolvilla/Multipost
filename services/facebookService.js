const fs = require('fs');
const path = require('path');

const PAGES_PATH = path.join(__dirname, '../data/pages.json');
const LOG_PATH   = process.env.VERCEL ? '/tmp/post.log' : path.join(__dirname, '../logs/post.log');

function loadPages() {
    return JSON.parse(fs.readFileSync(PAGES_PATH, 'utf-8'));
}

function appendLog(entry) {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

// pageIds = array of pageId strings to filter; null = all pages
async function sendToPages(message, pageIds = null) {
    const all = loadPages();
    const pages = pageIds ? all.filter(p => pageIds.includes(p.pageId)) : all;
    const results = [];

    for (const page of pages) {
        await new Promise(r => setTimeout(r, 80));
        const success = Math.random() > 0.1;
        const timestamp = new Date().toISOString();

        const entry = {
            timestamp,
            pageId: page.pageId,
            pageName: page.pageName,
            message,
            status: success ? 'success' : 'failed',
            analytics: success ? {
                likes:             Math.floor(Math.random() * 250) + 10,
                comments:          Math.floor(Math.random() * 40),
                shares:            Math.floor(Math.random() * 20),
                reach:             Math.floor(Math.random() * 2000) + 200,
                followersGained:   Math.floor(Math.random() * 150) + 5,
            } : null,
        };

        appendLog(entry);
        results.push(entry);
    }

    return results;
}

module.exports = { sendToPages };
