const mongoose = require('mongoose');
const { connect } = require('./db');

const groupSchema = new mongoose.Schema({
    groupId:    { type: String, required: true, unique: true },
    groupName:  { type: String, required: true },
    categories: { type: [String], default: ['ทั่วไป'] },
    addedAt:    { type: Date, default: Date.now },
}, { versionKey: false });

const Group = mongoose.models.FbGroup
    || mongoose.model('FbGroup', groupSchema, 'fbgroups');

// Normalize old docs that have `category: String` instead of `categories: [String]`
function _norm(g) {
    if (!g.categories || g.categories.length === 0) {
        const c = g.category || 'ทั่วไป';
        g.categories = (c === 'ทั่วไป') ? ['ทั่วไป'] : ['ทั่วไป', c];
    }
    return g;
}

async function list() {
    try {
        await connect();
        const groups = await Group.find().sort({ groupName: 1 }).lean();
        return groups.map(_norm);
    } catch { return []; }
}

async function add(groupId, groupName, category = 'ทั่วไป') {
    try {
        await connect();
        if (await Group.findOne({ groupId })) return { error: 'Group ID ซ้ำ' };
        const cats = category === 'ทั่วไป' ? ['ทั่วไป'] : ['ทั่วไป', category];
        const g = await Group.create({ groupId, groupName, categories: cats });
        return { ok: true, group: _norm(g.toObject()) };
    } catch(e) { return { error: e.message }; }
}

// Add a category to the group's list (non-destructive)
async function addToCategory(id, category) {
    try {
        await connect();
        const g = await Group.findByIdAndUpdate(
            id,
            { $addToSet: { categories: category } },
            { new: true }
        ).lean();
        return g ? _norm(g) : null;
    } catch { return null; }
}

// Remove a category (never removes ทั่วไป)
async function removeFromCategory(id, category) {
    if (category === 'ทั่วไป') return { error: 'ลบออกจากทั่วไปไม่ได้ — ใช้ปุ่มลบกลุ่มแทน' };
    try {
        await connect();
        const g = await Group.findByIdAndUpdate(
            id,
            { $pull: { categories: category } },
            { new: true }
        ).lean();
        return g ? _norm(g) : null;
    } catch { return null; }
}

// Move between non-ทั่วไป categories (add to new, remove from old)
async function moveCategory(id, fromCat, toCat) {
    try {
        await connect();
        const g = await Group.findByIdAndUpdate(
            id,
            { $addToSet: { categories: toCat }, $pull: { categories: fromCat } },
            { new: true }
        ).lean();
        return g ? _norm(g) : null;
    } catch { return null; }
}

// Hard delete from all categories
async function remove(id) {
    try { await connect(); return Group.findByIdAndDelete(id).lean(); }
    catch { return null; }
}

// Rename a category across all groups
async function bulkRenameCategory(oldName, newName) {
    try {
        await connect();
        await Group.updateMany({ categories: oldName }, { $addToSet: { categories: newName } });
        await Group.updateMany({ categories: oldName }, { $pull: { categories: oldName } });
        return { ok: true };
    } catch(e) { return { error: e.message }; }
}

// Remove a category name from all groups (used when deleting a category)
async function bulkRemoveCategory(catName) {
    if (!catName || catName === 'ทั่วไป') return { ok: true };
    try {
        await connect();
        await Group.updateMany({ categories: catName }, { $pull: { categories: catName } });
        return { ok: true };
    } catch(e) { return { error: e.message }; }
}

module.exports = { list, add, addToCategory, removeFromCategory, moveCategory, remove, bulkRenameCategory, bulkRemoveCategory };
