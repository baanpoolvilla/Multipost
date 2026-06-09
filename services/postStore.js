const mongoose = require('mongoose');
const { connect } = require('./db');

const postSchema = new mongoose.Schema({
    _id:          String,
    createdAt:    String,
    message:      String,
    feeling:      mongoose.Schema.Types.Mixed,
    location:     String,
    images:       [String],
    results:      [mongoose.Schema.Types.Mixed],
    successCount: Number,
    failCount:    Number,
}, { versionKey: false });

const Post = mongoose.models.Post || mongoose.model('Post', postSchema);

async function load() {
    await connect();
    const posts = await Post.find().sort({ createdAt: -1 }).lean();
    return posts.map(p => ({ ...p, id: p._id }));
}

async function create(data) {
    await connect();
    const id   = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const post = { _id: id, id, createdAt: new Date().toISOString(), ...data };
    await Post.create(post);
    return post;
}

async function getById(id) {
    await connect();
    const p = await Post.findById(id).lean();
    return p ? { ...p, id: p._id } : null;
}

async function remove(id) {
    await connect();
    const p = await Post.findByIdAndDelete(id).lean();
    return p ? { ...p, id: p._id } : null;
}

async function saveAll(posts) {
    await connect();
    if (!posts.length) return;
    const ops = posts.map(p => ({
        replaceOne: {
            filter:      { _id: p.id || p._id },
            replacement: { ...p, _id: p.id || p._id },
            upsert:      true,
        },
    }));
    await Post.bulkWrite(ops);
}

module.exports = { load, create, getById, remove, saveAll };
