const mongoose = require('mongoose');
const { connect } = require('./db');

const groupSchema = new mongoose.Schema({
    groupId:   { type: String, required: true, unique: true },
    groupName: { type: String, required: true },
    addedAt:   { type: Date, default: Date.now },
}, { versionKey: false });

const Group = mongoose.models.FbGroup || mongoose.model('FbGroup', groupSchema, 'fbgroups');

async function list() {
    try { await connect(); return Group.find().sort({ groupName: 1 }).lean(); }
    catch { return []; }
}

async function add(groupId, groupName) {
    try {
        await connect();
        if (await Group.findOne({ groupId })) return { error: 'Group ID ซ้ำ' };
        const g = await Group.create({ groupId, groupName });
        return { ok: true, group: g.toObject() };
    } catch(e) { return { error: e.message }; }
}

async function remove(id) {
    try { await connect(); return Group.findByIdAndDelete(id).lean(); }
    catch { return null; }
}

module.exports = { list, add, remove };
