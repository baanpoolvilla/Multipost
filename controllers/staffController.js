const staffStore    = require('../services/staffStore');
const postStore     = require('../services/postStore');
const groupJobStore = require('../services/groupJobStore');
const groupStore    = require('../services/groupStore');
const auditLogStore = require('../services/auditLogStore');
const { STATUS }    = require('../desktop-agent/src/scheduler/statuses');

// ── Manage staff accounts ──────────────────────────────────────

// req.canManageStaff is already computed fresh (live DB role + the
// zero-admins bootstrap escape hatch) by middleware/auth.js on every
// request — reusing it here instead of re-querying the DB avoids doing the
// same admin check twice per request.
exports.requireAdmin = (req, res, next) => {
    if (req.canManageStaff) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'หน้านี้สำหรับแอดมินเท่านั้น' });
    return res.status(403).send('หน้านี้สำหรับแอดมินเท่านั้น');
};

exports.showManageStaff = async (req, res) => {
    const allStaff = await staffStore.list({ includeDeleted: true });
    const staffList = allStaff.filter(s => !s.deletedAt);
    const deletedStaffList = allStaff.filter(s => s.deletedAt);
    res.render('manage-staff', { staffList, deletedStaffList });
};

exports.createStaffAccount = async (req, res) => {
    const { username, password, displayName, role } = req.body;
    if (!username?.trim() || !password || !displayName?.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    const result = await staffStore.create({ username: username.trim(), password, displayName: displayName.trim(), role });
    if (result.error) return res.status(400).json({ error: result.error });
    // Awaited (not fire-and-forget): on Vercel serverless, work left running
    // after the response is sent isn't guaranteed to finish before the
    // function is frozen/torn down, which would silently drop the log entry.
    await auditLogStore.log({
        action: auditLogStore.ACTIONS.CREATE,
        actorId: req.staffId, actorName: req.staffName,
        targetId: String(result.staff._id), targetName: result.staff.displayName,
        details: { username: result.staff.username, role: result.staff.role },
    });
    res.json({ ok: true, staff: result.staff });
};

exports.deleteStaffAccount = async (req, res) => {
    let count;
    try {
        count = await staffStore.count();
    } catch {
        return res.status(500).json({ error: 'ระบบขัดข้องชั่วคราว (เชื่อมต่อฐานข้อมูลไม่ได้) กรุณาลองใหม่อีกครั้ง' });
    }
    if (count <= 1) {
        return res.status(400).json({ error: 'ไม่สามารถลบผู้ใช้งานคนสุดท้ายได้ ระบบต้องมีอย่างน้อย 1 บัญชีเสมอ' });
    }

    const target = await staffStore.findById(req.params.id);
    if (target?.role === 'admin') {
        const admins = await staffStore.countAdmins();
        if (admins <= 1) return res.status(400).json({ error: 'ไม่สามารถลบแอดมินคนสุดท้ายได้ ระบบต้องมีแอดมินอย่างน้อย 1 คนเสมอ' });
    }

    // Soft delete: the row stays (so it can be restored, and its historical
    // posts/jobs keep resolving to a real name), just marked removed.
    const staff = await staffStore.softDelete(req.params.id);
    if (staff) {
        await auditLogStore.log({
            action: auditLogStore.ACTIONS.SOFT_DELETE,
            actorId: req.staffId, actorName: req.staffName,
            targetId: String(staff._id), targetName: staff.displayName,
            details: { username: staff.username },
        });
    }
    res.json({ ok: !!staff });
};

exports.restoreStaffAccount = async (req, res) => {
    const staff = await staffStore.restore(req.params.id);
    if (!staff) return res.status(404).json({ error: 'ไม่พบผู้ใช้งานที่ถูกลบ' });
    await auditLogStore.log({
        action: auditLogStore.ACTIONS.RESTORE,
        actorId: req.staffId, actorName: req.staffName,
        targetId: String(staff._id), targetName: staff.displayName,
        details: { username: staff.username },
    });
    res.json({ ok: true, staff });
};

exports.editStaffAccount = async (req, res) => {
    const { username, displayName } = req.body;
    if (!username?.trim() || !displayName?.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });

    const before = await staffStore.findById(req.params.id);
    const result = await staffStore.updateProfile(req.params.id, { username: username.trim(), displayName: displayName.trim() });
    if (result.error) return res.status(400).json({ error: result.error });

    await auditLogStore.log({
        action: auditLogStore.ACTIONS.PROFILE_EDIT,
        actorId: req.staffId, actorName: req.staffName,
        targetId: String(result.staff._id), targetName: result.staff.displayName,
        details: {
            username: { from: before?.username ?? null, to: result.staff.username },
            displayName: { from: before?.displayName ?? null, to: result.staff.displayName },
        },
    });
    res.json({ ok: true, staff: result.staff });
};

