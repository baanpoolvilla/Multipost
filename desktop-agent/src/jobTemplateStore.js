const mongoose  = require('mongoose');
const fs        = require('fs');
const path      = require('path');
const { connect } = require('./jobStore');
const imgStore  = require('./agentImageStore');

const MIME = {
    '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp',
    '.mp4':'video/mp4', '.mov':'video/quicktime', '.avi':'video/x-msvideo', '.webm':'video/webm', '.mkv':'video/x-matroska',
};
const VIDEO_EXTS = new Set(['.mp4','.mov','.avi','.webm','.mkv']);

const schema = new mongoose.Schema({
    _id:          String,
    name:         String,
    message:      { type: String, default: '' },
    groups:       { type: Array,  default: [] },
    delaySeconds: { type: Number, default: 5 },
    postAsPage:   { type: String, default: null },
    images:       { type: [String], default: [] },
    createdAt:    { type: String, default: () => new Date().toISOString() },
}, { versionKey: false });

const Tpl = mongoose.models.AgentTpl || mongoose.model('AgentTpl', schema, 'agenttemplates');

function _normalize(t) { return t ? { ...t, id: t._id?.toString() ?? t._id } : t; }

async function list() {
    try {
        await connect();
        return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
    } catch { return []; }
}

// imagePaths: absolute fs paths (new files), or stored refs (plain filename / localpath::)
async function save({ id, name, message, groups, delaySeconds, postAsPage, images: imagePaths }) {
    await connect();

    const filenames = [];
    for (const p of (imagePaths || [])) {
        if (!p) continue;

        // Already stored ref — keep as-is
        if (p.startsWith('localpath::') || p.startsWith('gridfs::')) {
            filenames.push(p);
            continue;
        }

        const ext = path.extname(p).toLowerCase();

        if (path.isAbsolute(p) && fs.existsSync(p)) {
            if (VIDEO_EXTS.has(ext)) {
                // Videos: store local path only (not uploaded to DB — too large)
                filenames.push(`localpath::${p}`);
            } else {
                // Images: upload to MongoDB so they work across machines
                try {
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                    const buf      = fs.readFileSync(p);
                    await imgStore.save(filename, buf, MIME[ext] || 'image/jpeg');
                    filenames.push(filename);
                } catch (e) { console.warn('[tpl] img upload failed:', e.message); }
            }
        } else {
            filenames.push(p); // already a stored filename (image in agentImageStore)
        }
    }

    const tplId = id || Date.now().toString();
    await Tpl.findByIdAndUpdate(
        tplId,
        { $set: { _id: tplId, name, message, groups, delaySeconds, postAsPage: postAsPage || null, images: filenames, createdAt: new Date().toISOString() } },
        { upsert: true }
    );
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

// Returns template with images as data URLs / file:// URLs for the renderer
async function getWithImages(id) {
    try {
        await connect();
        const tpl = await Tpl.findById(id).lean();
        if (!tpl) return null;
        const imageDataUrls = [];
        for (const entry of (tpl.images || [])) {
            if (entry.startsWith('localpath::')) {
                const localPath = entry.slice('localpath::'.length);
                const filename  = path.basename(localPath);
                const fileExists = fs.existsSync(localPath);
                imageDataUrls.push({
                    filename,
                    dataUrl:   fileExists ? `file://${localPath.replace(/\\/g, '/')}` : null,
                    localPath: fileExists ? localPath : null,
                    missing:   !fileExists,
                });
            } else if (entry.startsWith('gridfs::')) {
                // Legacy gridfs:: entries — treat as missing (GridFS removed)
                imageDataUrls.push({ filename: entry.slice('gridfs::'.length), dataUrl: null, missing: true });
            } else {
                // Regular image stored in agentImageStore (MongoDB document)
                const dataUrl = await imgStore.getDataUrl(entry);
                imageDataUrls.push({ filename: entry, dataUrl });
            }
        }
        return { ..._normalize(tpl), imageDataUrls };
    } catch { return null; }
}

async function remove(id) {
    await connect();
    const tpl = await Tpl.findById(id).lean();
    if (tpl?.images?.length) {
        for (const entry of tpl.images) {
            if (!entry.startsWith('localpath::') && !entry.startsWith('gridfs::')) {
                await imgStore.remove(entry);
            }
        }
    }
    await Tpl.findByIdAndDelete(id);
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

// Returns true if any stored image entry is a local-only video
function hasLocalVideo(tpl) {
    return (tpl.images || []).some(p => p.startsWith('localpath::'));
}

module.exports = { list, save, getWithImages, remove, hasLocalVideo };
