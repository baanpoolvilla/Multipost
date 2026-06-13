const groupJobStore  = require('../services/groupJobStore');
const groupStore     = require('../services/groupStore');
const categoryStore  = require('../services/categoryStore');

// ── Agent status page ──────────────────────────────────────────
exports.showAgent = async (req, res) => {
    res.render('agent');
};

// ── Groups page ────────────────────────────────────────────────
exports.showGroups = async (req, res) => {
    const [groups, dbCategories] = await Promise.all([groupStore.list(), categoryStore.list()]);

    // dbCatMap: name → _id (string) — only for categories stored in DB
    const dbCatMap = {};
    dbCategories.forEach(c => { dbCatMap[c.name] = String(c._id); });

    // Merge: categories from DB  +  categories derived from existing groups; ทั่วไป always first
    const catsFromGroups = groups.map(g => g.category || 'ทั่วไป');
    const allCatsSet = new Set([...Object.keys(dbCatMap), ...catsFromGroups]);
    const allCats = [
        ...(allCatsSet.has('ทั่วไป') ? ['ทั่วไป'] : []),
        ...[...allCatsSet].filter(c => c !== 'ทั่วไป').sort(),
    ];

    res.render('groups', { groups, cats: allCats, dbCatMap });
};

// ── Category API ───────────────────────────────────────────────
exports.addCategory = async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อหมวด' });
    const result = await categoryStore.add(name.trim());
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, category: result.category });
};

exports.deleteCategory = async (req, res) => {
    await categoryStore.remove(req.params.id);
    res.json({ ok: true });
};

// ── Groups API ─────────────────────────────────────────────────
exports.addGroup = async (req, res) => {
    const { groupId, groupName, category } = req.body;
    if (!groupId?.trim() || !groupName?.trim())
        return res.status(400).json({ error: 'กรุณากรอก Group ID และชื่อกลุ่ม' });
    const cat = category?.trim() || 'ทั่วไป';
    // Auto-create category in DB if it doesn't exist yet
    await categoryStore.add(cat);
    const result = await groupStore.add(groupId.trim(), groupName.trim(), cat);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, group: result.group });
};

exports.deleteGroup = async (req, res) => {
    await groupStore.remove(req.params.id);
    res.json({ ok: true });
};

exports.updateGroupCategory = async (req, res) => {
    const { category } = req.body;
    const cat = category?.trim() || 'ทั่วไป';
    await categoryStore.add(cat);
    const g = await groupStore.updateCategory(req.params.id, cat);
    if (!g) return res.status(404).json({ error: 'ไม่พบกลุ่ม' });
    res.json({ ok: true, group: g });
};

exports.bulkRenameCategory = async (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName?.trim() || !newName?.trim())
        return res.status(400).json({ error: 'กรุณากรอกชื่อหมวด' });
    const [groupResult] = await Promise.all([
        groupStore.bulkRenameCategory(oldName.trim(), newName.trim()),
        categoryStore.renameByName(oldName.trim(), newName.trim()),
    ]);
    if (groupResult.error) return res.status(500).json({ error: groupResult.error });
    res.json({ ok: true });
};

// ── Job Queue page ─────────────────────────────────────────────
exports.showJobQueue = async (req, res) => {
    const [groups, jobs] = await Promise.all([groupStore.list(), groupJobStore.list()]);
    res.render('job-queue', { jobs, groups });
};

// ── Job API ────────────────────────────────────────────────────
exports.listJobs = async (req, res) => {
    const jobs = await groupJobStore.list();
    res.json(jobs);
};

exports.createJob = async (req, res) => {
    const { message, groups, delaySeconds, accountId, scheduledAt } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
    if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'กรุณาเลือกกลุ่ม' });
    try {
        const schedDate = scheduledAt ? new Date(scheduledAt) : null;
        const job = await groupJobStore.create({
            message: message.trim(),
            groups,
            delaySeconds: delaySeconds || 5,
            accountId: accountId || null,
            scheduledAt: (schedDate && schedDate > new Date()) ? schedDate.toISOString() : null,
        });
        res.json({ ok: true, job });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
};

exports.deleteJob = async (req, res) => {
    const job = await groupJobStore.remove(req.params.id);
    res.json({ success: !!job });
};