exports.changeStaffPassword = async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'กรุณากรอกรหัสผ่านใหม่' });
    const target = await staffStore.findById(req.params.id);
    const result = await staffStore.setPassword(req.params.id, password);
    if (result.error) return res.status(400).json({ error: result.error });

    await auditLogStore.log({
        action: auditLogStore.ACTIONS.PASSWORD_RESET,
        actorId: req.staffId, actorName: req.staffName,
        targetId: req.params.id, targetName: target?.displayName ?? null,
    });
    res.json({ ok: true });
};

exports.changeStaffRole = async (req, res) => {
    const { role } = req.body;
    if (role !== 'admin' && role !== 'staff') return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });

    const target = await staffStore.findById(req.params.id);
    if (role === 'staff' && target?.role === 'admin') {
        const admins = await staffStore.countAdmins();
        if (admins <= 1) return res.status(400).json({ error: 'ไม่สามารถลดสิทธิ์แอดมินคนสุดท้ายได้ ระบบต้องมีแอดมินอย่างน้อย 1 คนเสมอ' });
    }

    const staff = await staffStore.setRole(req.params.id, role);
    if (staff) {
        await auditLogStore.log({
            action: auditLogStore.ACTIONS.ROLE_CHANGE,
            actorId: req.staffId, actorName: req.staffName,
            targetId: String(staff._id), targetName: staff.displayName,
            details: { from: target?.role ?? null, to: role },
        });
    }
    res.json({ ok: !!staff, staff });
};

// ── "ใครทำอะไร" overview ────────────────────────────────────────
function emptyBucket(id, displayName, username, isDeleted = false) {
    return {
        id, displayName, username, isDeleted,
        pagePostCount: 0, groupJobCount: 0, successCount: 0, failCount: 0, lastActivityAt: null,
        pageSet: new Set(), groupSet: new Set(),
    };
}

function touchBucket(bucket, at) {
    if (!bucket.lastActivityAt || new Date(at) > new Date(bucket.lastActivityAt)) bucket.lastActivityAt = at;
}

