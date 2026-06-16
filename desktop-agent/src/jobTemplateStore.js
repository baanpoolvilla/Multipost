const mongoose  = require('mongoose');
const fs        = require('fs');
const path      = require('path');
const { connect } = require('./jobStore');
const imgStore  = require('./agentImageStore');
const supa      = require('./supabaseStore');

const MIME = {
    '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp',
    '.mp4':'video/mp4', '.mov':'video/quicktime', '.avi':'video/x-msvideo', '.webm':'video/webm', '.mkv':'video/x-matroska',
};

const schema = new mongoose.Schema({
    _id:          String,
    name:         String,
    folder:       { type: String, default: null },
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

// imagePaths: Supabase URLs, absolute fs paths, or stored refs
async function save({ id, name, folder, message, groups, delaySeconds, postAsPage, images: imagePaths }) {
    await connect();

    const filenames = [];
    for (const p of (imagePaths || [])) {
        if (!p) continue;

        // Already a Supabase URL or other http URL → keep as-is
        if (p.startsWith('http')) {
            filenames.push(p);
            continue;
        }

        // Legacy refs — keep as-is
        if (p.startsWith('gridfs::')) {
            filenames.push(p);
            continue;
        }

        // localpath:: → try to re-upload to Supabase
        if (p.startsWith('localpath::')) {
            const localPath = p.slice('localpath::'.length);
            if (fs.existsSync(localPath)) {
                const ext = path.extname(localPath).toLowerCase();
                try {
                    const buf   = fs.readFileSync(localPath);
                    const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                    const url   = await supa.upload(fname, buf, MIME[ext] || 'application/octet-stream');
                    filenames.push(url);
                } catch { filenames.push(p); } // keep localpath:: on failure
            } else {
                filenames.push(p); // missing but keep ref
            }
            continue;
        }

        // Absolute local path → upload to Supabase (images and videos)
        const ext = path.extname(p).toLowerCase();
        if (path.isAbsolute(p) && fs.existsSync(p)) {
            try {
                const buf   = fs.readFileSync(p);
                const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                const url   = await supa.upload(fname, buf, MIME[ext] || 'application/octet-stream');
                filenames.push(url);
            } catch (e) {
                console.warn('[tpl] Supabase upload failed:', e.message);
                // fallback: MongoDB for images, localpath:: for videos
                const VIDEO_EXTS = new Set(['.mp4','.mov','.avi','.webm','.mkv']);
                if (VIDEO_EXTS.has(ext)) {
                    filenames.push(`localpath::${p}`);
                } else {
                    try {
                        const buf   = fs.readFileSync(p);
                        const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                        await imgStore.save(fname, buf, MIME[ext] || 'image/jpeg');
                        filenames.push(fname);
                    } catch {}
                }
            }
        } else {
            filenames.push(p); // already a stored filename (MongoDB image)
        }
    }

    const tplId = id || Date.now().toString();
    await Tpl.findByIdAndUpdate(
        tplId,
        { $set: { _id: tplId, name, folder: folder || null, message, groups, delaySeconds, postAsPage: postAsPage || null, images: filenames, createdAt: new Date().toISOString() } },
        { upsert: true }
    );
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

// Returns template with images as data URLs / Supabase URLs for the renderer
async function getWithImages(id) {
    try {
        await connect();
        const tpl = await Tpl.findById(id).lean();
        if (!tpl) return null;
        const imageDataUrls = [];
        for (const entry of (tpl.images || [])) {
            if (entry.startsWith('http')) {
                // Supabase URL — use directly
                const filename = decodeURIComponent(entry.split('/').pop());
                imageDataUrls.push({
                    filename,
                    supabaseUrl: entry,
                    dataUrl:     entry,
                    missing:     false,
                });
            } else if (entry.startsWith('localpath::')) {
                const localPath  = entry.slice('localpath::'.length);
                const filename   = path.basename(localPath);
                const fileExists = fs.existsSync(localPath);
                imageDataUrls.push({
                    filename,
                    dataUrl:   fileExists ? `file://${localPath.replace(/\\/g, '/')}` : null,
                    localPath: fileExists ? localPath : null,
                    missing:   !fileExists,
                });
            } else if (entry.startsWith('gridfs::')) {
                imageDataUrls.push({ filename: entry.slice('gridfs::'.length), dataUrl: null, missing: true });
            } else {
                // Legacy MongoDB image
                const dataUrl = await imgStore.getDataUrl(entry);
                imageDataUrls.push({ filename: entry, dataUrl, missing: !dataUrl });
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
            if (entry.startsWith('http')) {
                await supa.remove(entry).catch(() => {});
            } else if (!entry.startsWith('localpath::') && !entry.startsWith('gridfs::')) {
                await imgStore.remove(entry);
            }
        }
    }
    await Tpl.findByIdAndDelete(id);
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

// Returns true if any stored image entry is local-only (no cloud backup)
function hasLocalVideo(tpl) {
    return (tpl.images || []).some(p => p.startsWith('localpath::'));
}

module.exports = { list, save, getWithImages, remove, hasLocalVideo };
