const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect } = require('./db');

/* ── File fallback ── */
const FILE = process.env.VERCEL ? '/tmp/posts.json' : path.join(__dirname, '../data/posts.json');
function fLoad() { try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return []; } }
function fSave(p) { fs.writeFileSync(FILE, JSON.stringify(p, null, 2), 'utf-8'); }

/* ── Mongoose model ── */
const schema = new mongoose.Schema({
    _id: String, createdAt: String, message: String,
    feeling: mongoose.Schema.Types.Mixed, location: String,
    images: [String], results: [mongoose.Schema.Types.Mixed],
    successCount: Number, failCount: Number,
}, { versionKey: false });
const Post = mongoose.models.Post || mongoose.model('Post', schema);

async function load() {
    try {
        await connect();
        const posts = await Post.find().sort({ createdAt: -1 }).lean();
        return posts.map(p => ({ ...p, id: p._id }));
    } catch { return fLoad(); }
}

async function create(data) {
    const id   = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const post = { _id: id, id, createdAt: new Date().toISOString(), ...data };
    try {
        await connect();
        await Post.create(post);
    } catch {
        const posts = fLoad(); posts.unshift(post); fSave(posts);
    }
    return post;
}

async function getById(id) {
    try {
        await connect();
        const p = await Post.findById(id).lean();
        return p ? { ...p, id: p._id } : null;
    } catch { return fLoad().find(p => p.id === id) || null; }
}

async function remove(id) {
    try {
        await connect();
        const p = await Post.findByIdAndDelete(id).lean();
        return p ? { ...p, id: p._id } : null;
    } catch {
        const posts = fLoad();
        const post  = posts.find(p => p.id === id);
        if (!post) return null;
        fSave(posts.filter(p => p.id !== id));
        return post;
    }
}

async function saveAll(posts) {
    try {
        await connect();
        if (!posts.length) return;
        await Post.bulkWrite(posts.map(p => ({
            replaceOne: { filter: { _id: p.id || p._id }, replacement: { ...p, _id: p.id || p._id }, upsert: true },
        })));
    } catch { fSave(posts); }
}

module.exports = { load, create, getById, remove, saveAll };
