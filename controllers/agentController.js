const pageStore    = require('../services/pageStore');
const groupJobStore = require('../services/groupJobStore');
const groupStore   = require('../services/groupStore');

// ── Agent status page ──────────────────────────────────────────
exports.showAgent = async (req, res) => {
    res.render('agent');
};

// ── Groups page ────────────────────────────────────────────────
exports.showGroups = async (req, res) => {
    const groups = await groupStore.list();
    res.render('groups', { groups });
};

exports.addGroup = async (req, res) => {
    const { groupId, groupName, category } = req.body;
    if (!groupId?.trim() || !groupName?.trim())
        return res.status(400).json({ error: 'กรุณากรอก Group ID และชื่อกลุ่ม' });
    const result = await groupStore.add(groupId.trim(), groupName.trim(), category?.trim() || 'ทั่วไป');
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, group: result.group });
};

exports.deleteGroup = async (req, res) => {
    await groupStore.remove(req.params.id);
    res.json({ ok: true });
};

exports.updateGroupCategory = async (req, res) => {
    const { category } = req.body;
    const g = await groupStore.updateCategory(req.params.id, category?.trim() || 'ทั่วไป');
    if (!g) return res.status(404).json({ error: 'ไม่พบกลุ่ม' });
    res.json({ ok: true, group: g });
};

exports.bulkRenameCategory = async (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName?.trim() || !newName?.trim())
        return res.status(400).json({ error: 'กรุณากรอกชื่อหมวด' });
    const result = await groupStore.bulkRenameCategory(oldName.trim(), newName.trim());
    if (result.error) return res.status(500).json({ error: result.error });
    res.json(result);
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