exports.showUserActivity = async (req, res) => {
    // includeDeleted: a soft-deleted account's historical posts/jobs should
    // still show under their real name here, not collapse into
    // "ไม่ระบุตัวตน" just because the account itself was removed.
    const [staffList, posts, jobs] = await Promise.all([
        staffStore.list({ includeDeleted: true }),
        postStore.load(),
        groupJobStore.listHistory(),
    ]);

    const buckets = new Map();
    staffList.forEach(s => buckets.set(String(s._id), emptyBucket(String(s._id), s.displayName, s.username, !!s.deletedAt)));
    buckets.set('unassigned', emptyBucket('unassigned', 'ไม่ระบุตัวตน', null));

    const bucketFor = (staffId) => buckets.get(staffId && buckets.has(String(staffId)) ? String(staffId) : 'unassigned');

    // Only count posts that have actually happened (success/failed) — same
    // completed-only semantics as groupJobStore.listHistory() already
    // applies to jobs. postStore.load() returns every status including
    // still-pending/future-scheduled posts; counting those here would
    // inflate pagePostCount with work that hasn't occurred yet and skew the
    // ranking against a colleague who has actually completed real jobs.
    const completedPosts = posts.filter(p => p.status === STATUS.SUCCESS || p.status === STATUS.FAILED);

    completedPosts.forEach(p => {
        const b = bucketFor(p.staffId);
        b.pagePostCount++;
        b.successCount += p.successCount || 0;
        b.failCount    += p.failCount || 0;
        (p.results || []).forEach(r => { const key = r.pageId || r.pageName; if (key) b.pageSet.add(key); });
        touchBucket(b, p.createdAt);
    });

    jobs.forEach(j => {
        const b = bucketFor(j.staffId);
        b.groupJobCount++;
        b.successCount += (j.results || []).filter(r => r.status === 'success').length;
        b.failCount    += (j.results || []).filter(r => r.status === 'failed').length;
        (j.results || []).forEach(r => { const key = r.groupId || r.groupName; if (key) b.groupSet.add(key); });
        touchBucket(b, j.createdAt);
    });

    const staffSummaries = [...buckets.values()]
        .map(b => ({ ...b, pageCount: b.pageSet.size, groupCount: b.groupSet.size }))
        // "unassigned" only shows up if it actually has history. Soft-deleted
        // accounts are hidden here entirely (regardless of history) until
        // restored -- their historical posts/jobs still count correctly
        // toward this bucket internally (bucketFor above still resolves
        // their real staffId, not "unassigned"), just the card is hidden.
        .filter(b => b.id === 'unassigned' ? (b.pagePostCount + b.groupJobCount) > 0 : !b.isDeleted)
        .sort((a, b) => (b.pagePostCount + b.groupJobCount) - (a.pagePostCount + a.groupJobCount));

    res.render('user-activity', { staffSummaries });
};

