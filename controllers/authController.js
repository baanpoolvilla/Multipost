const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');
const { JWT_SECRET } = require('../middleware/auth');

const sessionCookie = require('../services/sessionCookie');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// A DB error must never be treated as "collection is empty" — that would
// silently reopen anonymous bootstrap registration on the public /login
// page during a transient outage. Returns null (caller should show a DB
// error) instead of falling back to isBootstrap: true.
async function getIsBootstrap() {
    try { return (await staffStore.count()) === 0; }
    catch { return null; }
}

// Shared by password login and SmartBoss SSO (controllers/ssoController.js).
// embed: signed in from inside SmartBoss (see services/sessionCookie.js).
function issueSession(res, staff, { embed = false } = {}) {
    const token = jwt.sign({ id: String(staff._id), name: staff.displayName, role: staff.role || 'staff' }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, sessionCookie.options(embed, SESSION_MAX_AGE));
}
exports.issueSession = issueSession;

exports.showLogin = async (req, res) => {
    const isBootstrap = await getIsBootstrap();
    if (isBootstrap === null) {
        return res.render('login', { isBootstrap: false, error: 'ระบบขัดข้องชั่วคราว (เชื่อมต่อฐานข้อมูลไม่ได้) กรุณาลองใหม่อีกครั้ง' });
    }
    res.render('login', { isBootstrap, error: null });
};

exports.login = async (req, res) => {
    const { username, password, displayName } = req.body;
    const isBootstrap = await getIsBootstrap();
    if (isBootstrap === null) {
        return res.render('login', { isBootstrap: false, error: 'ระบบขัดข้องชั่วคราว (เชื่อมต่อฐานข้อมูลไม่ได้) กรุณาลองใหม่อีกครั้ง' });
    }

    if (!username?.trim() || !password) {
        return res.render('login', { isBootstrap, error: 'กรุณากรอกข้อมูลให้ครบ' });
    }

    let staff;
    if (isBootstrap) {
        if (!displayName?.trim()) {
            return res.render('login', { isBootstrap, error: 'กรุณากรอกชื่อที่แสดง' });
        }
        const result = await staffStore.create({ username: username.trim(), password, displayName: displayName.trim(), role: 'admin' });
        if (result.error) return res.render('login', { isBootstrap, error: result.error });
        staff = result.staff;
    } else {
        staff = await staffStore.verifyPassword(username.trim(), password);
        if (!staff) return res.render('login', { isBootstrap: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    issueSession(res, staff);
    res.redirect('/');
};

exports.logout = (req, res) => {
    sessionCookie.clear(res, 'token');
    res.redirect('/login');
};
