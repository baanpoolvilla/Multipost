const jwt = require('jsonwebtoken');
const staffStore = require('../services/staffStore');
const { JWT_SECRET } = require('../middleware/auth');

const COOKIE_OPTIONS = {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
};

exports.showLogin = async (req, res) => {
    const isBootstrap = (await staffStore.count()) === 0;
    res.render('login', { isBootstrap, error: null });
};

exports.login = async (req, res) => {
    const { username, password, displayName } = req.body;
    const isBootstrap = (await staffStore.count()) === 0;

    if (!username?.trim() || !password) {
        return res.render('login', { isBootstrap, error: 'กรุณากรอกข้อมูลให้ครบ' });
    }

    let staff;
    if (isBootstrap) {
        if (!displayName?.trim()) {
            return res.render('login', { isBootstrap, error: 'กรุณากรอกชื่อที่แสดง' });
        }
        const result = await staffStore.create({ username: username.trim(), password, displayName: displayName.trim() });
        if (result.error) return res.render('login', { isBootstrap, error: result.error });
        staff = result.staff;
    } else {
        staff = await staffStore.verifyPassword(username.trim(), password);
        if (!staff) return res.render('login', { isBootstrap: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const token = jwt.sign({ id: String(staff._id), name: staff.displayName }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, COOKIE_OPTIONS);
    res.redirect('/');
};

exports.logout = (req, res) => {
    res.clearCookie('token');
    res.redirect('/login');
};
