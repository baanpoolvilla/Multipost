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
// Unless `all` is asked for, only the newest QUEUE_PAGE of the last 100 jobs
// come back, plus any older one still waiting or posting (those must always be
// on the page: the schedule filter, calendar and live status work on them).
const QUEUE_PAGE = 20;
async function listForQueue({ all = false } = {}) {
    try {
        await connect();
        const newest100 = [{ $sort: { _id: -1 } }, { $limit: 100 }];
        const row = { $project: {
            message: 1, status: 1, staffId: 1, postAsPage: 1, images: 1, delaySeconds: 1, createdAt: 1, scheduledAt: 1,
            groupCount: { $size: { $ifNull: ['$groups', []] } },
            okCount: { $size: { $filter: { input: { $ifNull: ['$results', []] }, cond: { $eq: ['$$this.status', 'success'] } } } },
        } };
        if (all) {
            const jobs = await GroupJob.aggregate([...newest100, row]);
            return { jobs, total: jobs.length };
        }
        const [first, olderActive, count] = await Promise.all([
            GroupJob.aggregate([...newest100, { $limit: QUEUE_PAGE }, row]),
            GroupJob.aggregate([...newest100, { $skip: QUEUE_PAGE }, { $match: { status: { $in: [STATUS.PENDING, STATUS.RUNNING] } } }, row]),
            GroupJob.aggregate([...newest100, { $count: 'n' }]),
        ]);
        return { jobs: [...first, ...olderActive], total: count[0]?.n || 0 };
    } catch(e) { return { jobs: [], total: 0 }; }
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

// ── Light reads for the two pages that used listHistory() whole ──────
// A finished job is mostly its per-group rows (group name twice, a 300-char
// Facebook link, timestamps): 2.5 MB for 95 jobs. These ask the database for
// just what each page shows.
const historyBase = () => [
    { $match: { status: { $in: [STATUS.SUCCESS, STATUS.FAILED, 'done'] } } },
    { $sort: { _id: -1 } },
    { $limit: 300 },
];
const orEmpty = field => ({ $ifNull: [field, []] });
const resultOk = { $eq: ['$$this.status', 'success'] };

// ── ประวัติโพสกลุ่ม ──
// The page shows HISTORY_PAGE cards and loads more on request, so it never
// reads every job's per-group rows at once. Four small reads back it:
//   historySummary     totals over every finished job (the stats panel)
//   historyGroupNames  groupId → name, once, instead of on every row
//   historyCards       full cards for one page, or for specific job ids
//   historyIndex       ids + counts + dates of every job, for the filters
const HISTORY_PAGE = 10;

async function historySummary() {
    const empty = { jobs: 0, groups: 0, success: 0, fail: 0, staffIds: [] };
    try {
        await connect();
        const [t] = await GroupJob.aggregate([...historyBase(), { $group: {
            _id: null,
            jobs:    { $sum: 1 },
            groups:  { $sum: { $size: orEmpty('$groups') } },
            success: { $sum: { $size: { $filter: { input: orEmpty('$results'), cond: resultOk } } } },
            fail:    { $sum: { $size: { $filter: { input: orEmpty('$results'), cond: { $eq: ['$$this.status', 'failed'] } } } } },
            staffIds: { $addToSet: { $ifNull: ['$staffId', null] } },
        } }]);
        if (!t) return empty;
        const { _id, ...summary } = t;
        return summary;
    } catch(e) { return empty; }
}

const NAMES_TTL_MS = 60 * 1000;
let _historyNames = null; // { at, map }
async function historyGroupNames({ fresh = false } = {}) {
    if (!fresh && _historyNames && Date.now() - _historyNames.at < NAMES_TTL_MS) return _historyNames.map;
    await connect();
    const names = await GroupJob.aggregate([...historyBase(),
        { $project: { e: { $concatArrays: [orEmpty('$results'), orEmpty('$groups')] } } },
        { $unwind: '$e' },
        { $group: { _id: '$e.groupId', name: { $first: '$e.groupName' } } },
    ]);
    const map = new Map(names.map(n => [n._id, n.name]));
    _historyNames = { at: Date.now(), map };
    return map;
}

async function historyCards({ skip = 0, limit = HISTORY_PAGE, ids = null } = {}) {
    try {
        await connect();
        const pick = ids
            ? [{ $match: { _id: { $in: ids.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(String(id))) } } }]
            : [{ $skip: Math.max(0, skip) }, { $limit: limit }];
        const jobs = await GroupJob.aggregate([...historyBase(), ...pick, { $project: {
            message: 1, status: 1, staffId: 1, scheduledAt: 1, lastAttemptAt: 1, createdAt: 1, images: 1,
            g:  { $map: { input: orEmpty('$groups'),  in: { $ifNull: ['$$this.groupId', null] } } },
            ri: { $map: { input: orEmpty('$results'), in: { $ifNull: ['$$this.groupId', null] } } },
            rs: { $map: { input: orEmpty('$results'), in: { $ifNull: ['$$this.status', null] } } },
            fbPostCount: { $size: { $filter: { input: orEmpty('$results'), cond: { $and: [
                resultOk, { $not: [{ $in: [{ $ifNull: ['$$this.postUrl', null] }, [null, '']] }] },
            ] } } } },
        } }]);
        let nameOf = await historyGroupNames();
        // a job newer than the remembered names may use a group not in them yet
        if (jobs.some(j => [...j.g, ...j.ri].some(id => !nameOf.has(id)))) nameOf = await historyGroupNames({ fresh: true });
        return jobs.map(({ g, ri, rs, ...job }) => ({
            ...job,
            groups:  g.map(id => ({ groupId: id, groupName: nameOf.get(id) })),
            results: ri.map((id, i) => ({ groupId: id, groupName: nameOf.get(id), status: rs[i] })),
        }));
    } catch(e) { return []; }
}

