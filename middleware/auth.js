const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');

// Fail loudly instead of silently signing tokens with a secret that's public
// in the source tree — a deployed instance without JWT_SECRET set would
// otherwise let anyone forge a valid login cookie.
if (!process.env.JWT_SECRET && process.env.VERCEL) {
    throw new Error('JWT_SECRET is not set — refusing to start with an insecure default secret in production. Set JWT_SECRET in the Vercel project environment variables.');
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

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.staffId   = payload.id;
        req.staffName = payload.name;
        req.staffRole = payload.role || 'staff';

        // Same bootstrap window as staffController.requireAdmin: accounts
        // created before roles existed have nobody with role='admin' yet,
        // which would otherwise hide the "จัดการบัญชีผู้ใช้งาน" sidebar
        // link from everyone forever (the route itself is reachable via
        // its bootstrap escape hatch, but with no visible link nobody would
        // ever find it to promote the first admin).
        let canManageStaff = req.staffRole === 'admin';
        if (!canManageStaff) {
            try { canManageStaff = (await staffStore.countAdmins()) === 0; } catch { canManageStaff = false; }
        }

        res.locals.currentStaff = { id: payload.id, name: payload.name, role: req.staffRole, canManageStaff };
        next();
    } catch {
        res.clearCookie('token');
        return unauthorized(req, res);
    }
};

module.exports.JWT_SECRET = JWT_SECRET;
