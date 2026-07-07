// Global cross-machine lock — every Desktop Agent install shares the same
// underlying Facebook login/session, so even though claimNextDueJob()
// already guarantees no two machines ever work the same JOB, two machines
// could still post to Facebook at the literal same moment on two DIFFERENT
// jobs. Facebook can flag "the same account active from two locations at
// once" as suspicious regardless of which groups are involved — this lock
// makes the whole fleet post one-at-a-time, never in parallel.
const mongoose = require('mongoose');

const LOCK_ID = 'global-fb-posting-lock';
const LOCK_STALE_MS = 5 * 60 * 1000; // auto-release if a machine crashes mid-post without releasing

const lockSchema = new mongoose.Schema({
    _id:      { type: String, default: LOCK_ID },
    heldBy:   { type: String, default: null }, // agentId currently posting, or null when free
    lockedAt: { type: Date, default: null },
}, { versionKey: false });

function getModel() {
    return mongoose.models.PostingLock || mongoose.model('PostingLock', lockSchema, 'postinglock');
}

// Atomic — MongoDB serializes concurrent findOneAndUpdate calls on the same
// document, so even two machines calling this in the same instant can never
// both succeed. Only one wins; the other gets a result that doesn't match
// its own agentId and must retry.
async function acquire(agentId) {
    const Model = getModel();
    // Idempotent: make sure the singleton document exists before the real
    // conditional update below (upsert + $or together can't reliably set
    // fields on first insert, so this is a separate, simpler step).
    await Model.findOneAndUpdate({ _id: LOCK_ID }, { $setOnInsert: { heldBy: null, lockedAt: null } }, { upsert: true });

    const now = new Date();
    const staleBefore = new Date(now.getTime() - LOCK_STALE_MS);
    const result = await Model.findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ heldBy: null }, { lockedAt: { $lte: staleBefore } }] },
        { $set: { heldBy: agentId, lockedAt: now } },
        { new: true },
    ).lean();
    return result?.heldBy === agentId;
}

// Only clears the lock if WE are still the holder — otherwise a machine
// whose lock went stale (and was taken over by someone else) could release
// the NEW holder's lock out from under them.
async function release(agentId) {
    const Model = getModel();
    await Model.findOneAndUpdate({ _id: LOCK_ID, heldBy: agentId }, { $set: { heldBy: null, lockedAt: null } });
}

// Must be called periodically by whoever holds the lock while still actively
// posting (see jobRunner.js's per-group loop) — otherwise a job that takes
// longer than LOCK_STALE_MS to finish (many groups, long delaySeconds) would
// have `lockedAt` go stale while still legitimately in use, letting another
// machine's acquire() treat it as abandoned and take over mid-post. Only
// refreshes the timestamp if WE are still the holder, same guard as release.
async function renew(agentId) {
    const Model = getModel();
    await Model.findOneAndUpdate({ _id: LOCK_ID, heldBy: agentId }, { $set: { lockedAt: new Date() } });
}

module.exports = { acquire, release, renew, LOCK_STALE_MS };
