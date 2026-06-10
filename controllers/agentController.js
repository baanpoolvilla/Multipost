const pageStore    = require('../services/pageStore');
const groupJobStore = require('../services/groupJobStore');

// ── Agent status page ──────────────────────────────────────────
exports.showAgent = async (req, res) => {
    res.render('agent');
};

// ── Groups page ────────────────────────────────────────────────
exports.showGroups = async (req, res) => {
    const pages = await pageStore.load();
    // Flatten all groups across all pages with page info attached
    const groups = [];
    pages.forEach(p => {
        (p.groups || []).forEach(g => {
            groups.push({ ...g, pageId: p.pageId, pageName: p.pageName });
        });
    });
    res.render('groups', { pages, groups });
};

// ── Job Queue page ─────────────────────────────────────────────
exports.showJobQueue = async (req, res) => {
    const [pages, jobs] = await Promise.all([pageStore.load(), groupJobStore.list()]);
    const groups = [];
    pages.forEach(p => {
        (p.groups || []).forEach(g => {
            groups.push({ ...g, pageId: p.pageId, pageName: p.pageName });
        });
    });
    res.render('job-queue', { jobs, groups });
};

// ── Job API ────────────────────────────────────────────────────
exports.listJobs = async (req, res) => {
    const jobs = await groupJobStore.list();
    res.json(jobs);
};

exports.createJob = async (req, res) => {
    const { message, groups, delaySeconds, accountId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
    if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'กรุณาเลือกกลุ่ม' });
    try {
        const job = await groupJobStore.create({
            message: message.trim(),
            groups,
            delaySeconds: delaySeconds || 5,
            accountId: accountId || null,
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
