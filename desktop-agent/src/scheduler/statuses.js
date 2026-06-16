// ── Canonical job status lifecycle ──────────────────────────────────────
// Single source of truth for Web + Desktop Agent. Both sides require this
// exact file (Web via a relative path into desktop-agent/src/scheduler,
// Agent as part of its own bundled source) so the two processes never
// drift into incompatible status enums again.

const STATUS = Object.freeze({
    PENDING:   'pending',
    RUNNING:   'running',
    SUCCESS:   'success',
    FAILED:    'failed',
    EXPIRED:   'expired',
    CANCELLED: 'cancelled',
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

// Statuses that can never transition on their own (no auto-post / auto-retry).
const TERMINAL_STATUSES = Object.freeze([STATUS.SUCCESS, STATUS.FAILED, STATUS.EXPIRED, STATUS.CANCELLED]);

// Legacy values written by older code — accepted on read, never written anew.
const LEGACY_STATUS_MAP = Object.freeze({ done: STATUS.SUCCESS });

// How long (ms) a pending job may sit past its scheduledAt before it is
// considered expired instead of being executed late. Keeps small clock
// drift / brief processing delays from falsely expiring a due job, while
// jobs missed because Web/Agent was offline still get caught.
const DEFAULT_GRACE_MS = parseInt(process.env.SCHEDULER_GRACE_MS, 10) || 5 * 60 * 1000;

function normalizeStatus(status) {
    if (!status) return STATUS.PENDING;
    return LEGACY_STATUS_MAP[status] || status;
}

function isTerminal(status) {
    return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

// Only these transitions may happen automatically (by the queue runner /
// expiry sweep). Anything else (e.g. expired → success) must go through an
// explicit user action (Reschedule / Post Now / Delete / Retry).
function canAutoTransition(from, to) {
    const f = normalizeStatus(from);
    if (f === STATUS.PENDING && to === STATUS.RUNNING) return true;
    if (f === STATUS.PENDING && to === STATUS.EXPIRED) return true;
    if (f === STATUS.RUNNING && (to === STATUS.SUCCESS || to === STATUS.FAILED)) return true;
    return false;
}

module.exports = {
    STATUS, ALL_STATUSES, TERMINAL_STATUSES, LEGACY_STATUS_MAP, DEFAULT_GRACE_MS,
    normalizeStatus, isTerminal, canAutoTransition,
};
