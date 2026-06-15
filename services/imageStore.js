const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');
const supa = require('./supabaseStore');

const UPLOADS_DIR = process.env.VERCEL
    ? '/tmp/uploads'
    : path.join(__dirname, '../public/uploads');

const MIME = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
    mp4:'video/mp4', mov:'video/quicktime', avi:'video/x-msvideo', webm:'video/webm',
};

// Legacy: images stored as base64 in MongoDB
const imgSchema = new mongoose.Schema(
    { _id: String, data: String, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.Image || mongoose.model('Image', imgSchema);

// New: Supabase URL index (lightweight reference)
const idxSchema = new mongoose.Schema(
    { _id: String, url: String, contentType: String },
    { versionKey: false }
);
const MediaIndex = mongoose.models.MediaIndex || mongoose.model('MediaIndex', idxSchema, 'mediaindex');

async function save(filename, buffer, contentType) {
    try {
        const url = await supa.upload(filename, buffer, contentType);
        // Index the URL so /uploads/:filename can redirect
        try {
            await connect();
            await MediaIndex.findByIdAndUpdate(filename, { $set: { url, contentType } }, { upsert: true });
        } catch {}
        return url;
    } catch (e) {
        console.warn('[imageStore.save] Supabase upload failed:', e.message, '— falling back to disk/MongoDB');
    }

    // Fallback: old behaviour (disk + MongoDB base64 for images)
    const ext     = path.extname(filename).slice(1).toLowerCase();
    const isVideo = new Set(['mp4','mov','avi','webm']).has(ext);
    if (!isVideo) {
        try {
            await connect();
            await Image.findByIdAndUpdate(filename, { $set: { data: buffer.toString('base64'), contentType } }, { upsert: true });
        } catch {}
    }
    if (!process.env.VERCEL) {
        try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer); } catch {}
    }
    return null;
}

async function getPublicUrl(filename) {
    if (!filename) return null;
    if (filename.startsWith('http')) return filename;
    // Check Supabase index
    try {
        await connect();
        const doc = await MediaIndex.findById(filename).lean();
        if (doc?.url) return doc.url;
    } catch {}
    // Don't construct a Supabase URL blindly — the file may only be in MongoDB
    // (uploaded by Agent as fallback). Returning a guessed URL causes the /uploads
    // route to redirect to a 404 instead of falling back to MongoDB base64.
    return null;
}

async function getBuffer(filename) {
    if (!filename) return null;
    const ext = path.extname(filename).slice(1).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';

    // URL (Supabase) → fetch
    const publicUrl = await getPublicUrl(filename);
    if (publicUrl?.startsWith('http')) {
        try {
            const res = await fetch(publicUrl);
            if (res.ok) return { buffer: Buffer.from(await res.arrayBuffer()), contentType: ct };
        } catch {}
    }

    // Legacy: MongoDB base64
    try {
        await connect();
        const doc = await Image.findById(filename).lean();
        if (doc?.data) return { buffer: Buffer.from(doc.data, 'base64'), contentType: doc.contentType || ct };
    } catch {}

    // Local disk fallback
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) return { buffer: fs.readFileSync(filePath), contentType: ct };
    return null;
}

async function exists(filename) {
    if (!filename) return false;
    if (filename.startsWith('http')) {
        try { const r = await fetch(filename, { method: 'HEAD' }); return r.ok; } catch { return false; }
    }
    const url = await getPublicUrl(filename);
    if (url?.startsWith('http')) {
        try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch {}
    }
    try {
        await connect();
        if (await MediaIndex.countDocuments({ _id: filename }) > 0) return true;
        if (await Image.countDocuments({ _id: filename }) > 0) return true;
    } catch {}
    return fs.existsSync(path.join(UPLOADS_DIR, filename));
}

async function remove(filename) {
    if (!filename) return;
    if (filename.startsWith('http')) {
        await supa.remove(filename);
    } else {
        await supa.remove(filename);
        try { await connect(); await MediaIndex.findByIdAndDelete(filename); await Image.findByIdAndDelete(filename); } catch {}
        try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch {}
    }
}

module.exports = { save, getPublicUrl, getBuffer, exists, remove };
