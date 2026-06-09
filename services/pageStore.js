const fs   = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '../data/pages.json'); // bundled read-only copy
const FILE   = process.env.VERCEL ? '/tmp/pages.json' : SOURCE;

function load() {
    // On Vercel, seed /tmp/pages.json from bundled file on first access
    if (process.env.VERCEL && !fs.existsSync(FILE)) {
        try { fs.copyFileSync(SOURCE, FILE); } catch {}
    }
    try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
    catch { return []; }
}

function save(pages) {
    fs.writeFileSync(FILE, JSON.stringify(pages, null, 2), 'utf-8');
}

function add(data) {
    const pages = load();
    if (pages.find(p => p.pageId === data.pageId)) return { error: 'Page ID ซ้ำ' };
    pages.push(data);
    save(pages);
    return { ok: true, page: data };
}

function update(pageId, data) {
    const pages = load();
    const idx = pages.findIndex(p => p.pageId === pageId);
    if (idx === -1) return null;
    pages[idx] = { ...pages[idx], ...data };
    save(pages);
    return pages[idx];
}

function remove(pageId) {
    const pages = load();
    const page = pages.find(p => p.pageId === pageId);
    if (!page) return null;
    save(pages.filter(p => p.pageId !== pageId));
    return page;
}

function saveAll(pages) { save(pages); }

module.exports = { load, add, update, remove, saveAll };
