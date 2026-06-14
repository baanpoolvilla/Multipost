const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { connect } = require('./jobStore');
const supa     = require('./supabaseStore');

const MIME = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' };

// Legacy: images stored as base64 in MongoDB
const schema = new mongoose.Schema(
    { _id: String, data: String, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.AgentImg || mongoose.model('AgentImg', schema, 'images');

async function save(filename, buffer, contentType) {
    // Try Supabase first
    try {
        return await supa.upload(filename, buffer, contentType);
    } catch (e) {
        console.warn('[agentImageStore.save] Supabase failed:', e.message, '— falling back to MongoDB');
    }
    // Fallback: MongoDB base64
    await connect();
    await Image.findByIdAndUpdate(
        filename,
        { $set: { data: buffer.toString('base64'), contentType } },
        { upsert: true }
    );
    return null;
}

async function getDataUrl(filenameOrUrl) {
    try {
        // Supabase URL → fetch
        if (filenameOrUrl.startsWith('http')) {
            const res = await fetch(filenameOrUrl);
            if (res.ok) {
                const buf  = Buffer.from(await res.arrayBuffer());
                const ext  = path.extname(new URL(filenameOrUrl).pathname).toLowerCase();
                const ct   = MIME[ext] || 'image/jpeg';
                return `data:${ct};base64,${buf.toString('base64')}`;
            }
        }
        // Check Supabase by constructed URL
        const supaUrl = supa.publicUrl(filenameOrUrl);
        if (supaUrl) {
            const res = await fetch(supaUrl);
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                const ext = path.extname(filenameOrUrl).toLowerCase();
                const ct  = MIME[ext] || 'image/jpeg';
                return `data:${ct};base64,${buf.toString('base64')}`;
            }
        }
    } catch {}

    // Legacy MongoDB fallback
    try {
        await connect();
        const doc = await Image.findById(filenameOrUrl).lean();
        if (!doc?.data) return null;
        const ext = path.extname(filenameOrUrl).slice(1).toLowerCase();
        const ct  = doc.contentType || MIME['.' + ext] || 'image/jpeg';
        return `data:${ct};base64,${doc.data}`;
    } catch { return null; }
}

async function downloadToTemp(filenameOrUrl) {
    try {
        // Supabase URL
        const url = filenameOrUrl.startsWith('http') ? filenameOrUrl : supa.publicUrl(filenameOrUrl);
        if (url) {
            const res = await fetch(url);
            if (res.ok) {
                const ext     = path.extname(new URL(url).pathname) || path.extname(filenameOrUrl);
                const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()));
                return tmpPath;
            }
        }
    } catch {}

    // Legacy MongoDB fallback
    try {
        await connect();
        const doc = await Image.findById(filenameOrUrl).lean();
        if (!doc?.data) return null;
        const tmpPath = path.join(os.tmpdir(), filenameOrUrl);
        fs.writeFileSync(tmpPath, Buffer.from(doc.data, 'base64'));
        return tmpPath;
    } catch { return null; }
}

async function remove(filenameOrUrl) {
    try { await supa.remove(filenameOrUrl); } catch {}
    try { await connect(); await Image.findByIdAndDelete(filenameOrUrl); } catch {}
}

module.exports = { save, getDataUrl, downloadToTemp, remove };
