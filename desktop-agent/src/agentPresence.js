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
    lastSeenAt: { type: Date, default: Date.now },
}, { versionKey: false });

function getModel() {
    return mongoose.models.AgentPresence || mongoose.model('AgentPresence', presenceSchema, 'agentpresence');
}

const ONLINE_THRESHOLD_MS = 60 * 1000; // heartbeat runs well under this — see main.js

async function heartbeat(agentId, staffId, staffName) {
    const Model = getModel();
    await Model.findOneAndUpdate(
        { agentId },
        { $set: { staffId: staffId || null, staffName: staffName || null, lastSeenAt: new Date() } },
        { upsert: true },
    );
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

module.exports = { heartbeat, findOnlineAgentForStaff, listOnlineAgentIds, ONLINE_THRESHOLD_MS, REASSIGN_THRESHOLD_MS };
