const mongoose = require('mongoose');
const path     = require('path');
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

async function remove(filename) {
    try {
        await connect();
        await Image.findByIdAndDelete(filename);
    } catch {}
}

module.exports = { save, getDataUrl, remove };
