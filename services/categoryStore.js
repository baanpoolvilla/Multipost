const mongoose = require('mongoose');
const { connect } = require('./db');

const catSchema = new mongoose.Schema({
    name:      { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

const Category = mongoose.models.GroupCategory
    || mongoose.model('GroupCategory', catSchema, 'groupcategories');

async function list() {
    try { await connect(); return Category.find().sort({ name: 1 }).lean(); }
    catch { return []; }
}

async function add(name) {
    try {
        await connect();
        const existing = await Category.findOne({ name });
        if (existing) return { ok: true, category: existing };
        const c = await Category.create({ name });
        return { ok: true, category: c.toObject() };
    } catch(e) { return { error: e.message }; }
}

async function remove(id) {
    try { await connect(); return Category.findByIdAndDelete(id).lean(); }
    catch { return null; }
}

async function renameByName(oldName, newName) {
    try {
        await connect();
        return Category.findOneAndUpdate({ name: oldName }, { name: newName }, { new: true }).lean();
    } catch { return null; }
}

module.exports = { list, add, remove, renameByName };
