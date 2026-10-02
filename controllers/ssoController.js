// Single sign-on from SmartBoss (the company's main system).
//
// SmartBoss signs a 60-second HS256 token (shared secret SSO_SECRET, iss
// "smartboss", aud "multipost") with the SmartBoss user's id/name/email and
// whether they're a CEO/admin there, then sends the browser to
// /sso?token=…. We map that SmartBoss user onto a staff account here:
//   - already linked (staff.smartbossUserId) → log straight in
//   - not linked yet → /sso/link: either sign in once with the old Multi Post
//     username/password to link it (keeps their post history under the same
//     staffId — the Desktop Agent's staff picker and job ownership keep
//     working unchanged), or create a fresh account.
// A SmartBoss CEO/admin always ends up role 'admin' here (sees everyone's
// activity), but SSO never demotes anyone.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');
const auditLogStore = require('../services/auditLogStore');
const { JWT_SECRET } = require('../middleware/auth');
const { issueSession } = require('./authController');

const SSO_SECRET = process.env.SSO_SECRET || null;
const PENDING_COOKIE = 'sso_pending';
const sessionCookie = require('../services/sessionCookie');
const PENDING_MAX_AGE = 15 * 60 * 1000;

function verifySsoToken(token) {
    if (!SSO_SECRET || !token) return null;
    try {
        const p = jwt.verify(token, SSO_SECRET, { algorithms: ['HS256'], issuer: 'smartboss', audience: 'multipost' });
        if (typeof p.sub !== 'string' || !p.sub) return null;
        return { sub: p.sub, name: String(p.name || ''), email: String(p.email || ''), isAdmin: p.isAdmin === true };
    } catch { return null; }
}

// The SmartBoss identity waiting to be linked, carried between /sso and
// /sso/link in a short-lived cookie signed with our own JWT_SECRET.
function readPending(req) {
    const t = req.cookies?.[PENDING_COOKIE];
    if (!t) return null;
    try {
        const p = jwt.verify(t, JWT_SECRET, { algorithms: ['HS256'], audience: 'sso-pending' });
        return { sub: p.sub, name: p.name, email: p.email, isAdmin: p.isAdmin === true, embed: p.embed === true, next: p.next };
    } catch { return null; }
}

async function finish(req, res, staff, sb) {
    if (sb.isAdmin && staff.role !== 'admin') {
        staff = (await staffStore.setRole(staff._id, 'admin')) || staff;
    }
    sessionCookie.clear(res, PENDING_COOKIE);
    issueSession(res, staff, { embed: sb.embed === true });
    res.redirect(sessionCookie.safeNext(sb.next));
}

function renderLink(res, sb, error, status = 200) {
    res.status(status).render('sso-link', { sb, error });
}

exports.start = async (req, res) => {
    if (!SSO_SECRET) return res.redirect('/login');
    const sb = verifySsoToken(req.query.token);
    // Opened inside SmartBoss (iframe) — session cookie must be the embedded kind.
    if (sb) { sb.embed = req.query.embed === '1'; sb.next = sessionCookie.safeNext(req.query.next); }
    if (!sb) {
        return res.status(401).render('login', { isBootstrap: false, error: 'ลิงก์จาก SmartBoss หมดอายุหรือไม่ถูกต้อง — กลับไปกดเปิดจาก SmartBoss อีกครั้ง' });
    }
    let staff;
    try { staff = await staffStore.findBySmartbossId(sb.sub); }
    catch {
        return res.status(503).render('login', { isBootstrap: false, error: 'ระบบขัดข้องชั่วคราว (เชื่อมต่อฐานข้อมูลไม่ได้) กรุณาลองใหม่อีกครั้ง' });
    }
    if (staff) return finish(req, res, staff, sb);

    // แอดมินกรอก "อีเมล SmartBoss" ให้บัญชีนี้ไว้แล้ว — ผูกให้เลย
    try {
        const tagged = await staffStore.findUnlinkedBySmartbossEmail(sb.email);
        if (tagged && await staffStore.linkSmartboss(tagged._id, sb.sub)) {
            await auditLogStore.log({
                action: auditLogStore.ACTIONS.SSO_LINK,
                actorId: String(tagged._id), actorName: tagged.displayName,
                targetId: String(tagged._id), targetName: tagged.displayName,
                details: { smartbossUserId: sb.sub, smartbossName: sb.name, smartbossEmail: sb.email, mode: 'email' },
            });
            return finish(req, res, tagged, sb);
        }
    } catch {}

    const pending = jwt.sign({ sub: sb.sub, name: sb.name, email: sb.email, isAdmin: sb.isAdmin, embed: sb.embed, next: sb.next }, JWT_SECRET, { expiresIn: '15m', audience: 'sso-pending' });
    res.cookie(PENDING_COOKIE, pending, sessionCookie.options(sb.embed, PENDING_MAX_AGE));
    res.redirect('/sso/link');
};

