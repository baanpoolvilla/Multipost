const mongoose = require('mongoose');
const { connect } = require('./db');

const groupSchema = new mongoose.Schema({
    groupId:   { type: String, required: true },
    groupName: String,
    source:    { type: String, default: 'manual' }, // 'facebook' | 'manual'
    enabled:   { type: Boolean, default: true },
}, { _id: false });

const pageSchema = new mongoose.Schema({
    pageId:      { type: String, required: true, unique: true },
    pageName:    String,
    accessToken: String,
    tokenExpiry: String,
    groups:      { type: [groupSchema], default: [] },
}, { versionKey: false });

const Page = mongoose.models.Page || mongoose.model('Page', pageSchema);

async function load() {
    await connect();
    return Page.find().lean();
}

async function add(data) {
    await connect();
    if (await Page.findOne({ pageId: data.pageId })) return { error: 'Page ID ซ้ำ' };
    const page = await Page.create(data);
    return { ok: true, page: page.toObject() };
}

async function update(pageId, data) {
    await connect();
    return Page.findOneAndUpdate({ pageId }, { $set: data }, { new: true }).lean();
}

async function remove(pageId) {
    await connect();
    return Page.findOneAndDelete({ pageId }).lean();
}

async function saveAll(pages) {
    await connect();
    for (const p of pages) {
        await Page.findOneAndUpdate({ pageId: p.pageId }, { $set: p }, { upsert: true });
    }
}

async function syncGroups(pageId, fbGroups) {
    await connect();
    const page = await Page.findOne({ pageId }).lean();
    if (!page) return null;
    const existing = page.groups || [];
    const merged = [...existing];
    for (const g of fbGroups) {
        const idx = merged.findIndex(e => e.groupId === g.groupId);
        if (idx === -1) merged.push({ ...g, source: 'facebook', enabled: true });
        else { merged[idx].groupName = g.groupName; merged[idx].source = 'facebook'; }
    }
    return Page.findOneAndUpdate({ pageId }, { $set: { groups: merged } }, { new: true }).lean();
}

async function addGroup(pageId, groupId, groupName) {
    await connect();
    const page = await Page.findOne({ pageId }).lean();
    if (!page) return null;
    if ((page.groups || []).find(g => g.groupId === groupId)) return { error: 'กลุ่มนี้มีอยู่แล้ว' };
    return Page.findOneAndUpdate(
        { pageId },
        { $push: { groups: { groupId, groupName, source: 'manual', enabled: true } } },
        { new: true }
    ).lean();
}

async function removeGroup(pageId, groupId) {
    await connect();
    return Page.findOneAndUpdate({ pageId }, { $pull: { groups: { groupId } } }, { new: true }).lean();
}

async function toggleGroup(pageId, groupId, enabled) {
    await connect();
    return Page.findOneAndUpdate(
        { pageId, 'groups.groupId': groupId },
        { $set: { 'groups.$.enabled': enabled } },
        { new: true }
    ).lean();
}

module.exports = { load, add, update, remove, saveAll, syncGroups, addGroup, removeGroup, toggleGroup };
