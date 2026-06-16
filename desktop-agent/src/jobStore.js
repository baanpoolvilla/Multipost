const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const { createSchedulerService } = require('./scheduler/schedulerService');
const { STATUS } = require('./scheduler/statuses');

let _conn = null;
let _dbOk = false;
let _dataPath = null;
let Job, Page, WebPost, FbGroup;
let _scheduler = null;

// ── Schemas ───────────────────────────────────────────────────
const resultSchema = new mongoose.Schema({
    groupId: String, groupName: String,
    status:  { type: String, enum: ['pending','success','failed'], default: 'pending' },
    error: String, timestamp: String,
    postUrl:   { type: String, default: null },
    analytics: {
        likes:    { type: Number, default: 0 },
        comments: { type: Number, default: 0 },
        shares:   { type: Number, default: 0 },
        reach:    { type: Number, default: 0 },
    },
}, { _id: false });

// Status lifecycle is shared with Web — see scheduler/statuses.js. Both
// sides write to the SAME `groupjobs` collection, so this enum must stay
// identical to the one in services/groupJobStore.js.
const jobSchema = new mongoose.Schema({
    type:         { type: String, default: 'group-post' },
    status:       { type: String, enum: Object.values(STATUS), default: STATUS.PENDING },
    message:      { type: String, required: true },
    groups:       [{ groupId: String, groupName: String, pageId: String, pageName: String }],
    delaySeconds: { type: Number, default: 5 },
    accountId:    String,
    postAsPage:   { type: String, default: null },
    pageId:       { type: String, default: null },
    pageName:     { type: String, default: null },
    scheduledAt:  { type: String, default: null },
    expiredAt:      { type: String, default: null },
    lastAttemptAt:  { type: String, default: null },
    sourceType:     { type: String, default: 'agent' }, // 'web' | 'agent'
    agentId:        { type: String, default: null },
    images:       { type: [String], default: [] },
    results:      [resultSchema],
    createdAt:    { type: String, default: () => new Date().toISOString() },
    updatedAt:    String,
}, { versionKey: false });

const pageSchema = new mongoose.Schema({
    pageId: String, pageName: String,
    groups: [{ groupId: String, groupName: String, enabled: Boolean }],
}, { versionKey: false, collection: 'pages' });

const fbGroupSchema = new mongoose.Schema({
    groupId:    String,
    groupName:  String,
    category:   String,      // old schema field (backward compat)
    categories: [String],    // new schema field (array of categories)
    addedAt:    Date,
}, { versionKey: false, collection: 'fbgroups' });

const postSchema = new mongoose.Schema({
    message: String, successCount: Number, results: Array, createdAt: String,
}, { versionKey: false, collection: 'posts' });

// ── Connect ───────────────────────────────────────────────────
async function connect() {
    if (_conn) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    _conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 6000 });
    Job     = mongoose.models.GroupJob    || mongoose.model('GroupJob',    jobSchema,     'groupjobs');
    Page    = mongoose.models.AgentPage2  || mongoose.model('AgentPage2',  pageSchema,    'pages');
    WebPost = mongoose.models.AgentPost2  || mongoose.model('AgentPost2',  postSchema,    'posts');
    FbGroup = mongoose.models.AgentFbGrp  || mongoose.model('AgentFbGrp',  fbGroupSchema, 'fbgroups');
    _dbOk = true;
}

