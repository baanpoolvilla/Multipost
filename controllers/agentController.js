const groupJobStore  = require('../services/groupJobStore');
const groupStore     = require('../services/groupStore');
const categoryStore  = require('../services/categoryStore');
const postStore      = require('../services/postStore');
const { refreshPostAnalytics } = require('../services/facebookService');
const { STATUS }     = require('../desktop-agent/src/scheduler/statuses');
const agentPresence  = require('../desktop-agent/src/agentPresence');

// ── Group Overview Dashboard ───────────────────────────────────
exports.showGroupOverview = async (req, res) => {
    try {
        const [jobs, groups] = await Promise.all([groupJobStore.listHistory(), groupStore.list()]);

        const totalJobs    = jobs.length;
        const totalSuccess = jobs.reduce((s, j) => s + (j.results||[]).filter(r=>r.status==='success').length, 0);
        const totalFail    = jobs.reduce((s, j) => s + (j.results||[]).filter(r=>r.status==='failed').length, 0);
        const successRate  = (totalSuccess + totalFail) > 0 ? Math.round(totalSuccess/(totalSuccess+totalFail)*100) : 0;

        // groupId → privacy map
        const privacyMap = {};
        groups.forEach(g => { privacyMap[g.groupId] = g.privacy || null; });

        // Privacy breakdown stats
        const privacyStats = { public: { success:0, fail:0 }, private: { success:0, fail:0 }, paid: { success:0, fail:0 } };
        jobs.forEach(j => {
            (j.results||[]).forEach(r => {
                const pv = privacyMap[r.groupId] || null;
                if (pv === 'public' || pv === 'private' || pv === 'paid') {
                    if (r.status === 'success') privacyStats[pv].success++;
                    else privacyStats[pv].fail++;
                }
            });
        });

        // All groups sorted by activity — include analytics totals + privacy
        const grpCounts = {};
        jobs.forEach(j => {
            (j.results||[]).forEach(r => {
                const key = r.groupId || r.groupName || 'ไม่ทราบ';
                if (!grpCounts[key]) grpCounts[key] = {
                    groupId: r.groupId || null,
                    name: r.groupName || r.groupId || 'ไม่ทราบ',
                    privacy: privacyMap[r.groupId] || null,
                    success: 0, fail: 0, likes: 0, comments: 0, shares: 0, reach: 0,
                };
                if (r.status === 'success') grpCounts[key].success++;
                else grpCounts[key].fail++;
                if (r.analytics) {
                    grpCounts[key].likes    += r.analytics.likes    || 0;
                    grpCounts[key].comments += r.analytics.comments || 0;
                    grpCounts[key].shares   += r.analytics.shares   || 0;
                    grpCounts[key].reach    += r.analytics.reach    || 0;
                }
            });
        });
        const allGroupStats = Object.values(grpCounts)
            .sort((a,b) => (b.success+b.fail)-(a.success+a.fail));
        const topGroups = allGroupStats.slice(0,5);

        // Analytics totals
        const totalLikes    = allGroupStats.reduce((s,g)=>s+g.likes,0);
        const totalComments = allGroupStats.reduce((s,g)=>s+g.comments,0);
        const totalShares   = allGroupStats.reduce((s,g)=>s+g.shares,0);
        const hasAnalytics  = totalLikes > 0 || totalComments > 0 || totalShares > 0;

        // Chart last 7 days (Bangkok)
        const labels = [], chartData = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Bangkok' }));
            d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString('th-TH', { month:'short', day:'numeric' }));
            chartData.push(jobs.filter(j => {
                const jd = new Date(new Date(j.createdAt).toLocaleString('en-US', { timeZone:'Asia/Bangkok' }));
                return jd.getFullYear()===d.getFullYear() && jd.getMonth()===d.getMonth() && jd.getDate()===d.getDate();
            }).length);
        }

        const recentJobs = jobs.slice(0, 10).map(j => ({
            ...j, _id: String(j._id),
            successCount: (j.results||[]).filter(r=>r.status==='success').length,
            failCount:    (j.results||[]).filter(r=>r.status==='failed').length,
            groupCount:   (j.groups||[]).length,
        }));

        res.render('group-overview', {
            totalJobs, totalSuccess, totalFail, successRate, topGroups, allGroupStats,
            totalLikes, totalComments, totalShares, hasAnalytics,
            chartLabels: JSON.stringify(labels),
            chartData:   JSON.stringify(chartData),
            recentJobs, privacyStats,
        });
    } catch (e) {
        res.status(500).send('เกิดข้อผิดพลาด: ' + e.message);
    }
};

