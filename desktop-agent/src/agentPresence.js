// Lets the web dashboard know which Desktop Agent machine (if any) belongs
// to a given staff member right now, so a group-share job created on the
// web can be pinned to that person's own machine instead of being left for
// any running agent to grab (see routes/postRoutes.js createJob).
//
// Required by BOTH sides (web via services/groupJobStore.js's sibling
// import path, and the Agent itself) — one schema, not two, so it can't
// drift the way services/staffStore.js's Agent-side copy already did once.
const mongoose = require('mongoose');

const presenceSchema = new mongoose.Schema({
    agentId:    { type: String, required: true, unique: true },
    staffId:    { type: String, default: null },
    staffName:  { type: String, default: null },
    isPoster:   { type: Boolean, default: false },
    // Posting-machine health, shown on the web so staff know whether their
    // jobs can go out (see main.js heartbeat / getPosterStatus below).
    fbReady:     { type: Boolean, default: false }, // a Facebook account is signed in
    authWaiting: { type: Boolean, default: false }, // Facebook is asking to approve a login
    running:     { type: Boolean, default: false }, // auto-posting is switched on
    pages:       { type: [String], default: [] },   // Pages this account can post as
    identity:    { type: String, default: null },   // who the account currently acts as (no switch needed)
    pagesUpdatedAt:          { type: Date, default: null },
    pagesRefreshRequestedAt: { type: Date, default: null }, // set from the web, picked up by the posting machine
    lastSeenAt: { type: Date, default: Date.now },
}, { versionKey: false });

function getModel() {
    return mongoose.models.AgentPresence || mongoose.model('AgentPresence', presenceSchema, 'agentpresence');
}

const ONLINE_THRESHOLD_MS = 60 * 1000; // heartbeat runs well under this — see main.js

// health: { fbReady, authWaiting, running } — optional, merged when given.
async function heartbeat(agentId, staffId, staffName, isPoster = false, health = {}) {
    const Model = getModel();
    const set = { staffId: staffId || null, staffName: staffName || null, isPoster: !!isPoster, lastSeenAt: new Date() };
    for (const k of ['fbReady', 'authWaiting', 'running']) if (k in health) set[k] = !!health[k];
    await Model.findOneAndUpdate({ agentId }, { $set: set }, { upsert: true });
}

// pages from facebookBot.getAccountPages: the isPersonal entry is the identity
// the account is acting as right now (posting "as it is" needs no switch).
async function savePages(agentId, pages) {
    const list = (pages || []).filter(p => p && p.name);
    const identity = list.find(p => p.isPersonal)?.name || null;
    const names = [...new Set(list.filter(p => !p.isPersonal).map(p => String(p.name)))];
    await getModel().findOneAndUpdate({ agentId }, { $set: { pages: names, identity, pagesUpdatedAt: new Date() } }, { upsert: true });
}

async function requestPagesRefresh() {
    const r = await getModel().findOneAndUpdate({ isPoster: true }, { $set: { pagesRefreshRequestedAt: new Date() } }, { sort: { lastSeenAt: -1 } });
    return !!r;
}

// true when the web asked for a fresh Page list after the last one was saved.
async function pagesRefreshPending(agentId) {
    const d = await getModel().findOne({ agentId }).select('pagesRefreshRequestedAt pagesUpdatedAt').lean();
    if (!d?.pagesRefreshRequestedAt) return false;
    return !d.pagesUpdatedAt || d.pagesRefreshRequestedAt > d.pagesUpdatedAt;
}

// What the web shows about the main posting machine. null = none configured.
async function getPosterStatus() {
    const doc = await getModel().findOne({ isPoster: true }).sort({ lastSeenAt: -1 }).lean();
    if (!doc) return null;
    const online = Date.now() - new Date(doc.lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
    return {
        online,
        lastSeenAt: doc.lastSeenAt,
        staffName: doc.staffName || null,
        fbReady: !!doc.fbReady,
        authWaiting: online && !!doc.authWaiting,
        running: online && !!doc.running,
        pages: doc.pages || [],
        identity: doc.identity || null,
        pagesUpdatedAt: doc.pagesUpdatedAt || null,
        pagesRefreshPending: !!doc.pagesRefreshRequestedAt && (!doc.pagesUpdatedAt || doc.pagesRefreshRequestedAt > doc.pagesUpdatedAt),
    };
}

// The always-on "main posting machine" (POSTING_AGENT=true in its .env), if
// it is online right now. While it is, it posts every job and other machines
// stand by; if it goes offline they fall back to posting as before.
async function findOnlinePosterAgentId() {
    const cutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
    const doc = await getModel().findOne({ isPoster: true, lastSeenAt: { $gte: cutoff } })
        .sort({ lastSeenAt: -1 }).select('agentId').lean();
    return doc ? doc.agentId : null;
}

// Returns the agentId of whichever machine is currently "signed in" as this
// staff member and has heartbeat-ed recently, or null if none (job falls
// back to the old shared-pool behavior — any agent may claim it).
async function findOnlineAgentForStaff(staffId) {
    if (!staffId) return null;
    const Model = getModel();
    const cutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
    const doc = await Model.findOne({ staffId, lastSeenAt: { $gte: cutoff } }).sort({ lastSeenAt: -1 }).lean();
    return doc ? doc.agentId : null;
}

// Used by claimNextDueJob (schedulerService.js) to decide whether a job
// pinned to a specific agentId should still be treated as pinned, or opened
// back up to the shared pool because that machine hasn't been seen in a
// while (closed, crashed, network drop). A longer window than
// ONLINE_THRESHOLD_MS on purpose — that constant decides routing at job
// *creation* time (tight, since the picked machine should be live right
// now); this one decides whether to give up on a pin that's already been
// waiting, so a brief reconnect blip shouldn't immediately reroute someone
// else's queued job.
const REASSIGN_THRESHOLD_MS = 5 * 60 * 1000;

async function listOnlineAgentIds(thresholdMs = REASSIGN_THRESHOLD_MS) {
    const Model = getModel();
    const cutoff = new Date(Date.now() - thresholdMs);
    const docs = await Model.find({ lastSeenAt: { $gte: cutoff } }).select('agentId').lean();
    return docs.map(d => d.agentId);
}

// agentId → the staff name signed in on that machine (for the queue panel).
async function staffNameByAgentId() {
    const docs = await getModel().find({}).select('agentId staffName').lean();
    const map = {};
    docs.forEach(d => { map[d.agentId] = d.staffName || null; });
    return map;
}

module.exports = { heartbeat, savePages, requestPagesRefresh, pagesRefreshPending, getPosterStatus, findOnlinePosterAgentId, findOnlineAgentForStaff, listOnlineAgentIds, staffNameByAgentId, ONLINE_THRESHOLD_MS, REASSIGN_THRESHOLD_MS };
