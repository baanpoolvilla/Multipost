// ── SchedulerService ─────────────────────────────────────────────────────
// The single implementation of job lifecycle rules shared by Web and
// Desktop Agent. Each side connects to MongoDB on its own (they are two
// separate processes/deployments) and constructs its own instance of this
// service bound to its own Mongoose Model — but because both require this
// exact file, the *rules* (statuses, expiry, what may auto-run) are always
// identical. Do not re-implement any of this logic locally on either side.
//
// What this module is deliberately NOT responsible for: actually talking
// to Facebook / Playwright / the Graph API. ExecuteJob() takes an
// `executor` callback that performs the real posting — this module only
// owns the before/after status bookkeeping around it.

const { STATUS, DEFAULT_GRACE_MS, normalizeStatus, isTerminal } = require('./statuses');

function serialize(doc) {
    if (!doc) return doc;
    const o = doc.toObject ? doc.toObject() : doc;
    return { ...o, _id: o._id?.toString?.() ?? o._id, status: normalizeStatus(o.status) };
}

/**
 * @param {import('mongoose').Model} Model  Mongoose model for the job collection.
 * @param {object} [opts]
 * @param {string} [opts.sourceType]  'web' | 'agent' — stamped on jobs this instance creates.
 * @param {string} [opts.agentId]    Identifier of the agent instance (desktop agent only).
 */