// ── Group Summary Page ─────────────────────────────────────────
exports.showGroupSummary = async (req, res) => {
    const referer = req.headers.referer || '';
    const isAllowed = referer.includes('/group-overview') || referer.includes('/group-summary');
    if (!isAllowed) return res.redirect('/group-overview');

    const { from = '', to = '', timeFrom = '', timeTo = '' } = req.query;
    let result = null;

    try {
        const fromDate = from ? new Date(`${from}T${timeFrom || '00:00:00'}+07:00`) : null;
        const toDate   = to   ? new Date(`${to}T${timeTo ? timeTo+':59' : '23:59:59'}+07:00`) : null;

        const [grpJobs, groups] = await Promise.all([groupJobStore.listHistory(), groupStore.list()]);
        const privacyMap = {};
        groups.forEach(g => { privacyMap[g.groupId] = g.privacy || null; });

        const filtered = grpJobs.filter(j => {
            const t = new Date(j.createdAt).getTime();
            if (fromDate && t < fromDate.getTime()) return false;
            if (toDate   && t > toDate.getTime())   return false;
            return true;
        });

        let totalSuccess = 0, totalFail = 0;
        const privacyStats = {
            public:  { success:0, fail:0 },
            private: { success:0, fail:0 },
            paid:    { success:0, fail:0 },
        };
        const grpCounts = {};

        filtered.forEach(j => {
            (j.results || []).forEach(r => {
                const ok = r.status === 'success';
                if (ok) totalSuccess++; else totalFail++;
                const pv = privacyMap[r.groupId] || null;
                if (pv === 'public' || pv === 'private' || pv === 'paid') {
                    if (ok) privacyStats[pv].success++; else privacyStats[pv].fail++;
                }
                const key = r.groupId || r.groupName || 'ไม่ทราบ';
                if (!grpCounts[key]) grpCounts[key] = {
                    name: r.groupName || r.groupId || 'ไม่ทราบ',
                    privacy: privacyMap[r.groupId] || null,
                    success: 0, fail: 0,
                };
                if (ok) grpCounts[key].success++; else grpCounts[key].fail++;
            });
        });

        const allGroupStats = Object.values(grpCounts)
            .sort((a,b) => (b.success+b.fail)-(a.success+a.fail));
        const successRate = (totalSuccess+totalFail) > 0
            ? Math.round(totalSuccess/(totalSuccess+totalFail)*100) : 0;

        result = { totalJobs: filtered.length, totalSuccess, totalFail, successRate, privacyStats, allGroupStats };
    } catch (e) {
        result = { error: e.message };
    }

    res.render('group-summary', { from, to, timeFrom, timeTo, result });
};

// ── Agent status page ──────────────────────────────────────────
exports.showAgent = async (req, res) => {
    res.render('agent');
};

// ── Groups page ────────────────────────────────────────────────
exports.showGroups = async (req, res) => {
    const [groups, dbCategories] = await Promise.all([groupStore.list(), categoryStore.list()]);

    const dbCatMap = {};
    let latestCats = dbCategories;
    dbCategories.forEach(c => { dbCatMap[c.name] = String(c._id); });

    const allCatsSet = new Set(Object.keys(dbCatMap));
    groups.forEach(g => (g.categories || ['ทั่วไป']).forEach(c => allCatsSet.add(c)));

    const orphanCats = [...allCatsSet].filter(c => c !== 'ทั่วไป' && !dbCatMap[c]);
    if (orphanCats.length) {
        await Promise.all(orphanCats.map(name => categoryStore.add(name)));
        latestCats = await categoryStore.list();
        latestCats.forEach(c => { dbCatMap[c.name] = String(c._id); });
    }

    const catColorMap = { 'ทั่วไป': '#868e96' };
    latestCats.forEach(c => { catColorMap[c.name] = c.color || '#1877f2'; });

    const allCats = [
        ...(allCatsSet.has('ทั่วไป') ? ['ทั่วไป'] : []),
        ...[...allCatsSet].filter(c => c !== 'ทั่วไป').sort(),
    ];

    res.render('groups', { groups, cats: allCats, dbCatMap, catColorMap });
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
    const deleted = await categoryStore.remove(req.params.id);
    if (deleted?.name) await groupStore.bulkRemoveCategory(deleted.name);
    res.json({ ok: true });
};

