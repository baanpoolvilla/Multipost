const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { connect } = require('./jobStore');

const MIME = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' };

const schema = new mongoose.Schema(
    { _id: String, data: String, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.AgentImg || mongoose.model('AgentImg', schema, 'images');

async function save(filename, buffer, contentType) {
    await connect();
    await Image.findByIdAndUpdate(
        filename,
        { $set: { data: buffer.toString('base64'), contentType } },
        { upsert: true }
    );
}

async function getDataUrl(filename) {
    try {
        await connect();
        const doc = await Image.findById(filename).lean();
        if (!doc?.data) return null;
        const ext = path.extname(filename).slice(1).toLowerCase();
        const ct  = doc.contentType || MIME['.'+ext] || 'image/jpeg';
        return `data:${ct};base64,${doc.data}`;
    } catch { return null; }
}

// Download image from MongoDB to a temp file, return absolute path (or null)
async function downloadToTemp(filename) {
    try {
        await connect();
        const doc = await Image.findById(filename).lean();
        if (!doc?.data) return null;
        const tmpPath = path.join(os.tmpdir(), filename);
        fs.writeFileSync(tmpPath, Buffer.from(doc.data, 'base64'));
        return tmpPath;
    } catch { return null; }
}

async function remove(filename) {
    try {
        await connect();
        await Image.findByIdAndDelete(filename);
    } catch {}
}

module.exports = { save, getDataUrl, downloadToTemp, remove };
