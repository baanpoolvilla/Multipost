const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const { connect } = require('./db');

const staffSchema = new mongoose.Schema({
    username:     { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    displayName:  { type: String, required: true },
    color:        { type: String, default: '#1877f2' },
    role:         { type: String, enum: ['admin', 'staff'], default: 'staff' },
    createdAt:    { type: Date, default: Date.now },
    // Soft delete: a "removed" account is kept forever with this set instead
    // of being erased from the collection, so its username is unambiguous
    // (restore is possible instead of silently recreating a new row) and —
    // the main reason — its historical posts/jobs keep showing the real
    // displayName in กิจกรรมพนักงาน instead of collapsing to "ไม่ระบุตัวตน"
    // just because the account record is gone.
    deletedAt:    { type: Date, default: null },
}, { versionKey: false });

const Staff = mongoose.models.Staff || mongoose.model('Staff', staffSchema, 'staffmembers');

// The findOne-then-create/-update pattern below is a non-atomic check, so a
// concurrent request with the same username can still slip past it and hit
// the schema's unique index instead — this turns that raw MongoDB E11000
// error back into the same friendly message the pre-check would have given.
// Checks a few different shapes since Mongoose/the driver don't always
// expose .code on the top-level error (bulk-write paths, wrapped errors).
function isDuplicateKeyError(e) {
    if (!e) return false;
    if (e.code === 11000 || e.codeName === 'DuplicateKey') return true;
    if (Array.isArray(e.writeErrors) && e.writeErrors.some(we => we.code === 11000)) return true;
    if (e.cause && (e.cause.code === 11000 || e.cause.codeName === 'DuplicateKey')) return true;
    return String(e.message || '').includes('E11000');
}

// includeDeleted: true is only for callers that need soft-deleted accounts
// to still resolve (e.g. so an old post/job's staffId still shows a real
// name in กิจกรรมพนักงาน instead of falling into "ไม่ระบุตัวตน"). Every
// other caller (the manage-staff list, login, admin-gating) wants active
// accounts only, which is why that's the default.
async function list({ includeDeleted = false } = {}) {
    try {
        await connect();
        const filter = includeDeleted ? {} : { deletedAt: null };
        return Staff.find(filter).select('-passwordHash').sort({ displayName: 1 }).lean();
    } catch { return []; }
}

// Does NOT swallow errors to 0 like the other methods here — callers use
// this specifically to decide "is it safe to open bootstrap/anonymous
// account creation?", and a DB hiccup must never look the same as a
// genuinely empty collection (that would silently reopen public
// registration on /login). Callers must catch and handle failure explicitly.
// Counts active accounts only — a soft-deleted account shouldn't count
// toward "the system must always have at least 1 account".
async function count() {
    await connect();
    return Staff.countDocuments({ deletedAt: null });
}

// Accounts created before the role system existed have no `role` field
// stored at all, so this naturally (and correctly) excludes them until
// someone explicitly promotes an account — see requireAdmin's bootstrap
// escape hatch in controllers/staffController.js. Active accounts only, for
// the same reason as count().
async function countAdmins() {
    await connect();
    return Staff.countDocuments({ role: 'admin', deletedAt: null });
}

// Active only — a soft-deleted account must not be able to log in.
async function findByUsername(username) {
    try { await connect(); return Staff.findOne({ username, deletedAt: null }).lean(); }
    catch { return null; }
}

// Active only — every management action (edit, change role/password,
// admin-gating) should treat a soft-deleted account as "doesn't exist" so
// none of those actions can be performed on it through the normal
// endpoints. Use findByIdIncludingDeleted for display/history lookups.
async function findById(id) {
    try { await connect(); return Staff.findOne({ _id: id, deletedAt: null }).select('-passwordHash').lean(); }
    catch { return null; }
}

// For display/history purposes only (กิจกรรมพนักงาน's per-person page,
// name-resolution maps) — a soft-deleted account should still show its real
// name on its own historical activity, not 404 or fall back to "ไม่ระบุตัวตน".
async function findByIdIncludingDeleted(id) {
    try { await connect(); return Staff.findById(id).select('-passwordHash').lean(); }
    catch { return null; }
}

// Same rethrow-don't-swallow contract as count(): middleware/auth.js needs
// to tell "this account no longer exists" (safe to revoke the session) apart
// from "the DB is temporarily unreachable" (must NOT revoke every active
// session just because of a transient outage) -- findById above collapses
// both cases to null, which is fine for its other callers (they just want
// "found it or didn't, don't crash the page"), but wrong for that one.
// Active only — a soft-deleted account's session gets revoked the same way
// a truly-gone one would (findById's null already triggers that in
// middleware/auth.js, so soft-delete needs no extra code there).
async function findByIdStrict(id) {
    await connect();
    return Staff.findOne({ _id: id, deletedAt: null }).select('-passwordHash').lean();
}

async function create({ username, password, displayName, role }) {
    try {
        await connect();
        const existing = await Staff.findOne({ username });
        if (existing) return { error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
        const passwordHash = await bcrypt.hash(password, 10);
        const staff = await Staff.create({ username, passwordHash, displayName, role: role === 'admin' ? 'admin' : 'staff' });
        const obj = staff.toObject();
        delete obj.passwordHash;
        return { ok: true, staff: obj };
    } catch (e) {
        if (isDuplicateKeyError(e)) return { error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
        return { error: e.message };
    }
}

async function setPassword(id, password) {
    try {
        await connect();
        const passwordHash = await bcrypt.hash(password, 10);
        const staff = await Staff.findByIdAndUpdate(id, { passwordHash }, { new: true }).lean();
        return staff ? { ok: true } : { error: 'ไม่พบผู้ใช้งาน' };
    } catch (e) { return { error: e.message }; }
}

async function setRole(id, role) {
    try {
        await connect();
        return await Staff.findByIdAndUpdate(id, { role: role === 'admin' ? 'admin' : 'staff' }, { new: true }).select('-passwordHash').lean();
    } catch { return null; }
}

async function updateProfile(id, { username, displayName }) {
    try {
        await connect();
        const existing = await Staff.findOne({ username, _id: { $ne: id } });
        if (existing) return { error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
        const staff = await Staff.findByIdAndUpdate(id, { username, displayName }, { new: true }).select('-passwordHash').lean();
        return staff ? { ok: true, staff } : { error: 'ไม่พบผู้ใช้งาน' };
    } catch (e) {
        if (isDuplicateKeyError(e)) return { error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
        return { error: e.message };
    }
}

async function verifyPassword(username, password) {
    const staff = await findByUsername(username);
    if (!staff) return null;
    const ok = await bcrypt.compare(password, staff.passwordHash);
    if (!ok) return null;
    delete staff.passwordHash;
    return staff;
}

// Soft delete: keeps the row (so it can be restored, and its historical
// posts/jobs keep resolving to a real name) but marks it removed so it's
// excluded from list()/findById()/login/admin-counts by default.
async function softDelete(id) {
    try { await connect(); return Staff.findByIdAndUpdate(id, { deletedAt: new Date() }, { new: true }).select('-passwordHash').lean(); }
    catch { return null; }
}

async function restore(id) {
    try { await connect(); return Staff.findByIdAndUpdate(id, { deletedAt: null }, { new: true }).select('-passwordHash').lean(); }
    catch { return null; }
}

module.exports = {
    list, count, countAdmins, findByUsername, findById, findByIdIncludingDeleted, findByIdStrict,
    create, verifyPassword, softDelete, restore, setPassword, setRole, updateProfile,
};
