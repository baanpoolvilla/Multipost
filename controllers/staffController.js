const staffStore    = require('../services/staffStore');
const postStore     = require('../services/postStore');
const groupJobStore = require('../services/groupJobStore');
const groupStore    = require('../services/groupStore');

// ── Manage staff accounts ──────────────────────────────────────
exports.showManageStaff = async (req, res) => {
    const staffList = await staffStore.list();
    res.render('manage-staff', { staffList });
};

exports.createStaffAccount = async (req, res) => {
    const { username, password, displayName } = req.body;
    if (!username?.trim() || !password || !displayName?.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    const result = await staffStore.create({ username: username.trim(), password, displayName: displayName.trim() });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, staff: result.staff });
};

exports.deleteStaffAccount = async (req, res) => {
    // There is no role system yet (every logged-in account has equal
    // access) — this guard at least prevents the whole team from ever being
    // wiped out down to zero accounts, which would silently re-open the
    // public bootstrap ("create the first account") flow on /login.
    let count;
    try {
        count = await staffStore.count();
    } catch {
        return res.status(500).json({ error: 'ระบบขัดข้องชั่วคราว (เชื่อมต่อฐานข้อมูลไม่ได้) กรุณาลองใหม่อีกครั้ง' });
    }
    if (count <= 1) {
        return res.status(400).json({ error: 'ไม่สามารถลบผู้ใช้งานคนสุดท้ายได้ ระบบต้องมีอย่างน้อย 1 บัญชีเสมอ' });
    }
    const staff = await staffStore.remove(req.params.id);
    res.json({ ok: !!staff });
};

// ── "ใครทำอะไร" overview ────────────────────────────────────────
function emptyBucket(id, displayName, username) {
    return { id, displayName, username, pagePostCount: 0, groupJobCount: 0, successCount: 0, failCount: 0, lastActivityAt: null };
}

function touchBucket(bucket, at) {
    if (!bucket.lastActivityAt || new Date(at) > new Date(bucket.lastActivityAt)) bucket.lastActivityAt = at;
}

exports.showUserActivity = async (req, res) => {
    const [staffList, posts, jobs] = await Promise.all([
        staffStore.list(),
        postStore.load(),
        groupJobStore.listHistory(),
    ]);

    const buckets = new Map();
    staffList.forEach(s => buckets.set(String(s._id), emptyBucket(String(s._id), s.displayName, s.username)));
    buckets.set('unassigned', emptyBucket('unassigned', 'ไม่ระบุตัวตน', null));

    const bucketFor = (staffId) => buckets.get(staffId && buckets.has(String(staffId)) ? String(staffId) : 'unassigned');

    posts.forEach(p => {
        const b = bucketFor(p.staffId);
        b.pagePostCount++;
        b.successCount += p.successCount || 0;
        b.failCount    += p.failCount || 0;
        touchBucket(b, p.createdAt);
    });

    jobs.forEach(j => {
        const b = bucketFor(j.staffId);
        b.groupJobCount++;
        b.successCount += (j.results || []).filter(r => r.status === 'success').length;
        b.failCount    += (j.results || []).filter(r => r.status === 'failed').length;
        touchBucket(b, j.createdAt);
    });

    const staffSummaries = [...buckets.values()]
        .filter(b => b.id !== 'unassigned' || (b.pagePostCount + b.groupJobCount) > 0)
        .sort((a, b) => (b.pagePostCount + b.groupJobCount) - (a.pagePostCount + a.groupJobCount));

    res.render('user-activity', { staffSummaries });
};

exports.showUserActivityDetail = async (req, res) => {
    const staffId = req.params.staffId;
    const isUnassigned = staffId === 'unassigned';

    let staffInfo;
    if (isUnassigned) {
        staffInfo = { id: 'unassigned', displayName: 'ไม่ระบุตัวตน' };
    } else {
        const s = await staffStore.findById(staffId);
        if (!s) return res.status(404).send('ไม่พบผู้ใช้งาน');
        staffInfo = { id: String(s._id), displayName: s.displayName };
    }

    const [allPosts, allJobs, allGroups] = await Promise.all([
        postStore.load(),
        groupJobStore.listHistory(),
        groupStore.list(),
    ]);

    const matches = (recordStaffId) => isUnassigned ? !recordStaffId : String(recordStaffId) === staffId;

    // groupId → categories, joined at read-time exactly like the privacy join
    // in controllers/agentController.js showGroupSummary (job/result rows
    // never carry the group's category themselves).
    const groupCatMap = {};
    allGroups.forEach(g => { groupCatMap[g.groupId] = (g.categories && g.categories.length) ? g.categories : ['ทั่วไป']; });

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