exports.showUserActivityDetail = async (req, res) => {
    const staffId = req.params.staffId;
    const isUnassigned = staffId === 'unassigned';

    let staffInfo;
    let knownStaffIds = null;
    if (isUnassigned) {
        staffInfo = { id: 'unassigned', displayName: 'ไม่ระบุตัวตน' };
        // includeDeleted: a soft-deleted account is still "known" (its
        // history should resolve to its own page, not fall in here).
        const staffList = await staffStore.list({ includeDeleted: true });
        knownStaffIds = new Set(staffList.map(s => String(s._id)));
    } else {
        // Active only: a soft-deleted account's own detail page is hidden
        // (404) the same as it's hidden from the overview list, until
        // restored -- staffId on its historical posts/jobs never changes, so
        // this page works again on its own the moment the account comes back.
        const s = await staffStore.findById(staffId);
        if (!s) return res.status(404).send('ไม่พบผู้ใช้งาน');
        staffInfo = { id: String(s._id), displayName: s.displayName };
    }

    const [allPosts, allJobs, allGroups] = await Promise.all([
        postStore.load(),
        groupJobStore.listAll(),
        groupStore.list(),
    ]);

    // Same "unassigned" rule as bucketFor in showUserActivity: a record is
    // unassigned if it has no staffId, OR its staffId no longer belongs to
    // any current staff account (e.g. that account was deleted) -- using
    // only "!recordStaffId" here would exclude deleted-account records that
    // the overview page's card already counted, so the two pages'
    // numbers would silently disagree.
    const matches = (recordStaffId) => isUnassigned
        ? (!recordStaffId || !knownStaffIds.has(String(recordStaffId)))
        : String(recordStaffId) === staffId;

    // groupId → categories, joined at read-time exactly like the privacy join
    // in controllers/agentController.js showGroupSummary (job/result rows
    // never carry the group's category themselves).
    const groupCatMap = {};
    allGroups.forEach(g => { groupCatMap[g.groupId] = (g.categories && g.categories.length) ? g.categories : ['ทั่วไป']; });

    // Every status here, unlike showUserActivity's overview cards (which
    // deliberately count completed work only, for fair ranking between
    // people) -- this is a specific person's full record, so pending/running
    // items should show too, not silently disappear until they finish. The
    // dashboard's "แยกตามพนักงาน" widget already counts every status when
    // summarizing a person, so this page needs to match what clicking into
    // it promised.
    const posts = allPosts.filter(p => matches(p.staffId));
    const jobs  = allJobs.filter(j => matches(j.staffId)).map(j => ({
        ...j,
        _id: String(j._id),
        successCount: (j.results || []).filter(r => r.status === 'success').length,
        failCount:    (j.results || []).filter(r => r.status === 'failed').length,
        groupCount:   (j.groups  || []).length,
        categories:   [...new Set((j.groups || []).flatMap(g => groupCatMap[g.groupId] || ['ทั่วไป']))],
    }));

    const pageSuccess = posts.reduce((s, p) => s + (p.successCount || 0), 0);
    const pageFail    = posts.reduce((s, p) => s + (p.failCount || 0), 0);
    const grpSuccess  = jobs.reduce((s, j) => s + j.successCount, 0);
    const grpFail     = jobs.reduce((s, j) => s + j.failCount, 0);

    // ── Per-page breakdown (which pages, how many, success/fail each) ──
    // Same aggregation shape as controllers/postController.js showPageSummary.
    const pageCounts = {};
    posts.forEach(p => {
        (p.results || []).forEach(r => {
            const key = r.pageId || r.pageName || 'ไม่ทราบ';
            // `id` must match the same key used in each post card's data-pages
            // list (views/user-activity-detail.ejs) or clicking a row here
            // would never match any card.
            if (!pageCounts[key]) pageCounts[key] = { id: key, name: r.pageName || r.pageId || 'ไม่ทราบ', success: 0, fail: 0 };
            if (r.status === 'success') pageCounts[key].success++; else pageCounts[key].fail++;
        });
    });
    const pageStats = Object.values(pageCounts).sort((a, b) => (b.success + b.fail) - (a.success + a.fail));

    // ── Per-group + per-category breakdown ──────────────────────────
    // Same join pattern as controllers/agentController.js showGroupSummary
    // (there it joins privacy; here we join category, since job/result rows
    // only carry groupId/groupName, never the group's category itself).
    const groupCounts = {};
    const categoryCounts = {};
    jobs.forEach(j => {
        (j.results || []).forEach(r => {
            const ok  = r.status === 'success';
            const key = r.groupId || r.groupName || 'ไม่ทราบ';
            const cats = groupCatMap[r.groupId] || ['ทั่วไป'];
            // `id` must match the same key used in each job card's
            // data-groups list (views/user-activity-detail.ejs).
            if (!groupCounts[key]) groupCounts[key] = { id: key, name: r.groupName || r.groupId || 'ไม่ทราบ', categories: cats, success: 0, fail: 0 };
            if (ok) groupCounts[key].success++; else groupCounts[key].fail++;

            cats.forEach(cat => {
                if (!categoryCounts[cat]) categoryCounts[cat] = { success: 0, fail: 0 };
                if (ok) categoryCounts[cat].success++; else categoryCounts[cat].fail++;
            });
        });
    });
    const groupStats = Object.values(groupCounts).sort((a, b) => (b.success + b.fail) - (a.success + a.fail));
    // 'ทั่วไป' (general) first, rest alphabetically — matches the convention
    // used by /groups and /job-queue category dropdowns.
    const categoryStats = Object.entries(categoryCounts)
        .map(([name, st]) => ({ name, ...st }))
        .sort((a, b) => a.name === 'ทั่วไป' ? -1 : b.name === 'ทั่วไป' ? 1 : a.name.localeCompare(b.name, 'th'));

    res.render('user-activity-detail', {
        staffInfo, posts, jobs,
        pageSuccess, pageFail, grpSuccess, grpFail,
        pageStats, groupStats, categoryStats,
    });
};

// ── Audit log (บัญชีผู้ใช้งานถูกเปลี่ยนแปลงอะไรไปบ้าง) ─────────────
const ACTION_LABEL_TH = {
    create:          'เพิ่มบัญชี',
    soft_delete:     'ลบบัญชี',
    restore:         'กู้คืนบัญชี',
    role_change:     'เปลี่ยนสิทธิ์',
    password_reset:  'เปลี่ยนรหัสผ่าน',
    profile_edit:    'แก้ไขข้อมูล',
};

exports.showAuditLog = async (req, res) => {
    const entries = await auditLogStore.list();
    const rows = entries.map(e => ({
        ...e,
        _id: String(e._id),
        actionLabel: ACTION_LABEL_TH[e.action] || e.action,
    }));
    res.render('audit-log', { rows });
};
