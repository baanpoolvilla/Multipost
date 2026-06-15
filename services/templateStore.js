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
}, { versionKey: false });
const Template = mongoose.models.Template || mongoose.model('Template', schema);

async function load() {
    try {
        await connect();
        const docs = await Template.find().sort({ createdAt: -1 }).lean();
        return docs.map(d => ({ ...d, id: d._id }));
    } catch { return fLoad(); }
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

module.exports = { load, create, update, remove, listFolders };
