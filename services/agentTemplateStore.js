// Group-post templates — the SAME `agenttemplates` collection the Desktop
// Agent's "เทมเพลต" panel reads and writes (desktop-agent/src/jobTemplateStore.js),
// so a template saved on either side shows up on both.
const mongoose = require('mongoose');
const { connect } = require('./db');

const schema = new mongoose.Schema({
    _id:          String,
    name:         String,
    folder:       { type: String, default: null },
    message:      { type: String, default: '' },
    groups:       { type: Array,  default: [] },
    delaySeconds: { type: Number, default: 30 },
    postAsPage:   { type: String, default: null },
    images:       { type: [String], default: [] },
    createdAt:    { type: String, default: () => new Date().toISOString() },
}, { versionKey: false });

const Tpl = mongoose.models.WebAgentTpl || mongoose.model('WebAgentTpl', schema, 'agenttemplates');

const norm = t => ({ ...t, id: String(t._id) });

async function list() {
    await connect();
    return (await Tpl.find().sort({ createdAt: -1 }).lean()).map(norm);
}

async function save({ id, name, folder, message, groups, delaySeconds, postAsPage, images }) {
    await connect();
    const tplId = id || `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    await Tpl.findByIdAndUpdate(tplId, {
        $set: {
            _id: tplId,
            name: String(name || '').trim() || 'เทมเพลต',
            folder: (folder && String(folder).trim()) || null,
            message: String(message || ''),
            groups: (Array.isArray(groups) ? groups : []).map(g => ({ groupId: String(g.groupId), groupName: String(g.groupName || '') })),
            delaySeconds: Math.min(120, Math.max(10, parseInt(delaySeconds, 10) || 30)),
            postAsPage: (postAsPage && String(postAsPage).trim()) || null,
            // Cloud URLs or stored image names; never a path on someone's disk.
            images: (Array.isArray(images) ? images : []).filter(u => typeof u === 'string' && u && !u.includes('::') && !/^[a-zA-Z]:[\\/]/.test(u)),
            createdAt: new Date().toISOString(),
        },
    }, { upsert: true });
    return tplId;
}

// The stored media is left in place: a queued job created from this template
// may still need to download it.
async function remove(id) {
    await connect();
    return Tpl.findByIdAndDelete(id).lean();
}

module.exports = { list, save, remove };
