const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

const FILE = process.env.VERCEL ? '/tmp/settings.json' : path.join(__dirname, '../data/settings.json');
function fLoad() { try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return { fbAppId: '', fbAppSecret: '' }; } }
function fSave(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2), 'utf-8'); }

const schema = new mongoose.Schema({
    _id: { type: String, default: 'main' },
    fbAppId: { type: String, default: '' },
    fbAppSecret: { type: String, default: '' },
}, { versionKey: false });
const Settings = mongoose.models.Settings || mongoose.model('Settings', schema);

async function load() {
    const fromEnv = { fbAppId: process.env.FB_APP_ID || '', fbAppSecret: process.env.FB_APP_SECRET || '' };
    try {
        await connect();
        const s = await Settings.findById('main').lean();
        return { fbAppId: fromEnv.fbAppId || (s && s.fbAppId) || '', fbAppSecret: fromEnv.fbAppSecret || (s && s.fbAppSecret) || '' };
    } catch {
        const f = fLoad();
        return { fbAppId: fromEnv.fbAppId || f.fbAppId || '', fbAppSecret: fromEnv.fbAppSecret || f.fbAppSecret || '' };
    }
}

async function save(data) {
    try { await connect(); await Settings.findByIdAndUpdate('main', { $set: data }, { upsert: true }); }
    catch { fSave(data); }
}

module.exports = { load, save };
