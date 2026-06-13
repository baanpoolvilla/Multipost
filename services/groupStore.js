const mongoose = require('mongoose');
const { connect } = require('./db');

const groupSchema = new mongoose.Schema({
    groupId:   { type: String, required: true, unique: true },
    groupName: { type: String, required: true },
    category:  { type: String, default: 'ทั่วไป' },
    addedAt:   { type: Date, default: Date.now },
}, { versionKey: false });

const Group = mongoose.models.FbGroup || mongoose.model('FbGroup', groupSchema, 'fbgroups');

async function list() {
    try { await connect(); return Group.find().sort({ category: 1, groupName: 1 }).lean(); }
    catch { return []; }
}

async function add(groupId, groupName, category = 'ทั่วไป') {
    try {
        await connect();
        if (await Group.findOne({ groupId })) return { error: 'Group ID ซ้ำ' };
        const g = await Group.create({ groupId, groupName, category: category || 'ทั่วไป' });
        return { ok: true, group: g.toObject() };
    } catch(e) { return { error: e.message }; }
}

async function remove(id) {
    try { await connect(); return Group.findByIdAndDelete(id).lean(); }
    catch { return null; }
}

async function updateCategory(id, category) {
    try {
        await connect();
        return Group.findByIdAndUpdate(id, { category: category || 'ทั่วไป' }, { new: true }).lean();
    } catch { return null; }
}

async function bulkRenameCategory(oldName, newName) {
    try {
        await connect();
        await Group.updateMany({ category: oldName }, { category: newName || 'ทั่วไป' });
        return { ok: true };
    } catch(e) { return { error: e.message }; }
}

module.exports = { list, add, remove, updateCategory, bulkRenameCategory };
