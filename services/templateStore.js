const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

const FILE = process.env.VERCEL ? '/tmp/templates.json' : path.join(__dirname, '../data/templates.json');
function fLoad() { try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return []; } }
function fSave(t) { fs.writeFileSync(FILE, JSON.stringify(t, null, 2), 'utf-8'); }

const schema = new mongoose.Schema({
    _id: String, name: String, message: String, images: [String], createdAt: String,
    folder: { type: String, default: null },
    order:  { type: Number, default: 0 }, // drag-and-drop manual order within a folder
}, { versionKey: false });
const Template = mongoose.models.Template || mongoose.model('Template', schema);

async function load() {
    try {
        await connect();
        // order ascending first (drag-and-drop position), createdAt desc as
        // the tiebreaker — every template starts at order:0, so until the
        // user actually reorders something this is just "newest first" as before.
        const docs = await Template.find().sort({ order: 1, createdAt: -1 }).lean();
        return docs.map(d => ({ ...d, id: d._id }));
    } catch { return fLoad().sort((a,b) => (a.order||0)-(b.order||0)); }
}

async function create(data) {
    const id  = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const doc = { _id: id, id, createdAt: new Date().toISOString(), ...data };
    try { await connect(); await Template.create(doc); }
    catch { const list = fLoad(); list.unshift(doc); fSave(list); }
    return doc;
}

async function update(id, data) {
    try {
        await connect();
        const d = await Template.findByIdAndUpdate(id, data, { new: true }).lean();
        return d ? { ...d, id: d._id } : null;
    } catch {
        const list = fLoad();
        const idx  = list.findIndex(t => t.id === id);
        if (idx < 0) return null;
        list[idx] = { ...list[idx], ...data };
        fSave(list);
        return list[idx];
    }
}

async function remove(id) {
    try {
        await connect();
        const d = await Template.findByIdAndDelete(id).lean();
        return d ? { ...d, id: d._id } : null;
    } catch {
        const list = fLoad();
        const t = list.find(t => t.id === id);
        if (!t) return null;
        fSave(list.filter(t => t.id !== id));
        return t;
    }
}

async function listFolders() {
    try {
        const templates = await load();
        const folders = [...new Set(templates.map(t => t.folder).filter(Boolean))].sort();
        return folders;
    } catch { return []; }
}

// Bulk Add / Move / Remove (Part 7) — re-assign many already-saved
// templates to a folder (or null to remove from any folder) in one go,
// instead of opening each one's edit modal to retype the folder name.
async function bulkSetFolder(ids, folder) {
    try {
        await connect();
        await Template.updateMany({ _id: { $in: ids } }, { $set: { folder: folder || null } });
    } catch {
        const list = fLoad();
        list.forEach(t => { if (ids.includes(t.id)) t.folder = folder || null; });
        fSave(list);
    }
    return load();
}

async function bulkDelete(ids) {
    try {
        await connect();
        await Template.deleteMany({ _id: { $in: ids } });
    } catch {
        const list = fLoad().filter(t => !ids.includes(t.id));
        fSave(list);
    }
    return load();
}

// Drag & Drop Reorder — orderedIds is the full list of ids within a
// folder (or root) in the new display order.
async function reorder(orderedIds) {
    try {
        await connect();
        await Promise.all(orderedIds.map((id, i) => Template.findByIdAndUpdate(id, { $set: { order: i } })));
    } catch {
        const list = fLoad();
        orderedIds.forEach((id, i) => { const t = list.find(x => x.id === id); if (t) t.order = i; });
        fSave(list);
    }
    return load();
}

module.exports = { load, create, update, remove, listFolders, bulkSetFolder, bulkDelete, reorder };
