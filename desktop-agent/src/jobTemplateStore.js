const mongoose  = require('mongoose');
const fs        = require('fs');
const path      = require('path');
const { connect } = require('./jobStore');
const imgStore  = require('./agentImageStore');

const MIME = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' };

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

// imagePaths: array of strings — absolute fs paths (new files) or existing filenames
async function save({ id, name, message, groups, delaySeconds, postAsPage, images: imagePaths }) {
    await connect();

    const filenames = [];
    for (const p of (imagePaths || [])) {
        if (!p) continue;
        if (path.isAbsolute(p) && fs.existsSync(p)) {
            // New local file → upload to MongoDB
            try {
                const ext      = path.extname(p).toLowerCase();
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                const buf      = fs.readFileSync(p);
                await imgStore.save(filename, buf, MIME[ext] || 'image/jpeg');
                filenames.push(filename);
            } catch (e) { console.warn('[tpl] img upload failed:', e.message); }
        } else {
            filenames.push(p); // already a stored filename
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

// Returns template with images as base64 data URLs for the renderer
async function getWithImages(id) {
    try {
        await connect();
        const tpl = await Tpl.findById(id).lean();
        if (!tpl) return null;
        const imageDataUrls = [];
        for (const filename of (tpl.images || [])) {
            const dataUrl = await imgStore.getDataUrl(filename);
            imageDataUrls.push({ filename, dataUrl });
        }
        return { ..._normalize(tpl), imageDataUrls };
    } catch { return null; }
}

async function remove(id) {
    await connect();
    const tpl = await Tpl.findById(id).lean();
    if (tpl?.images?.length) {
        for (const filename of tpl.images) {
            await imgStore.remove(filename);
        }
    }
    await Tpl.findByIdAndDelete(id);
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(_normalize);
}

module.exports = { list, save, getWithImages, remove };