// `search` is matched against the message here (it is the one filter that
// needs the text); every other filter runs in the browser on these rows.
async function historyIndex(search = '') {
    try {
        await connect();
        const text = String(search || '').trim();
        const byText = text ? [{ $match: { message: { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } }] : [];
        const jobs = await GroupJob.aggregate([...historyBase(), ...byText, { $project: {
            status: 1, staffId: 1, scheduledAt: 1, lastAttemptAt: 1, createdAt: 1,
            g:       { $map: { input: orEmpty('$groups'), in: { $ifNull: ['$$this.groupId', null] } } },
            success: { $size: { $filter: { input: orEmpty('$results'), cond: resultOk } } },
            fail:    { $size: { $filter: { input: orEmpty('$results'), cond: { $eq: ['$$this.status', 'failed'] } } } },
        } }]);
        return jobs.map(j => ({
            id: String(j._id), at: j.lastAttemptAt || j.createdAt, status: j.status || 'pending',
            scheduledAt: j.scheduledAt || null, success: j.success, fail: j.fail, g: j.g, staffId: j.staffId || null,
        }));
    } catch(e) { return []; }
}

// ภาพรวม (กลุ่ม): totals per group, the dates for the 7-day chart and the ten
// newest jobs — all counted in the database, and kept for a minute (a summary
// of finished jobs does not need to be to-the-second).
const OVERVIEW_TTL_MS = 60 * 1000;
let _overview = null; // { at, data }
async function overviewData() {
    if (_overview && Date.now() - _overview.at < OVERVIEW_TTL_MS) return _overview.data;
    try {
        await connect();
        // '' counts as missing, like `a || b` did when this was done in JS
        const present = field => ({ $let: { vars: { v: { $ifNull: [field, ''] } }, in: { $cond: [{ $eq: ['$$v', ''] }, null, '$$v'] } } });
        const sumOf = field => ({ $sum: { $ifNull: [field, 0] } });
        const [groupStats, dates, recentJobs] = await Promise.all([
            GroupJob.aggregate([...historyBase(),
                { $project: { results: 1 } },
                { $unwind: '$results' },
                { $group: {
                    _id:     { $ifNull: [present('$results.groupId'), present('$results.groupName'), 'ไม่ทราบ'] },
                    groupId: { $first: present('$results.groupId') },
                    name:    { $first: { $ifNull: [present('$results.groupName'), present('$results.groupId'), 'ไม่ทราบ'] } },
                    success: { $sum: { $cond: [{ $eq: ['$results.status', 'success'] }, 1, 0] } },
                    fail:    { $sum: { $cond: [{ $eq: ['$results.status', 'success'] }, 0, 1] } },
                    likes:    sumOf('$results.analytics.likes'),
                    comments: sumOf('$results.analytics.comments'),
                    shares:   sumOf('$results.analytics.shares'),
                    reach:    sumOf('$results.analytics.reach'),
                } },
            ]),
            GroupJob.aggregate([...historyBase(), { $project: { _id: 0, lastAttemptAt: 1, createdAt: 1 } }]),
            GroupJob.aggregate([...historyBase(), { $limit: 10 }, { $project: {
                message: 1, status: 1, lastAttemptAt: 1, createdAt: 1,
                groupCount:   { $size: orEmpty('$groups') },
                successCount: { $size: { $filter: { input: orEmpty('$results'), cond: resultOk } } },
                failCount:    { $size: { $filter: { input: orEmpty('$results'), cond: { $eq: ['$$this.status', 'failed'] } } } },
            } }]),
        ]);
        _overview = { at: Date.now(), data: { groupStats, dates, recentJobs } };
        return _overview.data;
    } catch(e) { return { groupStats: [], dates: [], recentJobs: [] }; }
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
    } finally { invalidateFeed(); _overview = null; _historyNames = null; }
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
    list, listForQueue, statusFeed, create, remove, listHistory, HISTORY_PAGE, historySummary, historyGroupNames, historyCards, historyIndex, overviewData, listAll, deleteHistory, getById, statsByDateRange,
    updateOne, listScheduled, updateResultAnalytics, listExpired, expireOverdueJobs,
    migrateLegacyStatuses, retryJob, cancelJob,
};
