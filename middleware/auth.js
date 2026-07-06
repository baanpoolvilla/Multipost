const jwt = require('jsonwebtoken');

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

module.exports = function auth(req, res, next) {
    if (isPublic(req.path)) return next();

    const token = req.cookies?.token;
    if (!token) return res.redirect('/login');

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.staffId   = payload.id;
        req.staffName = payload.name;
        res.locals.currentStaff = { id: payload.id, name: payload.name };
        next();
    } catch {
        res.clearCookie('token');
        return res.redirect('/login');
    }
};

module.exports.JWT_SECRET = JWT_SECRET;
