const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');

// Fail loudly instead of silently signing tokens with a secret that's public
// in the source tree — a deployed instance without JWT_SECRET set would
// otherwise let anyone forge a valid login cookie. Checked against
// NODE_ENV as well as VERCEL: server.js has its own IS_VERCEL branches for
// local-disk storage, so this app is also meant to run self-hosted
// (`node server.js` on a VPS/Docker), not only on Vercel — a VERCEL-only
// check would silently miss that path.
if (!process.env.JWT_SECRET && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
    throw new Error('JWT_SECRET is not set — refusing to start with an insecure default secret in production. Set the JWT_SECRET environment variable.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

// Machine-to-machine / static endpoints that must stay reachable without a
// browser login session (Vercel Cron, Desktop Agent auto-update, assets).
const PUBLIC_PATHS = [
    '/login',
    '/logout',
    '/api/cron/run-scheduled',
    '/download/agent',
    '/api/agent-version',
    '/api/agent/source',
];
const PUBLIC_PREFIXES = ['/uploads/', '/css/', '/js/', '/downloads/'];

function isPublic(path) {
    if (PUBLIC_PATHS.includes(path)) return true;
    return PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix));
}

// Page navigations (GET on a non-/api/ path) can be redirected to /login —
// the browser follows a 302 fine there. Everything else (POST/PUT/PATCH/
// DELETE, or any /api/ GET) is called from client-side fetch() expecting
// JSON; a redirect there just hands back an HTML login page that breaks
// res.json() with an opaque parse error, so those get a real 401 instead.
function isApiStyle(req) {
    return req.method !== 'GET' || req.path.startsWith('/api/');
}

function unauthorized(req, res) {
    if (isApiStyle(req)) return res.status(401).json({ error: 'unauthenticated', redirect: '/login' });
    return res.redirect('/login');
}

module.exports = async function auth(req, res, next) {
    if (isPublic(req.path)) return next();

    const token = req.cookies?.token;
    if (!token) return unauthorized(req, res);

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        res.clearCookie('token');
        return unauthorized(req, res);
    }

    // Re-checked against the DB on every request (not just trusted from the
    // JWT payload) for two reasons: (1) deleting a staff account must
    // actually revoke their access instead of leaving their existing 30-day
    // cookie working until it naturally expires, and (2) a role change
    // (promote/demote) must take effect on the very next request, not only
    // after the affected user logs out and back in.
    //
    // findByIdStrict (unlike findById) rethrows on a DB error instead of
    // returning null, specifically so this can tell "confirmed: this
    // account no longer exists" apart from "the DB is temporarily
    // unreachable" — only the former should clear the cookie. Treating both
    // the same would mean a brief Mongo blip logs out every active session
    // on their very next request instead of just degrading gracefully.
    let staff;
    let dbUnavailable = false;
    try {
        staff = await staffStore.findByIdStrict(payload.id);
    } catch {
        dbUnavailable = true;
    }

    if (!dbUnavailable && !staff) {
        res.clearCookie('token');
        return unauthorized(req, res);
    }

    // staff is the live record, or undefined if the DB call failed — in the
    // latter case fall back to the JWT's own (possibly stale) claims for
    // just this request rather than blocking access outright.
    req.staffId   = payload.id;
    req.staffName = staff?.displayName ?? payload.name;
    req.staffRole = staff?.role ?? payload.role ?? 'staff';

    // Bootstrap window: accounts created before roles existed have
    // nobody with role='admin' yet, which would otherwise hide the
    // "จัดการบัญชีผู้ใช้งาน" sidebar link (and block the route itself,
    // see staffController.requireAdmin) from everyone forever — nobody
    // could ever promote the first admin after this deploys.
    let canManageStaff = req.staffRole === 'admin';
    if (!canManageStaff) {
        try { canManageStaff = (await staffStore.countAdmins()) === 0; } catch { canManageStaff = false; }
    }
    req.canManageStaff = canManageStaff;

    res.locals.currentStaff = { id: payload.id, name: req.staffName, role: req.staffRole, canManageStaff };
    next();
};

module.exports.JWT_SECRET = JWT_SECRET;
