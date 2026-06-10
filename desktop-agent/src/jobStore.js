const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');

let _conn = null;
let _dbOk = false;
let _dataPath = null;
let Job, Page, WebPost;

// ── Schemas ───────────────────────────────────────────────────
const resultSchema = new mongoose.Schema({
    groupId: String, groupName: String,
    status:  { type: String, enum: ['pending','success','failed'], default: 'pending' },
    error: String, timestamp: String,
}, { _id: false });

const jobSchema = new mongoose.Schema({
    type:         { type: String, default: 'group-post' },
    status:       { type: String, enum: ['pending','running','done','failed'], default: 'pending' },
    message:      { type: String, required: true },
    groups:       [{ groupId: String, groupName: String }],
    delaySeconds: { type: Number, default: 5 },
    accountId:    String,
    results:      [resultSchema],
    createdAt:    { type: String, default: () => new Date().toISOString() },
    updatedAt:    String,
}, { versionKey: false });

const pageSchema = new mongoose.Schema({
    pageId: String, pageName: String,
    groups: [{ groupId: String, groupName: String, enabled: Boolean }],
}, { versionKey: false, collection: 'pages' });

const postSchema = new mongoose.Schema({
    message: String, successCount: Number, results: Array, createdAt: String,
}, { versionKey: false, collection: 'posts' });

// ── Connect ───────────────────────────────────────────────────
async function connect() {
    if (_conn) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    _conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 6000 });
    Job     = mongoose.models.GroupJob   || mongoose.model('GroupJob',   jobSchema,  'groupjobs');
    Page    = mongoose.models.AgentPage2 || mongoose.model('AgentPage2', pageSchema, 'pages');
    WebPost = mongoose.models.AgentPost2 || mongoose.model('AgentPost2', postSchema, 'posts');
    _dbOk = true;
}

function isDbConnected() { return _dbOk && mongoose.connection.readyState === 1; }

// ── File fallback ─────────────────────────────────────────────
function setDataPath(dir) { _dataPath = path.join(dir, 'jobs.json'); }
function fLoad() { try { return JSON.parse(fs.readFileSync(_dataPath,'utf-8')); } catch { return []; } }
function fSave(d) { if (_dataPath) fs.writeFileSync(_dataPath, JSON.stringify(d,null,2)); }
function fId() { return Date.now().toString(); }

// ── Groups ────────────────────────────────────────────────────
async function getAllGroups() {
    try {
        await connect();
        const pages = await Page.find().lean();
        const seen = new Set(); const out = [];
        for (const p of pages)
            for (const g of (p.groups||[]))
                if (g.enabled && !seen.has(g.groupId)) { seen.add(g.groupId); out.push({ groupId: g.groupId, groupName: g.groupName }); }
        return out;
    } catch { return []; }
}

// ── Recent posts (for job creation picker) ────────────────────
async function getRecentPosts() {
    try {
        await connect();
        const posts = await WebPost.find().sort({ createdAt: -1 }).limit(20).lean();
        return posts.map(p => ({
            _id: p._id.toString(), message: p.message||'', successCount: p.successCount||0,
            createdAt: p.createdAt,
            postUrls: (p.results||[]).filter(r=>r.postUrl).map(r=>r.postUrl),
        }));
    } catch { return []; }
}

// ── CRUD ──────────────────────────────────────────────────────
async function createJob(data) {
    try {
        await connect();
        const j = await Job.create({ ...data, status:'pending', results:[] });
        return _s(j.toObject());
    } catch {
        const jobs = fLoad();
        const j = { _id: fId(), ...data, status:'pending', results:[], createdAt: new Date().toISOString() };
        jobs.push(j); fSave(jobs); return j;
    }
}

async function getJobs() {
    try {
        await connect();
        return (await Job.find().sort({ createdAt:-1 }).limit(100).lean()).map(_s);
    } catch { return fLoad().reverse().slice(0,100); }
}

async function getPendingJobs() {
    try {
        await connect();
        return (await Job.find({ status:'pending' }).sort({ createdAt:1 }).lean()).map(_s);
    } catch { return fLoad().filter(j=>j.status==='pending'); }
}

async function updateJob(id, data) {
    try {
        await connect();
        const j = await Job.findByIdAndUpdate(id, { $set:{ ...data, updatedAt: new Date().toISOString() } }, { new:true }).lean();
        return _s(j);
    } catch {
        const jobs = fLoad(); const j = jobs.find(x=>x._id===id);
        if (j) { Object.assign(j,data); fSave(jobs); } return j;
    }
}

async function deleteJob(id) {
    try { await connect(); await Job.findByIdAndDelete(id); }
    catch { const jobs=fLoad(); const i=jobs.findIndex(x=>x._id===id); if(i!==-1){ jobs.splice(i,1); fSave(jobs); } }
}

function _s(j) { return j ? { ...j, _id: j._id?.toString?.()??j._id } : j; }

module.exports = { connect, isDbConnected, setDataPath, getAllGroups, getRecentPosts, createJob, getJobs, getPendingJobs, updateJob, deleteJob };