exports.updateCategoryColor = async (req, res) => {
    const { color } = req.body;
    if (!color?.trim()) return res.status(400).json({ error: 'กรุณาระบุสี' });
    const updated = await categoryStore.updateColor(req.params.id, color.trim());
    if (!updated) return res.status(404).json({ error: 'ไม่พบหมวด' });
    res.json({ ok: true, category: updated });
};

// ── Groups API ─────────────────────────────────────────────────
exports.addGroup = async (req, res) => {
    const { groupId, groupName, category, privacy } = req.body;
    if (!groupId?.trim() || !groupName?.trim())
        return res.status(400).json({ error: 'กรุณากรอก Group ID และชื่อกลุ่ม' });
    const cat = category?.trim() || 'ทั่วไป';
    await categoryStore.add(cat);
    const result = await groupStore.add(groupId.trim(), groupName.trim(), cat, privacy || null);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, group: result.group });
};

exports.deleteGroup = async (req, res) => {
    await groupStore.remove(req.params.id);
    res.json({ ok: true });
};

// Add a category to the group (keeps existing categories including ทั่วไป)
exports.updateGroupCategory = async (req, res) => {
    const { category } = req.body;
    const cat = category?.trim() || 'ทั่วไป';
    await categoryStore.add(cat);
    const g = await groupStore.addToCategory(req.params.id, cat);
    if (!g) return res.status(404).json({ error: 'ไม่พบกลุ่ม' });
    res.json({ ok: true, group: g });
};

// Remove a group from a specific category (group stays in ทั่วไป)
exports.removeGroupFromCategory = async (req, res) => {
    const { category } = req.body;
    if (!category?.trim()) return res.status(400).json({ error: 'กรุณาระบุหมวด' });
    const result = await groupStore.removeFromCategory(req.params.id, category.trim());
    if (result && result.error) return res.status(400).json({ error: result.error });
    if (!result) return res.status(404).json({ error: 'ไม่พบกลุ่ม' });
    res.json({ ok: true });
};

exports.setGroupPrivacy = async (req, res) => {
    const { privacy } = req.body;   // 'public' | 'private' | null
    const result = await groupStore.setPrivacy(req.params.id, privacy || null);
    if (result.error) return res.status(400).json(result);
    res.json({ ok: true });
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
    await groupJobStore.expireOverdueJobs().catch(() => {});
    const [groups, jobs, dbCategories] = await Promise.all([groupStore.list(), groupJobStore.list(), categoryStore.list()]);
    const catColorMap = { 'ทั่วไป': '#868e96' };
    dbCategories.forEach(c => { catColorMap[c.name] = c.color || '#1877f2'; });
    res.render('job-queue', { jobs, groups, catColorMap });
};

// ── Job API ────────────────────────────────────────────────────
exports.listJobs = async (req, res) => {
    await groupJobStore.expireOverdueJobs().catch(() => {});
    const jobs = await groupJobStore.list();
    res.json(jobs);
};

