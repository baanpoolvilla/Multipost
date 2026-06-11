const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

const UPLOADS_DIR = process.env.VERCEL
    ? '/tmp/uploads'
    : path.join(__dirname, '../public/uploads');

const MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };

const schema = new mongoose.Schema(
    { _id: String, data: Buffer, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.Image || mongoose.model('Image', schema);

async function save(filename, buffer, contentType) {
    // Always persist in MongoDB
    try {
        await connect();
        await Image.findByIdAndUpdate(
            filename,
            { $set: { data: buffer, contentType } },
            { upsert: true }
        );
    } catch (e) {
        console.warn('[imageStore.save] MongoDB failed:', e.message);
    }
    // Also write to local disk (for local dev static serving)
    if (!process.env.VERCEL) {
        try {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
            fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
        } catch {}
    }
}

async function getBuffer(filename) {
    // Try MongoDB first (works on Vercel + local)
    try {
        await connect();
        const img = await Image.findById(filename).lean();
        if (img?.data) {
            const ext = path.extname(filename).slice(1).toLowerCase();
            return { buffer: Buffer.from(img.data), contentType: img.contentType || MIME[ext] || 'image/jpeg' };
        }
    } catch {}
    // Fallback: read from disk (local dev, or images uploaded before this change)
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(filename).slice(1).toLowerCase();
        return { buffer, contentType: MIME[ext] || 'image/jpeg' };
    }
    return null;
}

async function remove(filename) {
    try { await connect(); await Image.findByIdAndDelete(filename); } catch {}
    try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch {}
}

module.exports = { save, getBuffer, remove };
