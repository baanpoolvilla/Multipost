const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

const UPLOADS_DIR = process.env.VERCEL
    ? '/tmp/uploads'
    : path.join(__dirname, '../public/uploads');

const MIME = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
    mp4:'video/mp4', mov:'video/quicktime', avi:'video/x-msvideo', webm:'video/webm',
};

// Store data as base64 string to avoid BSON Binary encoding issues
const schema = new mongoose.Schema(
    { _id: String, data: String, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.Image || mongoose.model('Image', schema);

async function save(filename, buffer, contentType) {
    try {
        await connect();
        await Image.findByIdAndUpdate(
            filename,
            { $set: { data: buffer.toString('base64'), contentType } },
            { upsert: true }
        );
    } catch (e) {
        console.warn('[imageStore.save] MongoDB failed:', e.message);
    }
    if (!process.env.VERCEL) {
        try {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
            fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
        } catch {}
    }
}

async function getBuffer(filename) {
    try {
        await connect();
        const doc = await Image.findById(filename).lean();
        if (doc?.data) {
            const ext = path.extname(filename).slice(1).toLowerCase();
            return { buffer: Buffer.from(doc.data, 'base64'), contentType: doc.contentType || MIME[ext] || 'image/jpeg' };
        }
    } catch {}
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(filename).slice(1).toLowerCase();
        return { buffer, contentType: MIME[ext] || 'image/jpeg' };
    }
    return null;
}

async function exists(filename) {
    try {
        await connect();
        const count = await Image.countDocuments({ _id: filename });
        if (count > 0) return true;
    } catch {}
    return fs.existsSync(path.join(UPLOADS_DIR, filename));
}

async function remove(filename) {
    try { await connect(); await Image.findByIdAndDelete(filename); } catch {}
    try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch {}
}

module.exports = { save, getBuffer, exists, remove };
