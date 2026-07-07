// Tracks staff-account management events (create/delete/restore/role
// change/password reset/profile edit) — who did it, to whom, and when.
// Purely additive/best-effort: a logging failure must never block the
// actual action it's describing, so log() swallows its own errors.
const mongoose = require('mongoose');
const { connect } = require('./db');

const ACTIONS = Object.freeze({
    CREATE:         'create',
    SOFT_DELETE:    'soft_delete',
    RESTORE:        'restore',
    ROLE_CHANGE:    'role_change',
    PASSWORD_RESET: 'password_reset',
    PROFILE_EDIT:   'profile_edit',
});

const auditLogSchema = new mongoose.Schema({
    action:     { type: String, required: true },
    actorId:    { type: String, default: null },
    actorName:  { type: String, default: null },
    targetId:   { type: String, default: null },
    targetName: { type: String, default: null },
    details:    { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt:  { type: Date, default: Date.now },
}, { versionKey: false });

const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema, 'auditlogs');

async function log({ action, actorId, actorName, targetId, targetName, details }) {
    try {
        await connect();
        await AuditLog.create({ action, actorId, actorName, targetId, targetName, details: details || null });
    } catch (e) {
        // Best-effort: never let a logging failure roll back or block the
        // real action (account already created/deleted/etc by the time
        // this runs). Just leave a trace server-side for diagnosis.
        console.error('[auditLogStore] failed to write log entry:', e.message);
    }
}

async function list(limit = 300) {
    try { await connect(); return AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean(); }
    catch { return []; }
}

module.exports = { log, list, ACTIONS };
