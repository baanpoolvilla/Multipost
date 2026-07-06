const mongoose = require('mongoose');
const { connect } = require('./db');
// Scheduler rules live in one place, shared with Desktop Agent — both
// processes write to the same `groupjobs` collection and MUST use the
// identical status enum / expiry logic. See desktop-agent/src/scheduler/.
const { createSchedulerService } = require('../desktop-agent/src/scheduler/schedulerService');
const { STATUS } = require('../desktop-agent/src/scheduler/statuses');

const groupJobSchema = new mongoose.Schema({
    message:      { type: String, required: true },
    groups:       [{
        groupId:   String,
        groupName: String,
        pageId:    String,
        pageName:  String,
    }],
    pageId:       { type: String, default: null },
    pageName:     { type: String, default: null },
    delaySeconds: { type: Number, default: 5 },
    accountId:    { type: String, default: null },
    scheduledAt:  { type: String, default: null },
    status:       { type: String, enum: Object.values(STATUS), default: STATUS.PENDING },
    expiredAt:      { type: String, default: null },
    lastAttemptAt:  { type: String, default: null },
    sourceType:     { type: String, default: 'web' }, // 'web' | 'agent'
    agentId:        { type: String, default: null },
    staffId:        { type: String, default: null },
    images:       { type: [String], default: [] },
    results:      [{
        groupId:   String,
        groupName: String,
        status:    String,
        error:     String,
        timestamp: String,
        postUrl:   { type: String, default: null },
        analytics: {
            likes:    { type: Number, default: 0 },
            comments: { type: Number, default: 0 },
            shares:   { type: Number, default: 0 },
            reach:    { type: Number, default: 0 },
        },
    }],
    createdAt:    { type: Date, default: Date.now },
    updatedAt:    { type: String, default: null },
}, { versionKey: false });

const GroupJob = mongoose.models.GroupJob || mongoose.model('GroupJob', groupJobSchema, 'groupjobs');

let _scheduler = null;
function scheduler() {
    if (!_scheduler) _scheduler = createSchedulerService(GroupJob, { sourceType: 'web' });
    return _scheduler;
}

async function list() {
    try {
        await connect();
        return GroupJob.find().sort({ createdAt: -1 }).limit(100).lean();
    } catch(e) { return []; }
}

async function create(data) {
    await connect();
    return scheduler().CreateJob(data);
}

async function remove(id) {
    try {
        await connect();
        return scheduler().DeleteJob(id);
    } catch { return null; }
}

async function getById(id) {
    try {
        await connect();
        const mongoose = require('mongoose');
        return GroupJob.findById(new mongoose.Types.ObjectId(id)).lean();
    } catch { return null; }
}

async function listHistory() {
    try {
        await connect();
        // 'done' kept defensively in case migrateLegacyStatuses() hasn't
        // touched every row yet — new writes only ever use 'success'.
        return GroupJob.find({ status: { $in: [STATUS.SUCCESS, STATUS.FAILED, 'done'] } })
            .sort({ createdAt: -1 }).limit(300).lean();
    } catch(e) { return []; }
}

async function deleteHistory(id) {
    try {
        await connect();
        return GroupJob.findByIdAndDelete(id).lean();
    } catch { return null; }
}

async function statsByDateRange(fromDate, toDate) {
    try {
        await connect();
        const q = { status: { $in: [STATUS.SUCCESS, STATUS.FAILED, 'done'] } };
        if (fromDate || toDate) {
            q.createdAt = {};
            if (fromDate) q.createdAt.$gte = fromDate;
            if (toDate)   q.createdAt.$lte = toDate;
        }
        const jobs = await GroupJob.find(q).lean();
        return {
            total:   jobs.length,
            success: jobs.reduce((s, j) => s + (j.results || []).filter(r => r.status === 'success').length, 0),
            fail:    jobs.reduce((s, j) => s + (j.results || []).filter(r => r.status === 'failed').length, 0),
        };
    } catch { return { total: 0, success: 0, fail: 0 }; }
}

async function updateOne(id, data) {
    try {
        await connect();
        return await scheduler().UpdateJob(id, data);
    } catch { return null; }
}

async function listScheduled() {
    try {
        await connect();
        return GroupJob.find({ status: STATUS.PENDING, scheduledAt: { $ne: null } }).sort({ scheduledAt: 1 }).lean();
    } catch { return []; }
}

async function listExpired() {
    try { await connect(); return await scheduler().listExpired(); }
    catch { return []; }
}

// Run on Web startup / at the top of schedule-related requests — flips
// any pending job overdue past the grace window to 'expired' so it can
// never be auto-posted late (Part 8/9/11 of the scheduler spec).
async function expireOverdueJobs() {
    try { await connect(); return await scheduler().expireOverdueJobs(); }
    catch { return 0; }
}

async function migrateLegacyStatuses() {
    try { await connect(); return await scheduler().migrateLegacyStatuses(); }
    catch { return 0; }
}

async function retryJob(id) {
    await connect();
    return scheduler().RetryJob(id);
}

async function cancelJob(id) {
    await connect();
    return scheduler().CancelJob(id);
}

// Update analytics for a specific result item inside a job
async function updateResultAnalytics(jobId, resultIndex, analytics) {
    try {
        await connect();
        const updateKey = `results.${resultIndex}.analytics`;
        return GroupJob.findByIdAndUpdate(jobId, { $set: { [updateKey]: analytics } }, { new: true }).lean();
    } catch { return null; }
}

module.exports = {
    list, create, remove, listHistory, deleteHistory, getById, statsByDateRange,
    updateOne, listScheduled, updateResultAnalytics, listExpired, expireOverdueJobs,
    migrateLegacyStatuses, retryJob, cancelJob,
};
