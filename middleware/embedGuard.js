// Multi Post can be shown inside SmartBoss (an iframe on app.smartboss.in.th).
//
// 1. frame-ancestors: only this site itself and SmartBoss may frame it, so
//    nobody else can overlay it to trick clicks.
// 2. Cross-site write check: the session used inside SmartBoss is a
//    SameSite=None cookie (see services/sessionCookie.js). Browsers send it on
//    cross-site requests, so any request that changes something must come from
//    a Multi Post page itself — the browser's Origin header proves that.
//    Server-to-server callers (Vercel Cron, the posting machine) send no
//    Origin and are authorised by their own secrets.
const SMARTBOSS_ORIGIN = (() => {
    try { return new URL(process.env.SMARTBOSS_URL || 'https://app.smartboss.in.th').origin; }
    catch { return 'https://app.smartboss.in.th'; }
})();

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function embedGuard(req, res, next) {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${SMARTBOSS_ORIGIN}`);

    if (SAFE.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let ok = false;
    try { ok = !!host && new URL(origin).host === host; } catch {}
    if (ok) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'cross-site request blocked' });
    return res.status(403).send('Cross-site request blocked');
};
