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
    claimedBy:      { type: String, default: null },
    postAsPage:     { type: String, default: null }, // post as this Facebook Page (name), null = personal profile
    dueAt:          { type: Date, default: null },
    // { started, finished } — SmartBoss notices already sent to the owner (services/jobNotice.js)
    sbNotified:     { type: mongoose.Schema.Types.Mixed, default: undefined },
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
        return GroupJob.find().sort({ _id: -1 }).limit(100).lean();
    } catch(e) { return []; }
}

// Rows of the queue page: it shows how many groups and how many succeeded,
// never the per-group rows themselves — those are most of a job's size.
async function listForQueue() {
    try {
        await connect();
        return await GroupJob.aggregate([
            { $sort: { _id: -1 } },
            { $limit: 100 },
            { $project: {
                message: 1, status: 1, staffId: 1, postAsPage: 1, images: 1, delaySeconds: 1, createdAt: 1, scheduledAt: 1,
                groupCount: { $size: { $ifNull: ['$groups', []] } },
                okCount: { $size: { $filter: { input: { $ifNull: ['$results', []] }, cond: { $eq: ['$$this.status', 'success'] } } } },
            } },
        ]);
    } catch(e) { return []; }
}

// What the live status banner needs, polled every few seconds by every open
// tab: jobs still waiting or posting, plus the ones that changed in the last
// few days (so "finished while you were away" can still be announced), with
// the per-group results boiled down to counts and the failed ones' errors.
// It used to be the newest 100 jobs with every per-group result — 800 KB per
// poll, which alone used up the database's weekly transfer allowance.
// Kept for a moment so several tabs polling together share one query; writes
// made here drop it at once, the posting machine's show up within the TTL.
const FEED_RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const FEED_TTL_MS = 3000;
let _feed = null; // { at, jobs }
let _feedInflight = null;

function invalidateFeed() { _feed = null; }

async function statusFeed() {
    if (_feed && Date.now() - _feed.at < FEED_TTL_MS) return _feed.jobs;
    if (_feedInflight) return _feedInflight;
    _feedInflight = (async () => {
        try {
            await connect();
            const since = new Date(Date.now() - FEED_RECENT_MS);
            const sinceIso = since.toISOString();
            const results = { $ifNull: ['$results', []] };
            const jobs = await GroupJob.aggregate([
                { $match: { $or: [
                    { status: { $in: [STATUS.PENDING, STATUS.RUNNING] } },
                    { updatedAt: { $gte: sinceIso } },
                    { lastAttemptAt: { $gte: sinceIso } },
                    { createdAt: { $gte: since } },
                ] } },
                { $sort: { _id: -1 } },
                { $limit: 100 },
                { $project: {
                    status: 1, message: 1, staffId: 1, postAsPage: 1, scheduledAt: 1, dueAt: 1,
                    updatedAt: 1, lastAttemptAt: 1, createdAt: 1, sbNotified: 1,
                    total: { $size: { $ifNull: ['$groups', []] } },
                    done: { $size: results },
                    lastGroup: { $last: '$results.groupName' },
                    failedResults: { $map: {
                        input: { $filter: { input: results, cond: { $eq: ['$$this.status', 'failed'] } } },
                        in: { error: '$$this.error' },
                    } },
                } },
            ]);
            _feed = { at: Date.now(), jobs };
            return jobs;
        } finally {
            _feedInflight = null;
        }
    })();
    return _feedInflight;
}

async function create(data) {
    await connect();
    try { return await scheduler().CreateJob(data); } finally { invalidateFeed(); }
}

async function remove(id, actor) {
    try {
        await connect();
        return await scheduler().DeleteJob(id, { ...actor, via: 'web' });
    } catch (e) {
        if (e.code === 'JOB_RUNNING') throw e;
        return null;
    } finally { invalidateFeed(); }
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
            .sort({ _id: -1 }).limit(300).lean();
    } catch(e) { return []; }
}

// Every status (pending/running/success/failed/expired/cancelled), no
// completed-only filter — for a specific person's full activity record
// (controllers/staffController.js showUserActivityDetail), where the whole
// point is to show everything they have ever queued, not just what already
// finished. Higher limit than listHistory() since this is meant to be
// exhaustive rather than a recent-activity ticker.
async function listAll() {
    try {
        await connect();
        return GroupJob.find().sort({ _id: -1 }).limit(2000).lean();
    } catch(e) { return []; }
}

// Deleting from history also queues deletion of the real Facebook posts.
async function deleteHistory(id, actor) {
    try {
        await connect();
        return await scheduler().DeleteJob(id, { ...actor, via: 'web' }, { fbDelete: true });
    } catch (e) {
        if (e.code === 'JOB_RUNNING') throw e;
        return null;
    } finally { invalidateFeed(); }
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
    finally { invalidateFeed(); }
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
    try { return await scheduler().RetryJob(id); } finally { invalidateFeed(); }
}

async function cancelJob(id) {
    await connect();
    try { return await scheduler().CancelJob(id); } finally { invalidateFeed(); }
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
    list, listForQueue, statusFeed, create, remove, listHistory, listAll, deleteHistory, getById, statsByDateRange,
    updateOne, listScheduled, updateResultAnalytics, listExpired, expireOverdueJobs,
    migrateLegacyStatuses, retryJob, cancelJob,
};
