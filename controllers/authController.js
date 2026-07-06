const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');
const { JWT_SECRET } = require('../middleware/auth');

const COOKIE_OPTIONS = {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
};

// A DB error must never be treated as "collection is empty" — that would
// silently reopen anonymous bootstrap registration on the public /login
// page during a transient outage. Returns null (caller should show a DB
// error) instead of falling back to isBootstrap: true.
async function getIsBootstrap() {
    try { return (await staffStore.count()) === 0; }
    catch { return null; }
}

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

    const token = jwt.sign({ id: String(staff._id), name: staff.displayName, role: staff.role || 'staff' }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, COOKIE_OPTIONS);
    res.redirect('/');
};

exports.logout = (req, res) => {
    res.clearCookie('token');
    res.redirect('/login');
};
