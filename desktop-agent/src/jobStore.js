const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const { createSchedulerService } = require('./scheduler/schedulerService');
const { STATUS } = require('./scheduler/statuses');
const postingLock   = require('./postingLock');
const agentPresence = require('./agentPresence');

let _conn = null;
let _dbOk = false;
let _dataPath = null;
let Job, Page, WebPost, FbGroup, Staff;
let _scheduler = null;
let _agentId   = null;
let _staffId   = null;

function setAgentId(id) {
    _agentId   = id;
    _scheduler = null; // recreate with correct agentId on next use
}

// Which staff member is using this Desktop Agent install — set once via the
// "who are you" picker in the renderer (see main.js staff:set-current), then
// stamped on every job this instance creates so /user-activity can attribute
// agent-created shares the same way it does web-created ones.
function setStaffId(id) {
    _staffId = id || null;
}

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
    claimedBy:      { type: String, default: null }, // agentId of the machine actually running it (set on claim)
    dueAt:          { type: Date, default: null },   // queue order — see scheduler CreateJob
    staffId:        { type: String, default: null },
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

// Read-only here — the Web side (services/staffStore.js) owns creating/deleting
// staff accounts. The Agent only needs the list of names for the "who are you"
// picker, plus writing staffId onto jobs it creates.
const staffSchema = new mongoose.Schema({
    username:    String, displayName: String, color: String, createdAt: Date,
    deletedAt:   Date,
}, { versionKey: false, collection: 'staffmembers' });

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
    Staff   = mongoose.models.AgentStaff  || mongoose.model('AgentStaff',  staffSchema,   'staffmembers');
    _dbOk = true;
}

function scheduler() {
    if (!_scheduler) _scheduler = createSchedulerService(Job, { sourceType: 'agent', agentId: _agentId, isPoster: isPosterAgent() });
    return _scheduler;
}

// POSTING_AGENT=true in this machine's .env marks it the always-on main
// posting machine (see agentPresence.findOnlinePosterAgentId).
function isPosterAgent() { return process.env.POSTING_AGENT === 'true'; }

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

// ── Staff (for the "who are you" picker) ───────────────────────
async function listStaff() {
    try {
        await connect();
        // Active only -- a soft-deleted account must not be selectable here,
        // and main.js's startup re-check relies on a deleted staffId being
        // absent from this list to clear a stale cached selection.
        const staff = await Staff.find({ deletedAt: null }).sort({ displayName: 1 }).lean();
        return staff.map(s => ({ id: String(s._id), displayName: s.displayName, username: s.username }));
    } catch { return []; }
}

// ── CRUD (delegates to SchedulerService — see scheduler/) ───────
async function createJob(data) {
    const withStaff = { ...data, staffId: data.staffId ?? _staffId };
    try {
        await connect();
        return await scheduler().CreateJob(withStaff);
    } catch (e) {
        if (e.validationErrors) throw e;
        const jobs = fLoad();
        const j = { _id: fId(), ...withStaff, status: STATUS.PENDING, results: [], createdAt: new Date().toISOString() };
        jobs.push(j); fSave(jobs); return j;
    }
}

async function getJobs() {
    try {
        await connect();
        return (await Job.find().sort({ _id:-1 }).limit(100).lean()).map(_s);
    } catch { return fLoad().reverse().slice(0,100); }
}

// Run BEFORE every queue poll: flips any pending job overdue past the
// grace window to 'expired' so it can never be auto-posted late.
// Pass graceMs=0 at startup to expire ALL scheduled-but-overdue jobs.
async function expireOverdueJobs(graceMs, opts) {
    try { await connect(); return await scheduler().expireOverdueJobs(graceMs, opts); }
    catch { return 0; }
}

async function saveProgress(id, results) {
    try { await connect(); await scheduler().SaveProgress(id, results); } catch {}
}

