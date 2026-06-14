const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { connect } = require('./db');

const UPLOADS_DIR = process.env.VERCEL
    ? '/tmp/uploads'
    : path.join(__dirname, '../public/uploads');

const MIME = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
    mp4:'video/mp4', mov:'video/quicktime', avi:'video/x-msvideo', webm:'video/webm',
};

const schema = new mongoose.Schema(
    { _id: String, data: String, contentType: String },
    { versionKey: false }
);
const Image = mongoose.models.Image || mongoose.model('Image', schema);

const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'webm']);
const GFS_BUCKET = 'agentmedia';

function _isVideo(filename) {
    return VIDEO_EXTS.has(path.extname(filename).slice(1).toLowerCase());
}

async function _gfsBucket() {
    await connect();
    return new GridFSBucket(mongoose.connection.db, { bucketName: GFS_BUCKET });
}

// ── Save ──────────────────────────────────────────────────────
async function save(filename, buffer, contentType) {
    const isVideo = _isVideo(filename);

    if (isVideo) {
        // Videos → GridFS (no 16 MB per-document limit, shared with desktop agent)
        try {
            const bucket   = await _gfsBucket();
            const existing = await bucket.find({ filename }).toArray();
            for (const f of existing) { try { await bucket.delete(f._id); } catch {} }
            await new Promise((resolve, reject) => {
                const up = bucket.openUploadStream(filename, { metadata: { contentType } });
                up.on('error', reject);
                up.on('finish', resolve);
                up.end(buffer);
            });
        } catch (e) { console.warn('[imageStore.save] GridFS failed:', e.message); }
    } else {
        // Images → MongoDB document (base64)
        try {
            await connect();
            await Image.findByIdAndUpdate(
                filename,
                { $set: { data: buffer.toString('base64'), contentType } },
                { upsert: true }
            );
        } catch (e) { console.warn('[imageStore.save] MongoDB failed:', e.message); }
    }

    // Also write to disk when not on Vercel
    if (!process.env.VERCEL) {
        try {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
            fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
        } catch {}
    }
}

// ── Get buffer ────────────────────────────────────────────────
async function getBuffer(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';

    if (_isVideo(filename)) {
        // Videos → check GridFS first
        try {
            const bucket = await _gfsBucket();
            const files  = await bucket.find({ filename }).toArray();
            if (files.length) {
                const chunks = [];
                await new Promise((resolve, reject) => {
                    const rs = bucket.openDownloadStreamByName(filename);
                    rs.on('data', c => chunks.push(c));
                    rs.on('end', resolve);
                    rs.on('error', reject);
                });
                const contentType = files[0].metadata?.contentType || ct;
                return { buffer: Buffer.concat(chunks), contentType };
            }
        } catch {}
    } else {
        // Images → check MongoDB document
        try {
            await connect();
            const doc = await Image.findById(filename).lean();
            if (doc?.data) {
                return { buffer: Buffer.from(doc.data, 'base64'), contentType: doc.contentType || ct };
            }
        } catch {}
    }

    // Fallback: local disk (non-Vercel)
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
        return { buffer: fs.readFileSync(filePath), contentType: ct };
    }
    return null;
}

// ── Exists ────────────────────────────────────────────────────
async function exists(filename) {
    if (_isVideo(filename)) {
        try {
            const bucket = await _gfsBucket();
            const files  = await bucket.find({ filename }).toArray();
            if (files.length) return true;
        } catch {}
    } else {
        try {
            await connect();
            const count = await Image.countDocuments({ _id: filename });
            if (count > 0) return true;
        } catch {}
    }
    return fs.existsSync(path.join(UPLOADS_DIR, filename));
}

// ── Remove ────────────────────────────────────────────────────
async function remove(filename) {
    if (_isVideo(filename)) {
        try {
            const bucket = await _gfsBucket();
            const files  = await bucket.find({ filename }).toArray();
            for (const f of files) { try { await bucket.delete(f._id); } catch {} }
        } catch {}
    } else {
        try { await connect(); await Image.findByIdAndDelete(filename); } catch {}
    }
    try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch {}
}

module.exports = { save, getBuffer, exists, remove };
