const mongoose  = require('mongoose');
const fs        = require('fs');
const path      = require('path');
const { connect } = require('./jobStore');
const imgStore  = require('./agentImageStore');
const gridfs    = require('./gridfsStore');

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

// imagePaths: absolute fs paths (new files), or stored refs (plain filename / gridfs:: / localpath::)
async function save({ id, name, message, groups, delaySeconds, postAsPage, images: imagePaths }) {
    await connect();

    const filenames = [];
    for (const p of (imagePaths || [])) {
        if (!p) continue;

        // Already stored — keep as-is
        if (p.startsWith('gridfs::') || p.startsWith('localpath::')) {
            filenames.push(p);
            continue;
        }

        const ext = path.extname(p).toLowerCase();

        if (path.isAbsolute(p) && fs.existsSync(p)) {
            if (VIDEO_EXTS.has(ext)) {
                // Videos → GridFS (shared across all machines/users)
                try {
                    const buf      = fs.readFileSync(p);
                    const filename = `vid-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                    await gridfs.save(filename, buf, MIME[ext] || 'video/mp4');
                    filenames.push(`gridfs::${filename}`);
                    console.log(`[tpl] video uploaded to GridFS: ${filename} (${(buf.length/1024/1024).toFixed(1)} MB)`);
                } catch (e) {
                    console.warn('[tpl] GridFS video upload failed:', e.message);
                    // Fallback: store local path so video still works on same machine
                    filenames.push(`localpath::${p}`);
                }
            } else {
                // Images → MongoDB document (base64) — works across machines
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
            if (entry.startsWith('gridfs::')) {
                // Download from GridFS to OS temp folder, return file:// URL
                const gfsName  = entry.slice('gridfs::'.length);
                const tmpPath  = await gridfs.downloadToTemp(gfsName);
                const fileUrl  = tmpPath ? `file://${tmpPath.replace(/\\/g, '/')}` : null;
                imageDataUrls.push({ filename: gfsName, dataUrl: fileUrl, localPath: tmpPath });
            } else if (entry.startsWith('localpath::')) {
                // Legacy: absolute local path (falls back gracefully)
                const localPath = entry.slice('localpath::'.length);
                const fileUrl   = require('fs').existsSync(localPath)
                    ? `file://${localPath.replace(/\\/g, '/')}`
                    : null;
                imageDataUrls.push({ filename: require('path').basename(localPath), dataUrl: fileUrl, localPath: fileUrl ? localPath : null });
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
            if (entry.startsWith('gridfs::')) {
                await gridfs.remove(entry.slice('gridfs::'.length));
            } else if (!entry.startsWith('localpath::')) {
                await imgStore.remove(entry);
            }
        }
    }
    await Tpl.findByIdAndDelete(id);
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

module.exports = { list, save, getWithImages, remove };