exports.createJob = async (req, res) => {
    const { message, groups, delaySeconds, accountId, scheduledAt, images, pageId, pageName } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
    if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'กรุณาเลือกกลุ่ม' });
    try {
        const schedDate = scheduledAt ? new Date(scheduledAt) : null;
        const staffId = req.staffId || null;
        // If the staff member who's creating this has their own Desktop
        // Agent machine online right now, pin the job there (same agentId
        // mechanism that already safely prevents a different machine from
        // grabbing it — see desktop-agent/src/scheduler/schedulerService.js).
        // If they don't have one online, leave agentId null: any running
        // agent may claim it, same as before.
        const pinnedAgentId = await agentPresence.findOnlineAgentForStaff(staffId).catch(() => null);
        const job = await groupJobStore.create({
            message: message.trim(),
            groups,
            pageId:   pageId   || null,
            pageName: pageName || null,
            delaySeconds: delaySeconds || 5,
            accountId: accountId || null,
            scheduledAt: (schedDate && schedDate > new Date()) ? schedDate.toISOString() : null,
            images: Array.isArray(images) ? images : [],
            staffId,
            agentId: pinnedAgentId,
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

exports.rescheduleJob = async (req, res) => {
    const { scheduledAt } = req.body;
    try {
        const schedDate = scheduledAt ? new Date(scheduledAt) : null;
        if (schedDate && isNaN(schedDate.getTime())) return res.status(400).json({ error: 'วันเวลาไม่ถูกต้อง' });
        // Rescheduling (incl. reviving an expired job) lands back in
        // 'pending' with expiredAt cleared — handled by SchedulerService.UpdateJob.
        const job = await groupJobStore.updateOne(req.params.id, {
            scheduledAt: schedDate ? schedDate.toISOString() : null,
        });
        res.json({ ok: !!job, job });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
};

exports.listScheduledJobs = async (req, res) => {
    try {
        await groupJobStore.expireOverdueJobs();
        const jobs = await groupJobStore.listScheduled();
        const now  = new Date();
        const enriched = jobs.map(j => ({
            ...j,
            _id: String(j._id),
            // Kept for UI: true once a due job is about to be picked up by
            // the runner, but it never sits "overdue" for long — anything
            // genuinely missed already flipped to status:'expired' above
            // and dropped out of listScheduled() (which only returns pending).
            isOverdue: j.scheduledAt && new Date(j.scheduledAt) < now,
        }));
        res.json(enriched);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
};

// ── Schedule Center actions ───────────────────────────────────
exports.editJob = async (req, res) => {
    try {
        const { message, groups, delaySeconds, scheduledAt, pageId, pageName } = req.body;
        const patch = {};
        if (typeof message === 'string' && message.trim()) patch.message = message.trim();
        if (Array.isArray(groups) && groups.length) patch.groups = groups;
        if (delaySeconds !== undefined) patch.delaySeconds = delaySeconds;
        if (pageId   !== undefined) patch.pageId   = pageId   || null;
        if (pageName !== undefined) patch.pageName = pageName || null;
        if ('scheduledAt' in req.body) {
            const d = scheduledAt ? new Date(scheduledAt) : null;
            if (scheduledAt && isNaN(d?.getTime())) return res.status(400).json({ error: 'วันเวลาไม่ถูกต้อง' });
            patch.scheduledAt = d ? d.toISOString() : null;
        }
        const job = await groupJobStore.updateOne(req.params.id, patch);
        if (!job) return res.status(404).json({ error: 'ไม่พบงาน' });
        res.json({ ok: true, job });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// "Post Now": clears the schedule so the next Agent poll (or Web queue
// view) picks it up immediately as a normal due job — group jobs are only
// ever executed by the Desktop Agent runner, never by Web directly.
exports.postNowJob = async (req, res) => {
    try {
        const job = await groupJobStore.updateOne(req.params.id, { scheduledAt: null, status: STATUS.PENDING, expiredAt: null });
        if (!job) return res.status(404).json({ error: 'ไม่พบงาน' });
        res.json({ ok: true, job });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.listExpiredJobs = async (req, res) => {
    try {
        const jobs = await groupJobStore.listExpired();
        res.json(jobs.map(j => ({ ...j, _id: String(j._id) })));
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
};

exports.retryJob = async (req, res) => {
    try {
        const job = await groupJobStore.retryJob(req.params.id);
        res.json({ ok: true, job });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
};

exports.cancelJob = async (req, res) => {
    try {
        const job = await groupJobStore.cancelJob(req.params.id);
        res.json({ ok: true, job });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
};

// ── Group History page ─────────────────────────────────────────
exports.showGroupHistory = async (req, res) => {
    const [jobs, groups, dbCategories] = await Promise.all([
        groupJobStore.listHistory(),
        groupStore.list(),
        categoryStore.list(),
    ]);

    // groupId → categories map for category-based filtering on client
    const groupCatMap = {};
    groups.forEach(g => { groupCatMap[g.groupId] = g.categories || ['ทั่วไป']; });

    // groupId → privacy map for privacy-based filtering on client
    const groupPrivacyMap = {};
    groups.forEach(g => { groupPrivacyMap[g.groupId] = g.privacy || null; });

    // All distinct categories (from DB + from group data)
    const catSet = new Set(dbCategories.map(c => c.name));
    groups.forEach(g => (g.categories || ['ทั่วไป']).forEach(c => catSet.add(c)));
    const allCats = ['ทั่วไป', ...[...catSet].filter(c => c !== 'ทั่วไป').sort()];

    // Enrich jobs with successCount/failCount
    const enriched = jobs.map(j => {
        const results = j.results || [];
        return {
            ...j,
            _id: String(j._id),
            successCount: results.filter(r => r.status === 'success').length,
            failCount:    results.filter(r => r.status === 'failed').length,
        };
    });

    res.render('group-history', { jobs: enriched, groupCatMap, groupPrivacyMap, allCats });
};

exports.deleteGroupHistoryJob = async (req, res) => {
    const job = await groupJobStore.deleteHistory(req.params.id);
    res.json({ success: !!job });
};

// ── Combined stats API (page posts + group posts by date range) ─
exports.getCombinedStats = async (req, res) => {
    try {
        const { from, to, timeFrom, timeTo } = req.query; // YYYY-MM-DD (Bangkok timezone)
        const fromDate = from ? new Date(`${from}T${timeFrom || '00:00:00'}+07:00`) : null;
        const toDate   = to   ? new Date(`${to}T${timeTo ? timeTo+':59' : '23:59:59'}+07:00`) : null;

        // Page posts
        let posts = await postStore.load();
        if (fromDate) posts = posts.filter(p => new Date(p.createdAt).getTime() >= fromDate.getTime());
        if (toDate)   posts = posts.filter(p => new Date(p.createdAt).getTime() <= toDate.getTime());
        const pageStats = {
            total:   posts.length,
            success: posts.reduce((s, p) => s + (p.successCount || 0), 0),
            fail:    posts.reduce((s, p) => s + (p.failCount    || 0), 0),
        };

        // Group posts
        const groupStats = await groupJobStore.statsByDateRange(fromDate, toDate);

        // Top 5 pages by post count
        const pageCounts = {};
        posts.forEach(p => {
            (p.results || []).forEach(r => {
                const key = r.pageId || r.pageName || 'ไม่ทราบเพจ';
                if (!pageCounts[key]) pageCounts[key] = { name: r.pageName || r.pageId || 'ไม่ทราบ', success: 0, fail: 0 };
                if (r.status === 'published' || r.status === 'success') pageCounts[key].success++;
                else pageCounts[key].fail++;
            });
        });
        const topPages = Object.values(pageCounts)
            .sort((a, b) => (b.success + b.fail) - (a.success + a.fail))
            .slice(0, 5);

        // Top 5 groups by share count
        const grpJobs = await groupJobStore.listHistory();
        const filteredGrpJobs = grpJobs.filter(j => {
            const t = new Date(j.createdAt).getTime();
            if (fromDate && t < fromDate.getTime()) return false;
            if (toDate   && t > toDate.getTime())   return false;
            return true;
        });
        const grpCounts = {};
        filteredGrpJobs.forEach(j => {
            (j.results || []).forEach(r => {
                const key = r.groupId || r.groupName || 'ไม่ทราบ';
                if (!grpCounts[key]) grpCounts[key] = { name: r.groupName || r.groupId || 'ไม่ทราบ', success: 0, fail: 0 };
                if (r.status === 'success') grpCounts[key].success++;
                else grpCounts[key].fail++;
            });
        });
        const topGroups = Object.values(grpCounts)
            .sort((a, b) => (b.success + b.fail) - (a.success + a.fail))
            .slice(0, 5);

        res.json({ ok: true, pageStats, groupStats, topPages, topGroups });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
};

// ── Refresh Group Analytics (pull likes/comments/shares from Graph API) ────
exports.refreshGroupAnalytics = async (req, res) => {
    try {
        const pageStore = require('../services/pageStore');
        const [jobs, pages] = await Promise.all([
            groupJobStore.listHistory(),
            pageStore.load(),
        ]);

        // Map page name → access token
        const nameTokenMap = {};
        pages.forEach(p => { if (p.pageName && p.accessToken) nameTokenMap[p.pageName] = p.accessToken; });

        let updated = 0, errors = 0, skipped = 0;

        for (const job of jobs) {
            const results = job.results || [];
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status !== 'success' || !r.postUrl) { skipped++; continue; }
                // Skip if already has good analytics
                if (r.analytics && (r.analytics.likes || r.analytics.comments || r.analytics.shares || r.analytics.reach)) { skipped++; continue; }

                // Extract post ID from URL
                const m = r.postUrl.match(/\/posts\/(\d+)|story_fbid=(\d+)|\/permalink\/(\d+)/);
                const postId = m ? (m[1] || m[2] || m[3]) : null;
                if (!postId) { skipped++; continue; }

                // Get page access token (by job.postAsPage or job.pageName)
                const token = nameTokenMap[job.postAsPage] || nameTokenMap[job.pageName];
                if (!token) { skipped++; continue; }

                try {
                    const analytics = await refreshPostAnalytics(postId, token);
                    await groupJobStore.updateResultAnalytics(String(job._id), i, analytics);
                    updated++;
                } catch {
                    errors++;
                }
            }
        }

        res.json({ ok: true, updated, errors, skipped });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
};

exports.showGroupResult = async (req, res) => {
    const job = await groupJobStore.getById(req.params.id);
    if (!job) return res.status(404).send('ไม่พบรายการโพส');
    const results  = job.results || [];
    const enriched = {
        ...job,
        _id: String(job._id),
        successCount: results.filter(r => r.status === 'success').length,
        failCount:    results.filter(r => r.status === 'failed').length,
    };
    res.render('group-result', { job: enriched });
};

// ── Page Activity (page posts + group shares for one page) ─────
exports.showPageActivity = async (req, res) => {
    try {
        const pageId = decodeURIComponent(req.params.pageId);
        const pageStore = require('../services/pageStore');

        const [allPages, allPosts, allJobs] = await Promise.all([
            pageStore.load(),
            postStore.load(),
            groupJobStore.listHistory(),
        ]);

        const page = allPages.find(p => p.pageId === pageId);
        if (!page) return res.status(404).send('ไม่พบเพจ');

        // Page posts where this page was included
        const posts = allPosts
            .filter(p => (p.results || []).some(r => r.pageId === pageId))
            .map(p => ({
                ...p,
                pageResult: (p.results || []).find(r => r.pageId === pageId) || {},
            }));

        // Group jobs — match by pageId (web-created) OR postAsPage name (agent-created)
        const jobs = allJobs.filter(j => {
            if (j.pageId === pageId) return true;
            if (j.postAsPage && page.pageName && j.postAsPage === page.pageName) return true;
            if ((j.groups || []).some(g => g.pageId === pageId)) return true;
            return false;
        });
        console.log(`[showPageActivity] pageId=${pageId}, allJobs=${allJobs.length}, filtered=${jobs.length}`);
        if (jobs.length > 0 && jobs.length < 5) console.log(`[showPageActivity] jobs:`, jobs.map(j => ({ id: j._id, pageId: j.pageId, groups: j.groups })));
        
        const mappedJobs = jobs.map(j => ({
            ...j,
            _id: String(j._id),
            successCount: (j.results || []).filter(r => r.status === 'success').length,
            failCount:    (j.results || []).filter(r => r.status === 'failed').length,
            groupCount:   (j.groups  || []).length,
        }));

        const pageSuccess = posts.filter(p => p.pageResult.status === 'success').length;
        const pageFail    = posts.filter(p => p.pageResult.status !== 'success').length;
        const grpSuccess  = mappedJobs.reduce((s, j) => s + j.successCount, 0);
        const grpFail     = mappedJobs.reduce((s, j) => s + j.failCount,    0);

        res.render('page-activity', {
            page, posts, jobs: mappedJobs,
            pageSuccess, pageFail, grpSuccess, grpFail,
        });
    } catch (e) {
        res.status(500).send('เกิดข้อผิดพลาด: ' + e.message);
    }
};
