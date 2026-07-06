const staffStore    = require('../services/staffStore');
const postStore     = require('../services/postStore');
const groupJobStore = require('../services/groupJobStore');

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
    buckets.set('unassigned', emptyBucket('unassigned', 'ไม่ระบุ', null));

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
        staffInfo = { id: 'unassigned', displayName: 'ไม่ระบุ' };
    } else {
        const s = await staffStore.findById(staffId);
        if (!s) return res.status(404).send('ไม่พบผู้ใช้งาน');
        staffInfo = { id: String(s._id), displayName: s.displayName };
    }

    const [allPosts, allJobs] = await Promise.all([
        postStore.load(),
        groupJobStore.listHistory(),
    ]);

    const matches = (recordStaffId) => isUnassigned ? !recordStaffId : String(recordStaffId) === staffId;

    const posts = allPosts.filter(p => matches(p.staffId));
    const jobs  = allJobs.filter(j => matches(j.staffId)).map(j => ({
        ...j,
        _id: String(j._id),
        successCount: (j.results || []).filter(r => r.status === 'success').length,
        failCount:    (j.results || []).filter(r => r.status === 'failed').length,
        groupCount:   (j.groups  || []).length,
    }));

    const pageSuccess = posts.reduce((s, p) => s + (p.successCount || 0), 0);
    const pageFail    = posts.reduce((s, p) => s + (p.failCount || 0), 0);
    const grpSuccess  = jobs.reduce((s, j) => s + j.successCount, 0);
    const grpFail     = jobs.reduce((s, j) => s + j.failCount, 0);

    res.render('user-activity-detail', {
        staffInfo, posts, jobs,
        pageSuccess, pageFail, grpSuccess, grpFail,
    });
};
