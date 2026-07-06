const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const { connect } = require('./db');

const staffSchema = new mongoose.Schema({
    username:     { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    displayName:  { type: String, required: true },
    color:        { type: String, default: '#1877f2' },
    createdAt:    { type: Date, default: Date.now },
}, { versionKey: false });

const Staff = mongoose.models.Staff || mongoose.model('Staff', staffSchema, 'staffmembers');

async function list() {
    try { await connect(); return Staff.find().select('-passwordHash').sort({ displayName: 1 }).lean(); }
    catch { return []; }
}

// Does NOT swallow errors to 0 like the other methods here — callers use
// this specifically to decide "is it safe to open bootstrap/anonymous
// account creation?", and a DB hiccup must never look the same as a
// genuinely empty collection (that would silently reopen public
// registration on /login). Callers must catch and handle failure explicitly.
async function count() {
    await connect();
    return Staff.countDocuments();
}

async function findByUsername(username) {
    try { await connect(); return Staff.findOne({ username }).lean(); }
    catch { return null; }
}

async function findById(id) {
    try { await connect(); return Staff.findById(id).select('-passwordHash').lean(); }
    catch { return null; }
}

async function create({ username, password, displayName }) {
    try {
        await connect();
        const existing = await Staff.findOne({ username });
        if (existing) return { error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
        const passwordHash = await bcrypt.hash(password, 10);
        const staff = await Staff.create({ username, passwordHash, displayName });
        const obj = staff.toObject();
        delete obj.passwordHash;
        return { ok: true, staff: obj };
    } catch (e) { return { error: e.message }; }
}

async function verifyPassword(username, password) {
    const staff = await findByUsername(username);
    if (!staff) return null;
    const ok = await bcrypt.compare(password, staff.passwordHash);
    if (!ok) return null;
    delete staff.passwordHash;
    return staff;
}

async function remove(id) {
    try { await connect(); return Staff.findByIdAndDelete(id).lean(); }
    catch { return null; }
}

module.exports = { list, count, findByUsername, findById, create, verifyPassword, remove };
