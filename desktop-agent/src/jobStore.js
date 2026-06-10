const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');

let _conn = null;
let Job, Page;

function getDataPath() {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'jobs.json');
}

// ── Mongoose models ──────────────────────────────────────────
const resultSchema = new mongoose.Schema({
    groupId: String, groupName: String,
    status:  { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    error:   String,
    timestamp: String,
}, { _id: false });

const jobSchema = new mongoose.Schema({
    type:         { type: String, default: 'group-post' },
    status:       { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    message:      { type: String, required: true },
    groups:       [{ groupId: String, groupName: String }],
    delaySeconds: { type: Number, default: 5 },
    results:      [resultSchema],
    createdAt:    { type: String, default: () => new Date().toISOString() },
    updatedAt:    String,
}, { versionKey: false });

const pageSchemaLight = new mongoose.Schema({
    pageId: String, pageName: String,
    groups: [{ groupId: String, groupName: String, enabled: Boolean }],
}, { versionKey: false, collection: 'pages' });

async function connectDB() {
    if (_conn) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI ยังไม่ได้ตั้งค่าใน .env');
    _conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 6000 });
    Job  = mongoose.models.GroupJob  || mongoose.model('GroupJob',  jobSchema,       'groupjobs');
    Page = mongoose.models.AgentPage || mongoose.model('AgentPage', pageSchemaLight, 'pages');
}

// ── File fallback ────────────────────────────────────────────
function fLoad() {
    try { return JSON.parse(fs.readFileSync(getDataPath(), 'utf-8')); } catch { return []; }
}
function fSave(d) { fs.writeFileSync(getDataPath(), JSON.stringify(d, null, 2), 'utf-8'); }

// ── Get all enabled groups from web app's DB ─────────────────
async function getAllGroups() {
    try {
        await connectDB();
        const pages = await Page.find().lean();
        const seen  = new Set();
        const out   = [];
        for (const p of pages) {
            for (const g of (p.groups || [])) {
                if (g.enabled && !seen.has(g.groupId)) {
                    seen.add(g.groupId);
                    out.push({ groupId: g.groupId, groupName: g.groupName });
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

async function createJob(data) {
    try {
        await connectDB();
        const job = await Job.create({ ...data, status: 'pending', results: [] });
        return _serialize(job.toObject());
    } catch {
        const jobs = fLoad();
        const job  = {
            _id: Date.now().toString(),
            ...data,
            status: 'pending',
            results: [],
            createdAt: new Date().toISOString(),
        };
        jobs.push(job); fSave(jobs);
        return job;
    }
}

async function getJobs() {
    try {
        await connectDB();
        const jobs = await Job.find().sort({ createdAt: -1 }).limit(100).lean();
        return jobs.map(_serialize);
    } catch {
        return fLoad().reverse().slice(0, 100);
    }
}

async function getPendingJobs() {
    try {
        await connectDB();
        const jobs = await Job.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
        return jobs.map(_serialize);
    } catch {
        return fLoad().filter(j => j.status === 'pending');
    }
}

async function updateJob(jobId, data) {
    try {
        await connectDB();
        const j = await Job.findByIdAndUpdate(
            jobId,
            { $set: { ...data, updatedAt: new Date().toISOString() } },
            { new: true }
        ).lean();
        return _serialize(j);
    } catch {
        const jobs = fLoad();
        const j    = jobs.find(x => x._id === jobId);
        if (j) { Object.assign(j, data); fSave(jobs); }
        return j;
    }
}

async function deleteJob(jobId) {
    try {
        await connectDB();
        await Job.findByIdAndDelete(jobId);
    } catch {
        const jobs = fLoad();
        const idx  = jobs.findIndex(x => x._id === jobId);
        if (idx !== -1) { jobs.splice(idx, 1); fSave(jobs); }
    }
}

async function getRecentPosts() {
    try {
        await connectDB();
        const postSchema = new mongoose.Schema({
            message: String, successCount: Number, results: Array, createdAt: String,
        }, { versionKey: false, collection: 'posts' });
        const Post = mongoose.models.AgentWebPost || mongoose.model('AgentWebPost', postSchema, 'posts');
        const posts = await Post.find().sort({ createdAt: -1 }).limit(20).lean();
        return posts.map(p => ({
            _id:   p._id.toString(),
            message:      p.message || '',
            successCount: p.successCount || 0,
            createdAt:    p.createdAt,
            postUrls: (p.results || []).filter(r => r.postUrl).map(r => r.postUrl),
        }));
    } catch { return []; }
}

function _serialize(j) {
    if (!j) return j;
    return { ...j, _id: j._id?.toString?.() ?? j._id };
}

module.exports = { getAllGroups, createJob, getJobs, getPendingJobs, updateJob, deleteJob, getRecentPosts };
