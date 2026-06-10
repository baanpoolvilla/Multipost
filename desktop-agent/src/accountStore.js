const path = require('path');
const fs   = require('fs');

let _dataPath = null;
let _accounts = [];

function init(userDataDir) {
    _dataPath = path.join(userDataDir, 'accounts.json');
    _load();
}

function _load() {
    try { _accounts = JSON.parse(fs.readFileSync(_dataPath, 'utf-8')); }
    catch { _accounts = []; }
}

function _save() {
    fs.writeFileSync(_dataPath, JSON.stringify(_accounts, null, 2), 'utf-8');
}

function list() {
    return _accounts.map(a => ({ ...a, password: undefined }));
}

function get(id) {
    return _accounts.find(a => a.id === id) || null;
}

function add(email, password) {
    if (_accounts.find(a => a.email === email))
        return { error: 'Email นี้มีอยู่แล้ว' };
    const account = {
        id:        Date.now().toString(),
        email,
        password,
        status:    'logged_out',
        loginedAt: null,
    };
    _accounts.push(account);
    _save();
    return { ok: true, account: { ...account, password: undefined } };
}

function remove(id) {
    const idx = _accounts.findIndex(a => a.id === id);
    if (idx === -1) return { error: 'ไม่พบ account' };
    _accounts.splice(idx, 1);
    _save();
    return { ok: true };
}

function updateStatus(id, status) {
    const acc = _accounts.find(a => a.id === id);
    if (!acc) return;
    acc.status    = status;
    acc.loginedAt = status === 'logged_in' ? new Date().toISOString() : acc.loginedAt;
    _save();
}

function getActive() {
    return _accounts.find(a => a.status === 'logged_in') || null;
}

module.exports = { init, list, get, add, remove, updateStatus, getActive };