function createSchedulerService(Model, opts = {}) {
    const sourceType = opts.sourceType || 'web';
    const agentId    = opts.agentId    || null;

    function ValidateJob(data) {
        const errors = [];
        if (!data || !String(data.message || '').trim()) errors.push('กรุณากรอกข้อความ');
        if (!Array.isArray(data.groups) || !data.groups.length) errors.push('กรุณาเลือกกลุ่ม');
        if (data.scheduledAt) {
            const d = new Date(data.scheduledAt);
            if (isNaN(d.getTime())) errors.push('วันเวลาที่ตั้งไม่ถูกต้อง');
        }
        if (errors.length) {
            const err = new Error(errors.join(', '));
            err.validationErrors = errors;
            throw err;
        }
        return true;
    }

    // A scheduledAt in the past is treated as "post immediately", not as an
    // already-expired job — expiry only applies to jobs that became overdue
    // *after* being created and queued.
    function _normalizeScheduledAt(scheduledAt) {
        if (!scheduledAt) return null;
        const d = new Date(scheduledAt);
        if (isNaN(d.getTime())) return null;
        return d > new Date() ? d.toISOString() : null;
    }

    async function CreateJob(data) {
        ValidateJob(data);
        const doc = await Model.create({
            ...data,
            scheduledAt: _normalizeScheduledAt(data.scheduledAt),
            status: STATUS.PENDING,
            results: data.results || [],
            sourceType,
            agentId: data.agentId || agentId || null,
            updatedAt: new Date().toISOString(),
        });
        return serialize(doc);
    }

    async function UpdateJob(id, patch = {}) {
        const current = await Model.findById(id).lean();
        if (!current) return null;

        const status = normalizeStatus(current.status);
        // A running job's content/schedule can't be edited out from under
        // the runner — but the runner itself must still be able to flip
        // status running → success/failed when it finishes, so only block
        // edits that don't carry a status transition.
        if (status === STATUS.RUNNING && !('status' in patch)) {
            throw new Error('ไม่สามารถแก้ไขงานที่กำลังโพสอยู่ได้');
        }
        // Expired jobs only allow: reschedule (clears expiry), cancel, or
        // content edits ahead of a reschedule — never a silent re-queue.
        const next = { ...patch, updatedAt: new Date().toISOString() };
        if (status === STATUS.EXPIRED && 'scheduledAt' in patch) {
            // Reschedule revives an expired job back to pending — whether a
            // new future time was given or it was cleared (which just means
            // "due immediately", same as any other pending job with no
            // scheduledAt).
            next.scheduledAt = _normalizeScheduledAt(patch.scheduledAt);
            next.status      = STATUS.PENDING;
            next.expiredAt   = null;
        } else if ('scheduledAt' in patch) {
            next.scheduledAt = _normalizeScheduledAt(patch.scheduledAt);
        }

        const updated = await Model.findByIdAndUpdate(id, { $set: next }, { new: true }).lean();
        return serialize(updated);
    }

    async function DeleteJob(id) {
        return Model.findByIdAndDelete(id).lean();
    }

    // executor: async (job) => ({ status: 'success'|'failed', results, ...extra })
    async function ExecuteJob(id, executor) {
        const job = await Model.findById(id).lean();
        if (!job) throw new Error('ไม่พบงาน');
        if (normalizeStatus(job.status) !== STATUS.PENDING) {
            // Already picked up / expired / cancelled — never run it twice.
            return serialize(job);
        }

        await Model.findByIdAndUpdate(id, {
            $set: { status: STATUS.RUNNING, lastAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        });

        let outcome;
        try {
            outcome = await executor(serialize(job));
        } catch (e) {
            outcome = { status: STATUS.FAILED, error: e.message };
        }

        const finalStatus = outcome?.status === STATUS.SUCCESS ? STATUS.SUCCESS : STATUS.FAILED;
        const updated = await Model.findByIdAndUpdate(id, {
            $set: { ...outcome, status: finalStatus, updatedAt: new Date().toISOString() },
        }, { new: true }).lean();
        return serialize(updated);
    }

    async function ExpireJob(id) {
        const job = await Model.findById(id).lean();
        if (!job || normalizeStatus(job.status) !== STATUS.PENDING) return job ? serialize(job) : null;
        const updated = await Model.findByIdAndUpdate(id, {
            $set: { status: STATUS.EXPIRED, expiredAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        }, { new: true }).lean();
        return serialize(updated);
    }

    // Manual-only: never called automatically by the queue runner.
    async function RetryJob(id) {
        const job = await Model.findById(id).lean();
        if (!job || normalizeStatus(job.status) !== STATUS.FAILED) {
            throw new Error('ลองใหม่ได้เฉพาะงานที่ล้มเหลวเท่านั้น');
        }
        const updated = await Model.findByIdAndUpdate(id, {
            $set: { status: STATUS.PENDING, scheduledAt: null, expiredAt: null, updatedAt: new Date().toISOString() },
        }, { new: true }).lean();
        return serialize(updated);
    }

    async function CancelJob(id) {
        const job = await Model.findById(id).lean();
        if (!job || isTerminal(job.status)) return job ? serialize(job) : null;
        const updated = await Model.findByIdAndUpdate(id, {
            $set: { status: STATUS.CANCELLED, updatedAt: new Date().toISOString() },
        }, { new: true }).lean();
        return serialize(updated);
    }

    // Run on Web/Agent startup AND periodically — flips any pending job
    // that's been overdue for longer than the grace window to 'expired'.
    // Must run BEFORE the queue is polled so an expired job is never picked
    // up and posted late (Part 8/9/11 of the scheduler spec).
    async function expireOverdueJobs(graceMs = DEFAULT_GRACE_MS) {
        const cutoff = new Date(Date.now() - graceMs).toISOString();
        const now    = new Date().toISOString();
        const res = await Model.updateMany(
            { status: STATUS.PENDING, scheduledAt: { $ne: null, $lte: cutoff } },
            { $set: { status: STATUS.EXPIRED, expiredAt: now, updatedAt: now } },
        );
        return res.modifiedCount || res.nModified || 0;
    }

    // Jobs that are due now and safe to execute (never includes expired ones —
    // expireOverdueJobs should be called first so they've already moved out
    // of 'pending').
    async function getDueJobs() {
        const now = new Date().toISOString();
        const jobs = await Model.find({
            status: STATUS.PENDING,
            $or: [{ scheduledAt: null }, { scheduledAt: { $lte: now } }],
        }).lean();
        return jobs.map(serialize).sort((a, b) =>
            new Date(a.scheduledAt || a.createdAt) - new Date(b.scheduledAt || b.createdAt));
    }

    async function listExpired() {
        const jobs = await Model.find({ status: STATUS.EXPIRED }).sort({ expiredAt: -1 }).lean();
        return jobs.map(serialize);
    }

    // One-time, idempotent: legacy 'done' rows become 'success'. Safe to
    // call on every startup.
    async function migrateLegacyStatuses() {
        const res = await Model.updateMany({ status: 'done' }, { $set: { status: STATUS.SUCCESS } });
        return res.modifiedCount || res.nModified || 0;
    }

    return {
        ValidateJob, CreateJob, UpdateJob, DeleteJob, ExecuteJob, ExpireJob, RetryJob, CancelJob,
        expireOverdueJobs, getDueJobs, listExpired, migrateLegacyStatuses,
    };
}

module.exports = { createSchedulerService };