exports.showLink = (req, res) => {
    const sb = readPending(req);
    if (!sb) return res.redirect('/login');
    renderLink(res, sb, null);
};

// Link an existing Multi Post account (proves ownership with its password).
exports.link = async (req, res) => {
    const sb = readPending(req);
    if (!sb) return res.redirect('/login');
    const { username, password } = req.body;
    if (!username?.trim() || !password) return renderLink(res, sb, 'กรุณากรอกชื่อผู้ใช้และรหัสผ่านของบัญชี Multi Post เดิม', 400);

    const staff = await staffStore.verifyPassword(username.trim(), password);
    if (!staff) return renderLink(res, sb, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401);

    let ok = false;
    try { ok = await staffStore.linkSmartboss(staff._id, sb.sub); } catch {}
    if (!ok) return renderLink(res, sb, 'บัญชีนี้ผูกกับผู้ใช้ SmartBoss คนอื่นไปแล้ว — ติดต่อผู้ดูแลระบบ', 409);

    await auditLogStore.log({
        action: auditLogStore.ACTIONS.SSO_LINK,
        actorId: String(staff._id), actorName: staff.displayName,
        targetId: String(staff._id), targetName: staff.displayName,
        details: { smartbossUserId: sb.sub, smartbossName: sb.name, smartbossEmail: sb.email, mode: 'existing' },
    });
    return finish(req, res, staff, sb);
};

// No old account — create one for this SmartBoss user. Login is SSO-only
// from now on, so the password is random (an admin can still set one from
// จัดการบัญชีผู้ใช้งาน if ever needed).
exports.create = async (req, res) => {
    const sb = readPending(req);
    if (!sb) return res.redirect('/login');
    const username = sb.email || `smartboss-${sb.sub}`;
    const result = await staffStore.create({
        username,
        password: crypto.randomBytes(24).toString('hex'),
        displayName: sb.name || username,
        role: sb.isAdmin ? 'admin' : 'staff',
    });
    if (result.error) {
        const msg = result.error === 'มีชื่อผู้ใช้นี้อยู่แล้ว'
            ? `มีบัญชีชื่อผู้ใช้ ${username} อยู่แล้ว — ถ้าเป็นของคุณ ให้เลือก "ผูกบัญชีเดิม" ด้านบน`
            : 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่';
        return renderLink(res, sb, msg, 409);
    }
    let ok = false;
    try { ok = await staffStore.linkSmartboss(result.staff._id, sb.sub); } catch {}
    if (!ok) return renderLink(res, sb, 'ผูกบัญชีไม่สำเร็จ กรุณาลองใหม่', 500);

    await auditLogStore.log({
        action: auditLogStore.ACTIONS.SSO_LINK,
        actorId: String(result.staff._id), actorName: result.staff.displayName,
        targetId: String(result.staff._id), targetName: result.staff.displayName,
        details: { smartbossUserId: sb.sub, smartbossName: sb.name, smartbossEmail: sb.email, mode: 'created' },
    });
    return finish(req, res, result.staff, sb);
};