// forAgentId = this machine at startup; omit to sweep machines gone offline.
async function recoverInterrupted(forAgentId) {
    try { await connect(); return await scheduler().RecoverInterrupted(forAgentId); }
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

// Atomic claim: marks one due job as running in a single DB operation so two
// agents running simultaneously can never pick up the same job.
async function claimNextJob() {
    try {
        await connect();
        return await scheduler().claimNextDueJob();
    } catch { return null; }
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

// Who is deleting: the staff member signed in on this Agent install.
async function _actor() {
    let name = null;
    if (_staffId) {
        try { name = (await Staff.findById(_staffId).select('displayName').lean())?.displayName || null; } catch {}
    }
    return { id: _staffId, name, via: 'agent' };
}

// opts.fbDelete: also delete the job's posts on Facebook.
async function deleteJob(id, opts = {}) {
    try { await connect(); await scheduler().DeleteJob(id, await _actor(), opts); }
    catch (e) {
        if (e.code === 'JOB_RUNNING') throw e;
        const jobs=fLoad(); const i=jobs.findIndex(x=>x._id===id); if(i!==-1){ jobs.splice(i,1); fSave(jobs); }
    }
}

// Jobs that are actively posting are skipped, never deleted.
async function deleteAllJobs() {
    try {
        await connect();
        const actor = await _actor();
        const all = await Job.find().lean();
        for (const doc of all) {
            if (await scheduler().IsLiveRunning(doc)) continue;
            await scheduler().RecordDeletion(doc, actor);
            await Job.deleteOne({ _id: doc._id });
        }
    }
    catch { fSave([]); }
}

// ── Facebook post deletion requests (queued by scheduler.DeleteJob) ──
const STALE_FB_DELETION_MS = 10 * 60 * 1000; // a 'running' request with no heartbeat this long was abandoned

// Same routing as claimNextDueJob: this machine's own requests, unpinned ones,
// or ones pinned to a machine that is no longer online.
async function claimNextFbDeletion() {
    try {
        await connect();
        const col = Job.db.collection('fbdeletions');
        if (!isPosterAgent()) {
            const poster = await agentPresence.findOnlinePosterAgentId().catch(() => null);
            if (poster && poster !== _agentId) return null;
        }
        const online = await agentPresence.listOnlineAgentIds().catch(() => null);
        const routing = isPosterAgent() ? [{}] : [{ agentId: null }, { agentId: _agentId }];
        if (online && !isPosterAgent()) routing.push({ agentId: { $nin: online } });
        const now = new Date();
        const r = await col.findOneAndUpdate(
            {
                $and: [
                    { $or: [{ status: 'pending' }, { status: 'running', heartbeatAt: { $lte: new Date(now.getTime() - STALE_FB_DELETION_MS) } }] },
                    { $or: routing },
                ],
            },
            { $set: { status: 'running', runningBy: _agentId, startedAt: now, heartbeatAt: now } },
            { sort: { requestedAt: 1 }, returnDocument: 'after' },
        );
        return (r && r.value !== undefined) ? r.value : r;
    } catch { return null; }
}

async function updateFbDeletion(id, patch) {
    try {
        await connect();
        await Job.db.collection('fbdeletions').updateOne({ _id: id }, { $set: { ...patch, heartbeatAt: new Date() } });
    } catch {}
}

// interrupted → back to 'pending' so it resumes later (only targets still
// 'pending' are retried). Otherwise 'done', plus one audit entry with totals.
async function finishFbDeletion(req, targets, interrupted) {
    try {
        await connect();
        const col = Job.db.collection('fbdeletions');
        if (interrupted) {
            await col.updateOne({ _id: req._id }, { $set: { status: 'pending', targets, runningBy: null } });
            return;
        }
        const count = s => targets.filter(t => t.status === s).length;
        const summary = { total: targets.length, deleted: count('deleted') + count('gone'), skipped: count('skipped'), failed: count('failed') };
        await col.updateOne({ _id: req._id }, { $set: { status: 'done', targets, finishedAt: new Date(), summary } });
        await Job.db.collection('auditlogs').insertOne({
            action: 'fb_delete',
            actorId: req.requestedById || null,
            actorName: req.requestedByName || null,
            targetId: String(req.jobId),
            targetName: String(req.message || '').slice(0, 60),
            details: summary,
            createdAt: new Date(),
        });
    } catch {}
}

// See RestoreDeletedJob in scheduler/schedulerService.js.
async function restoreDeletedJob(job, final) {
    await connect();
    return scheduler().RestoreDeletedJob(job, final);
}

async function getCompletedJobs() {
    try {
        await connect();
        return (await Job.find({ status: { $in: [STATUS.SUCCESS, STATUS.FAILED, 'done'] } }).sort({ _id: -1 }).limit(200).lean()).map(_s);
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

// Atlas free tier (M0) allows 512 MB; override with DB_LIMIT_MB if the plan
// changes. Returns null when the size can't be read (never throws).
async function getDbUsage() {
    try {
        await connect();
        const MB = 1048576;
        const s = await mongoose.connection.db.command({ dbStats: 1 });
        const imgs = await mongoose.connection.db.command({ collStats: 'images' }).catch(() => null);
        const usedMB  = (s.storageSize + s.indexSize) / MB;
        const limitMB = parseInt(process.env.DB_LIMIT_MB, 10) || 512;
        return { usedMB, limitMB, percent: (usedMB / limitMB) * 100, imagesMB: imgs ? imgs.storageSize / MB : null };
    } catch { return null; }
}

// Everything the queue panel needs beyond the job rows themselves: who holds
// the global posting lock right now, and id → name lookups so each job can
// show its owner and which machine/person is actually running it.
async function getQueueSnapshot() {
    const empty = { myAgentId: _agentId, lock: null, agentNames: {}, staffNames: {} };
    try {
        await connect();
        const [lock, agentNames, staff] = await Promise.all([
            postingLock.current().catch(() => null),
            agentPresence.staffNameByAgentId().catch(() => ({})),
            Staff.find({}).select('displayName').lean().catch(() => []),
        ]);
        const staffNames = {};
        staff.forEach(s => { staffNames[String(s._id)] = s.displayName; });
        return {
            myAgentId: _agentId,
            lock: lock ? { agentId: lock.agentId, staffName: agentNames[lock.agentId] || null, lockedAt: lock.lockedAt } : null,
            agentNames,
            staffNames,
        };
    } catch { return empty; }
}

function _s(j) { return j ? { ...j, _id: j._id?.toString?.()??j._id } : j; }

module.exports = {
    connect, isDbConnected, setDataPath, setAgentId, setStaffId, listStaff, getAllGroups, getRecentPosts,
    isPosterAgent, createJob, getJobs, getPendingJobs, claimNextJob, updateJob, deleteJob, deleteAllJobs, restoreDeletedJob, claimNextFbDeletion, updateFbDeletion, finishFbDeletion,
    getCompletedJobs, getQueueSnapshot, getDbUsage, rescheduleJob, expireOverdueJobs, migrateLegacyStatuses,
    saveProgress, recoverInterrupted,
    retryJob, cancelJob, listExpiredJobs,
};