function scheduler() {
    if (!_scheduler) _scheduler = createSchedulerService(Job, { sourceType: 'agent' });
    return _scheduler;
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
        await FbGroup.updateMany({ categories: { $ne: 'ทั่วไป' } }, { $addToSet: { categories: 'ทั่วไป' } });
        const groups = await FbGroup.find().sort({ groupName: 1 }).lean();
        return groups.map(g => {
            let cats = (g.categories && g.categories.length) ? g.categories : null;
            if (!cats) {
                const c = g.category || 'ทั่วไป';
                cats = (c === 'ทั่วไป') ? ['ทั่วไป'] : ['ทั่วไป', c];
            } else if (!cats.includes('ทั่วไป')) {
                cats = ['ทั่วไป', ...cats];
            }
            return { _id: String(g._id), groupId: g.groupId, groupName: g.groupName, categories: cats };
        });
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

// ── CRUD (delegates to SchedulerService — see scheduler/) ───────
async function createJob(data) {
    try {
        await connect();
        return await scheduler().CreateJob(data);
    } catch (e) {
        if (e.validationErrors) throw e;
        const jobs = fLoad();
        const j = { _id: fId(), ...data, status: STATUS.PENDING, results: [], createdAt: new Date().toISOString() };
        jobs.push(j); fSave(jobs); return j;
    }
}

async function getJobs() {
    try {
        await connect();
        return (await Job.find().sort({ createdAt:-1 }).limit(100).lean()).map(_s);
    } catch { return fLoad().reverse().slice(0,100); }
}

// Run BEFORE every queue poll: flips any pending job overdue past the
// grace window to 'expired' so it can never be auto-posted late.
async function expireOverdueJobs() {
    try { await connect(); return await scheduler().expireOverdueJobs(); }
    catch { return 0; }
}

async function migrateLegacyStatuses() {
    try { await connect(); return await scheduler().migrateLegacyStatuses(); }
    catch { return 0; }
}

async function getPendingJobs() {
    try {
        await connect();
        return await scheduler().getDueJobs();
    } catch {
        const now = Date.now();
        return fLoad()
            .filter(j => j.status===STATUS.PENDING && (!j.scheduledAt || new Date(j.scheduledAt).getTime() <= now))
            .sort(_byDueTime);
    }
}

// Effective "due time" of a job: its scheduledAt if set, otherwise it was due as soon as created.
function _dueTime(j) { return new Date(j.scheduledAt || j.createdAt).getTime(); }
function _byDueTime(a, b) { return _dueTime(a) - _dueTime(b); }

async function updateJob(id, data) {
    try {
        await connect();
        return await scheduler().UpdateJob(id, data);
    } catch {
        const jobs = fLoad(); const j = jobs.find(x=>x._id===id);
        if (j) { Object.assign(j,data); fSave(jobs); } return j;
    }
}

async function deleteJob(id) {
    try { await connect(); await scheduler().DeleteJob(id); }
    catch { const jobs=fLoad(); const i=jobs.findIndex(x=>x._id===id); if(i!==-1){ jobs.splice(i,1); fSave(jobs); } }
}

async function deleteAllJobs() {
    try { await connect(); await Job.deleteMany({}); }
    catch { fSave([]); }
}

async function getCompletedJobs() {
    try {
        await connect();
        return (await Job.find({ status: { $in: [STATUS.SUCCESS, STATUS.FAILED, 'done'] } }).sort({ createdAt: -1 }).limit(200).lean()).map(_s);
    } catch { return []; }
}

async function rescheduleJob(id, scheduledAt) {
    return updateJob(id, { scheduledAt: scheduledAt || null });
}

async function retryJob(id) {
    try { await connect(); return await scheduler().RetryJob(id); }
    catch (e) { throw e; }
}

async function cancelJob(id) {
    try { await connect(); return await scheduler().CancelJob(id); }
    catch (e) { throw e; }
}

async function listExpiredJobs() {
    try { await connect(); return await scheduler().listExpired(); }
    catch { return []; }
}

function _s(j) { return j ? { ...j, _id: j._id?.toString?.()??j._id } : j; }

module.exports = {
    connect, isDbConnected, setDataPath, getAllGroups, getRecentPosts,
    createJob, getJobs, getPendingJobs, updateJob, deleteJob, deleteAllJobs,
    getCompletedJobs, rescheduleJob, expireOverdueJobs, migrateLegacyStatuses,
    retryJob, cancelJob, listExpiredJobs,
};
