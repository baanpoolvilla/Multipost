// Session cookie options, in one place.
//
// Normal use: a first-party SameSite=Lax cookie.
// Inside SmartBoss (Multi Post shown in an iframe on app.smartboss.in.th):
// the browser only sends a cookie to a framed site if it is SameSite=None;
// Secure, and Chrome/Edge only keep such third-party cookies when they are
// Partitioned (CHIPS) — stored per top-level site, so this session exists
// only inside SmartBoss and a different site framing or posting to Multi
// Post never gets it. The two are separate cookies in the browser, so
// signing in inside SmartBoss doesn't affect a normal tab and vice versa.
const prod = process.env.NODE_ENV === 'production';

function options(embed, maxAge) {
    if (embed) return { httpOnly: true, maxAge, sameSite: 'none', secure: true, partitioned: true, path: '/' };
    return { httpOnly: true, maxAge, sameSite: 'lax', secure: prod, path: '/' };
}

// Clears both variants — a browser only drops a cookie when the attributes
// that identify it (here: Partitioned) match.
function clear(res, name) {
    res.clearCookie(name, { path: '/' });
    res.clearCookie(name, { path: '/', sameSite: 'none', secure: true, partitioned: true });
}

// Only same-site relative paths, so ?next= can't send anyone elsewhere.
function safeNext(next, fallback = '/') {
    return typeof next === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : fallback;
}

module.exports = { options, clear, safeNext };
