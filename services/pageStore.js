const mongoose = require('mongoose');
const { connect } = require('./db');

const pageSchema = new mongoose.Schema({
    pageId:      { type: String, required: true, unique: true },
    pageName:    String,
    accessToken: String,
    tokenExpiry: String,
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

module.exports = { load, add, update, remove, saveAll };
