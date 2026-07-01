const mongoose = require('mongoose');
const { connect } = require('./db');

const groupSchema = new mongoose.Schema({
    groupId:    { type: String, required: true, unique: true },
    groupName:  { type: String, required: true },
    categories: { type: [String], default: ['ทั่วไป'] },
    privacy:    { type: String, default: null },   // 'public' | 'private' | null
    addedAt:    { type: Date, default: Date.now },
}, { versionKey: false });

const Group = mongoose.models.FbGroup
    || mongoose.model('FbGroup', groupSchema, 'fbgroups');

// Normalize — always ensures 'ทั่วไป' is first in categories
function _norm(g) {
    if (!g.categories || g.categories.length === 0) {
        const c = g.category || 'ทั่วไป';
        g.categories = (c === 'ทั่วไป') ? ['ทั่วไป'] : ['ทั่วไป', c];
    } else if (!g.categories.includes('ทั่วไป')) {
        g.categories = ['ทั่วไป', ...g.categories];
    }
    return g;
}

async function list() {
    try {
        await connect();
        // Migration: fix any groups that don't have 'ทั่วไป' in their categories array
        await Group.updateMany({ categories: { $ne: 'ทั่วไป' } }, { $addToSet: { categories: 'ทั่วไป' } });
        const groups = await Group.find().sort({ groupName: 1 }).lean();
        return groups.map(_norm);
    } catch { return []; }
}

async function add(groupId, groupName, category = 'ทั่วไป', privacy = null) {
    try {
        await connect();
        if (await Group.findOne({ groupId })) return { error: 'Group ID ซ้ำ' };
        const cats = category === 'ทั่วไป' ? ['ทั่วไป'] : ['ทั่วไป', category];
        const g = await Group.create({ groupId, groupName, categories: cats, privacy: privacy || null });
        return { ok: true, group: _norm(g.toObject()) };
    } catch(e) { return { error: e.message }; }
}

// Add a category to the group's list — always keeps ทั่วไป too
async function addToCategory(id, category) {
    try {
        await connect();
        const g = await Group.findByIdAndUpdate(
            id,
            { $addToSet: { categories: { $each: ['ทั่วไป', category] } } },
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

async function setPrivacy(id, privacy) {
    try {
        await connect();
        const g = await Group.findByIdAndUpdate(id, { privacy: privacy || null }, { new: true }).lean();
        return g ? { ok: true } : { error: 'ไม่พบกลุ่ม' };
    } catch(e) { return { error: e.message }; }
}

module.exports = { list, add, addToCategory, removeFromCategory, moveCategory, remove, bulkRenameCategory, bulkRemoveCategory, setPrivacy };
