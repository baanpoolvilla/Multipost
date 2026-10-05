const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

/* ── File fallback ── */
const SOURCE = path.join(__dirname, '../data/pages.json');
const FILE   = process.env.VERCEL ? '/tmp/pages.json' : SOURCE;
function fLoad() {
    if (process.env.VERCEL && !fs.existsSync(FILE)) { try { fs.copyFileSync(SOURCE, FILE); } catch {} }
    try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return []; }
}
function fSave(p) { fs.writeFileSync(FILE, JSON.stringify(p, null, 2), 'utf-8'); }

/* ── Mongoose model ── */
const groupSchema = new mongoose.Schema({
    groupId: String, groupName: String,
    source:  { type: String, default: 'manual' },
    enabled: { type: Boolean, default: true },
}, { _id: false });

const pageSchema = new mongoose.Schema({
    pageId:      { type: String, required: true, unique: true },
    pageName:    String,
    accessToken: String,
    tokenExpiry: String,
    enabled:     { type: Boolean, default: true },
    groups:      { type: [groupSchema], default: [] },
}, { versionKey: false });

const Page = mongoose.models.Page || mongoose.model('Page', pageSchema);

async function load() {
    try { await connect(); return Page.find().lean(); }
    catch { return fLoad(); }
}

async function add(data) {
    try {
        await connect();
        if (await Page.findOne({ pageId: data.pageId })) return { error: 'Page ID ซ้ำ' };
        const page = await Page.create({ ...data, groups: [] });
        return { ok: true, page: page.toObject() };
    } catch {
        const pages = fLoad();
        if (pages.find(p => p.pageId === data.pageId)) return { error: 'Page ID ซ้ำ' };
        pages.push({ ...data, groups: [] }); fSave(pages);
        return { ok: true, page: data };
    }
}

async function update(pageId, data) {
    try {
        await connect();
        return Page.findOneAndUpdate({ pageId }, { $set: data }, { new: true }).lean();
    } catch {
        const pages = fLoad();
        const idx = pages.findIndex(p => p.pageId === pageId);
        if (idx === -1) return null;
        pages[idx] = { ...pages[idx], ...data }; fSave(pages);
        return pages[idx];
    }
}

async function remove(pageId) {
    try { await connect(); return Page.findOneAndDelete({ pageId }).lean(); }
    catch {
        const pages = fLoad();
        const page  = pages.find(p => p.pageId === pageId);
        if (!page) return null;
        fSave(pages.filter(p => p.pageId !== pageId));
        return page;
    }
}

async function saveAll(pages) {
    try {
        await connect();
        for (const p of pages)
            await Page.findOneAndUpdate({ pageId: p.pageId }, { $set: p }, { upsert: true });
    } catch { fSave(pages); }
}

async function syncGroups(pageId, fbGroups) {
    try {
        await connect();
        const page = await Page.findOne({ pageId }).lean();
        if (!page) return null;
        const merged = [...(page.groups || [])];
        for (const g of fbGroups) {
            const idx = merged.findIndex(e => e.groupId === g.groupId);
            if (idx === -1) merged.push({ ...g, source: 'facebook', enabled: true });
            else { merged[idx].groupName = g.groupName; merged[idx].source = 'facebook'; }
        }
        return Page.findOneAndUpdate({ pageId }, { $set: { groups: merged } }, { new: true }).lean();
    } catch {
        const pages = fLoad();
        const page  = pages.find(p => p.pageId === pageId);
        if (!page) return null;
        const merged = [...(page.groups || [])];
        for (const g of fbGroups) {
            const idx = merged.findIndex(e => e.groupId === g.groupId);
            if (idx === -1) merged.push({ ...g, source: 'facebook', enabled: true });
            else { merged[idx].groupName = g.groupName; }
        }
        page.groups = merged; fSave(pages);
        return page;
    }
}

async function addGroup(pageId, groupId, groupName) {
    try {
        await connect();
        const page = await Page.findOne({ pageId }).lean();
        if (!page) return null;
        if ((page.groups || []).find(g => g.groupId === groupId)) return { error: 'กลุ่มนี้มีอยู่แล้ว' };
        return Page.findOneAndUpdate(
            { pageId },
            { $push: { groups: { groupId, groupName, source: 'manual', enabled: true } } },
            { new: true }
        ).lean();
    } catch {
        const pages = fLoad();
        const page  = pages.find(p => p.pageId === pageId);
        if (!page) return null;
        if ((page.groups || []).find(g => g.groupId === groupId)) return { error: 'กลุ่มนี้มีอยู่แล้ว' };
        page.groups = [...(page.groups || []), { groupId, groupName, source: 'manual', enabled: true }];
        fSave(pages); return page;
    }
}

async function removeGroup(pageId, groupId) {
    try {
        await connect();
        return Page.findOneAndUpdate({ pageId }, { $pull: { groups: { groupId } } }, { new: true }).lean();
    } catch {
        const pages = fLoad();
        const page  = pages.find(p => p.pageId === pageId);
        if (!page) return null;
        page.groups = (page.groups || []).filter(g => g.groupId !== groupId);
        fSave(pages); return page;
    }
}

async function toggleGroup(pageId, groupId, enabled) {
    try {
        await connect();
        return Page.findOneAndUpdate(
            { pageId, 'groups.groupId': groupId },
            { $set: { 'groups.$.enabled': enabled } },
            { new: true }
        ).lean();
    } catch {
        const pages = fLoad();
        const page  = pages.find(p => p.pageId === pageId);
        if (!page) return null;
        const g = (page.groups || []).find(g => g.groupId === groupId);
        if (g) { g.enabled = enabled; fSave(pages); }
        return page;
    }
}

// ── Sidebar list ("เพจของคุณ"), rendered on every page ──────────────
// Only the name and a group count are shown, so fetch just those (not the
// access tokens and full group lists) and keep the answer for a minute:
// a full Page.find() on every click was one of the reasons navigation felt
// slow. Writes made through this module drop the cache at once; changes made
// elsewhere (Desktop Agent, another server instance) show up within the TTL.
const SIDEBAR_TTL_MS = 60 * 1000;
let sidebarCache = null; // { at, pages }
let sidebarInflight = null;

function invalidateSidebar() { sidebarCache = null; }

async function loadSidebar() {
    if (sidebarCache && Date.now() - sidebarCache.at < SIDEBAR_TTL_MS) return sidebarCache.pages;
    if (sidebarInflight) return sidebarInflight;
    sidebarInflight = (async () => {
        try {
            await connect();
            const pages = await Page.find({ enabled: { $ne: false } })
                .select('pageId pageName enabled groups.groupId').lean();
            sidebarCache = { at: Date.now(), pages };
            return pages;
        } catch {
            return fLoad().filter(p => p.enabled !== false);
        } finally {
            sidebarInflight = null;
        }
    })();
    return sidebarInflight;
}

const invalidating = fn => async (...args) => {
    try { return await fn(...args); } finally { invalidateSidebar(); }
};

module.exports = {
    load, loadSidebar,
    add:         invalidating(add),
    update:      invalidating(update),
    remove:      invalidating(remove),
    saveAll:     invalidating(saveAll),
    syncGroups:  invalidating(syncGroups),
    addGroup:    invalidating(addGroup),
    removeGroup: invalidating(removeGroup),
    toggleGroup: invalidating(toggleGroup),
};
