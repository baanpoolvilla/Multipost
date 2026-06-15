const { sendToPages, fetchPagesFromToken, refreshPostAnalytics, fetchPageGroups } = require('../services/facebookService');
const imageStore    = require('../services/imageStore');
const postStore     = require('../services/postStore');
const pageStore     = require('../services/pageStore');
const settingsStore = require('../services/settingsStore');
const templateStore = require('../services/templateStore');
const groupJobStore = require('../services/groupJobStore');

// ── Dashboard ──────────────────────────────────
exports.showDashboard = async (req, res) => {
    const [allPages, posts] = await Promise.all([pageStore.load(), postStore.load()]);
    const pages         = allPages.filter(p => p.enabled !== false);
    const disabledPages = allPages.filter(p => p.enabled === false);
    res.render('dashboard', { pages, disabledPages, recentPosts: posts.slice(0, 5) });
};

// ── Send post ──────────────────────────────────
exports.sendPost = async (req, res) => {
    const { message, feelingEmoji, feelingLabel, location, scheduledAt, postDelay } = req.body;
    const uploadedImages = (req.files || []).map(f => f.filename);
    const tplRaw         = req.body.templateImages ? [].concat(req.body.templateImages) : [];
    const images         = [...uploadedImages, ...tplRaw];

    if (!message || !message.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อความ' });

    let pageIds = req.body.selectedPages;
    if (pageIds) pageIds = [].concat(pageIds);

    const feeling      = feelingEmoji ? { emoji: feelingEmoji, label: feelingLabel } : null;
    const delaySeconds = Math.min(Math.max(parseInt(postDelay) || 0, 0), 120);

    if (scheduledAt) {
        const schedDate = new Date(scheduledAt);
        if (schedDate > new Date()) {
            const post = await postStore.create({
                message: message.trim(), feeling,
                location: location || null, images,
                results: [], successCount: 0, failCount: 0,
                status: 'scheduled',
                scheduledAt: schedDate.toISOString(),
                selectedPageIds: pageIds || null,
            });
            return res.json({ id: post.id, scheduled: true, scheduledAt: post.scheduledAt });
        }
    }

    // Pre-flight: check that video files still exist (skip Supabase URLs — they're permanent)
    const videoImages = images.filter(f => /\.(mp4|mov|avi|webm)$/i.test(f) && !f.startsWith('http'));
    for (const vf of videoImages) {
        const ok = await imageStore.exists(vf);
        if (!ok) return res.status(400).json({
            error: `ไฟล์วิดีโอ "${vf.split('-').slice(2).join('-') || vf}" หมดอายุ\n` +
                   `Vercel เก็บไฟล์ชั่วคราวเท่านั้น — กรุณาอัปโหลดวิดีโอใหม่`,
        });
    }

    const results      = await sendToPages(message.trim(), pageIds || null, images, delaySeconds);
    const successCount = results.filter(r => r.status === 'success').length;

    const post = await postStore.create({
        message: message.trim(), feeling,
        location: location || null, images, results,
        successCount, failCount: results.length - successCount,
        status: 'done',
    });

    res.json({ id: post.id });
};

// ── Scheduled post runner (Vercel Cron) ────────
exports.runAllScheduled = async (req, res) => {
    try {
        const due = await postStore.getDueScheduled();
        let executed = 0;
        for (const post of due) {
            try {
                await postStore.updateOne(post.id, { status: 'running' });
                const pageIds  = post.selectedPageIds?.length ? post.selectedPageIds : null;
                const results  = await sendToPages(post.message, pageIds, post.images || []);
                const success  = results.filter(r => r.status === 'success').length;
                await postStore.updateOne(post.id, {
                    status: 'done', results,
                    successCount: success, failCount: results.length - success,
                });
                executed++;
            } catch (e) {
                console.error('[scheduler] error:', e.message);
                await postStore.updateOne(post.id, { status: 'failed' });
            }
        }
        res.json({ ok: true, executed });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
};

// ── Post status (for polling) ──────────────────
exports.getPostStatus = async (req, res) => {
    const post = await postStore.getById(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    res.json({
        id:           post.id,
        status:       post.status || 'done',
        successCount: post.successCount || 0,
        failCount:    post.failCount    || 0,
        total:        (post.results || []).length,
        scheduledAt:  post.scheduledAt || null,
    });
};

// ── Result / History ───────────────────────────
exports.showResult = async (req, res) => {
    const post = await postStore.getById(req.params.id);
    if (!post) return res.redirect('/');
    res.render('result', { post });
};

exports.showHistory = async (req, res) => {
    const posts = await postStore.load();
    res.render('history', { posts });
};

exports.deletePost = async (req, res) => {
    const post = await postStore.remove(req.params.id);
    if (post?.images) {
        for (const img of post.images) {
            if (!img.startsWith('http')) await imageStore.remove(img);
        }
    }
    res.json({ success: !!post });
};

// ── Helpers ────────────────────────────────────
const TZ = 'Asia/Bangkok';
function toThaiDate(isoStr) {
    return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

// ── Overview helpers ───────────────────────────
function computeStats(posts, allPages) {
    let totalLikes = 0, totalComments = 0, totalShares = 0, totalReach = 0;
    const pageStats = {};

    allPages.forEach(p => {
        pageStats[p.pageId] = { pageName: p.pageName, posts: 0, success: 0, likes: 0, comments: 0, shares: 0, reach: 0 };
    });

    posts.forEach(post => {
        post.results.forEach(r => {
            if (!pageStats[r.pageId])
                pageStats[r.pageId] = { pageName: r.pageName, posts: 0, success: 0, likes: 0, comments: 0, shares: 0, reach: 0 };
            pageStats[r.pageId].posts++;
            if (r.status === 'success') {
                pageStats[r.pageId].success++;
                if (r.analytics) {
                    const a = r.analytics;
                    pageStats[r.pageId].likes    += a.likes    || 0;
                    pageStats[r.pageId].comments += a.comments || 0;
                    pageStats[r.pageId].shares   += a.shares   || 0;
                    pageStats[r.pageId].reach    += a.reach    || 0;
                    totalLikes    += a.likes    || 0;
                    totalComments += a.comments || 0;
                    totalShares   += a.shares   || 0;
                    totalReach    += a.reach    || 0;
                }
            }
        });
    });

    const totalSuccess = posts.reduce((s, p) => s + p.successCount, 0);
    const totalFail    = posts.reduce((s, p) => s + p.failCount, 0);
    const totalResults = totalSuccess + totalFail;
    const successRate  = totalResults > 0 ? Math.round(totalSuccess / totalResults * 100) : 100;

    const byDay = {};
    posts.forEach(p => { const d = toThaiDate(p.createdAt); byDay[d] = (byDay[d] || 0) + 1; });
    const chartLabels = [], chartData = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString('en-CA', { timeZone: TZ });
        chartLabels.push(key.slice(5)); chartData.push(byDay[key] || 0);
    }

    return {
        totalPosts: posts.length,
        totalSuccess, totalFail, successRate,
        totalLikes, totalComments, totalShares, totalReach,
        pageStats: Object.values(pageStats),
        recentPosts: posts.slice(0, 10),
        chartLabels: JSON.stringify(chartLabels),
        chartData:   JSON.stringify(chartData),
    };
}

exports.showOverview = async (req, res) => {
    const [posts, pages] = await Promise.all([postStore.load(), pageStore.load()]);
    res.render('overview', computeStats(posts, pages));
};

exports.overviewStats = async (req, res) => {
    const [posts, pages] = await Promise.all([postStore.load(), pageStore.load()]);
    res.json(computeStats(posts, pages));
};

exports.reschedulePost = async (req, res) => {
    try {
        const { scheduledAt } = req.body;
        const schedDate = scheduledAt ? new Date(scheduledAt) : null;
        if (schedDate && isNaN(schedDate.getTime())) return res.status(400).json({ error: 'วันเวลาไม่ถูกต้อง' });
        const post = await postStore.updateOne(req.params.id, { scheduledAt: schedDate ? schedDate.toISOString() : null });
        if (!post) return res.status(404).json({ error: 'ไม่พบโพส' });
        res.json({ ok: true, scheduledAt: post.scheduledAt });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.refreshAnalytics = async (req, res) => {
    const [posts, pages] = await Promise.all([postStore.load(), pageStore.load()]);
    const tokenMap = Object.fromEntries(pages.map(p => [p.pageId, p.accessToken]));
    let updated = 0, errors = 0;

    for (const post of posts) {
        let changed = false;
        for (const result of post.results) {
            if (result.status !== 'success' || !result.fbPostId || result.type === 'group') continue;
            const token = tokenMap[result.pageId];
            if (!token) continue;
            try {
                const fresh = await refreshPostAnalytics(result.fbPostId, token);
                // keep existing non-zero values if fresh fetch returns 0 (insights take time)
                if (result.analytics) {
                    fresh.comments = fresh.comments || result.analytics.comments || 0;
                    fresh.reach    = fresh.reach    || result.analytics.reach    || 0;
                }
                result.analytics = fresh;
                changed = true;
            } catch (e) {
                console.error('[refreshAnalytics] error for', result.fbPostId, e.message);
                errors++;
            }
        }
        if (changed) updated++;
    }
    await postStore.saveAll(posts);
    res.json({ ok: true, updated, errors });
};

// ── Daily Summary ──────────────────────────────
exports.dailySummary = async (req, res) => {
    const posts    = await postStore.load();
    const today    = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    // Support date range: dateFrom/dateTo (new) or single date (legacy)
    const dateFrom = req.query.dateFrom || req.query.date || today;
    const dateTo   = req.query.dateTo   || req.query.date || dateFrom;
    const timeFrom = req.query.timeFrom || null; // HH:MM
    const timeTo   = req.query.timeTo   || null; // HH:MM

    const fromISO = timeFrom ? new Date(`${dateFrom}T${timeFrom}:00+07:00`) : new Date(`${dateFrom}T00:00:00+07:00`);
    const toISO   = timeTo   ? new Date(`${dateTo}T${timeTo}:59+07:00`)     : new Date(`${dateTo}T23:59:59+07:00`);

    const dayPosts = posts.filter(p => {
        const t = new Date(p.createdAt).getTime();
        return t >= fromISO.getTime() && t <= toISO.getTime();
    });
    let totalLikes = 0, totalComments = 0, totalShares = 0, totalReach = 0;

    dayPosts.forEach(p => {
        p.results.forEach(r => {
            if (r.status === 'success' && r.analytics) {
                totalLikes    += r.analytics.likes    || 0;
                totalComments += r.analytics.comments || 0;
                totalShares   += r.analytics.shares   || 0;
                totalReach    += r.analytics.reach    || 0;
            }
        });
    });

    const totalSuccess = dayPosts.reduce((s, p) => s + p.successCount, 0);
    const totalFail    = dayPosts.reduce((s, p) => s + p.failCount, 0);
    const total        = totalSuccess + totalFail;
    const successRate  = total > 0 ? Math.round(totalSuccess / total * 100) : 100;

    const pagesSet = new Set();
    dayPosts.forEach(p => p.results.forEach(r => pagesSet.add(r.pageName)));

    // Group share stats for the same period
    const grpStats = await groupJobStore.statsByDateRange(fromISO, toISO);

    res.json({
        date, timeFrom, timeTo,
        totalPosts: dayPosts.length,
        totalSuccess, totalFail, successRate,
        totalLikes, totalComments, totalShares, totalReach,
        pages: [...pagesSet],
        groupStats: grpStats,
        posts: dayPosts.map(p => ({
            message:      p.message.length > 50 ? p.message.slice(0, 50) : p.message,
            successCount: p.successCount,
            total:        p.results.length,
            createdAt:    p.createdAt,
        })),
    });
};

// ── Token exchange ─────────────────────────────
exports.exchangeToken = async (req, res) => {
    const { pageId } = req.body;
    const cfg       = await settingsStore.load();
    const appId     = cfg.fbAppId;
    const appSecret = cfg.fbAppSecret;

    if (!appId || !appSecret)
        return res.status(400).json({ error: 'กรุณาตั้งค่า App ID และ App Secret ในหน้าตั้งค่า' });

    const pages = await pageStore.load();
    const page  = pages.find(p => p.pageId === pageId);
    if (!page)             return res.status(404).json({ error: 'ไม่พบเพจ' });
    if (!page.accessToken) return res.status(400).json({ error: 'เพจนี้ไม่มี Access Token' });

    try {
        const exchUrl  = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(page.accessToken)}`;
        const exchData = await (await fetch(exchUrl)).json();
        if (exchData.error) throw new Error(exchData.error.message);

        const longToken  = exchData.access_token;
        const expiresIn  = exchData.expires_in;
        let finalToken   = longToken;
        let finalExpiry  = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

        try {
            const pgData = await (await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=access_token&access_token=${encodeURIComponent(longToken)}`)).json();
            if (!pgData.error && pgData.access_token) {
                finalToken  = pgData.access_token;
                finalExpiry = null;
            }
        } catch {}

        await pageStore.update(pageId, { accessToken: finalToken, tokenExpiry: finalExpiry });
        res.json({ ok: true, neverExpires: finalExpiry === null, expiryDate: finalExpiry });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ── Check tokens ───────────────────────────────
exports.checkTokens = async (req, res) => {
    const pages = await pageStore.load();
    const results = await Promise.all(pages.map(async p => {
        if (!p.accessToken) return { pageId: p.pageId, valid: false, error: 'ไม่มี Token' };
        try {
            const d = await (await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(p.accessToken)}`)).json();
            if (d.error) return { pageId: p.pageId, valid: false, error: d.error.message };
            return { pageId: p.pageId, valid: true };
        } catch (e) {
            return { pageId: p.pageId, valid: false, error: e.message };
        }
    }));
    res.json({ results });
};

// ── Settings ───────────────────────────────────
exports.getSettings = async (req, res) => {
    const s = await settingsStore.load();
    res.json({ fbAppId: s.fbAppId || '', fbAppSecret: s.fbAppSecret || '' });
};

exports.saveSettings = async (req, res) => {
    const { fbAppId, fbAppSecret, groupToken } = req.body;
    await settingsStore.save({ fbAppId: fbAppId || '', fbAppSecret: fbAppSecret || '', groupToken: groupToken || '' });
    res.json({ ok: true });
};

// ── Lookup token ───────────────────────────────
exports.lookupToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'กรุณาใส่ Token' });
    try {
        const data = await (await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`)).json();
        if (data.error) throw new Error(data.error.message);
        res.json({ id: data.id, name: data.name });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ── Import pages ───────────────────────────────
exports.importPagesFromToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'กรุณาใส่ Token' });
    try {
        const cfg   = await settingsStore.load();
        const pages = await fetchPagesFromToken(token, cfg.fbAppId, cfg.fbAppSecret);
        res.json({ pages });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ── Group management ───────────────────────────
exports.syncGroups = async (req, res) => {
    const { pageId } = req.params;
    const pages = await pageStore.load();
    const page  = pages.find(p => p.pageId === pageId);
    if (!page)             return res.status(404).json({ error: 'ไม่พบเพจ' });
    if (!page.accessToken) return res.status(400).json({ error: 'ไม่มี Token' });
    try {
        const result   = await fetchPageGroups(pageId, page.accessToken);
        const updated  = await pageStore.syncGroups(pageId, result.groups);
        res.json({ ok: true, groups: updated.groups || [], fromFacebook: result.groups.length, notSupported: result.notSupported });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.lookupGroup = async (req, res) => {
    const { pageId } = req.params;
    const { groupId } = req.query;
    if (!groupId) return res.json({ name: null });
    const pages = await pageStore.load();
    const page  = pages.find(p => p.pageId === pageId);
    if (!page?.accessToken) return res.json({ name: null });
    try {
        const FB_API = 'https://graph.facebook.com/v21.0';
        const r = await fetch(`${FB_API}/${groupId}?fields=name&access_token=${encodeURIComponent(page.accessToken)}`);
        const d = await r.json();
        if (d.name) return res.json({ name: d.name });
        return res.json({ name: null });
    } catch { return res.json({ name: null }); }
};

exports.addGroup = async (req, res) => {
    const { pageId } = req.params;
    const { groupId, groupName } = req.body;
    if (!groupId || !groupName) return res.status(400).json({ error: 'กรุณากรอก Group ID และชื่อกลุ่ม' });
    const result = await pageStore.addGroup(pageId, groupId, groupName);
    if (result?.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, groups: result?.groups || [] });
};

exports.removeGroup = async (req, res) => {
    const { pageId, groupId } = req.params;
    const result = await pageStore.removeGroup(pageId, groupId);
    res.json({ ok: true, groups: result?.groups || [] });
};

exports.toggleGroup = async (req, res) => {
    const { pageId, groupId } = req.params;
    const { enabled } = req.body;
    const result = await pageStore.toggleGroup(pageId, groupId, enabled);
    res.json({ ok: true, groups: result?.groups || [] });
};

// ── Page management ────────────────────────────
exports.showPages = async (req, res) => {
    const pages = await pageStore.load();
    res.render('pages', { pages });
};

exports.addPage = async (req, res) => {
    const { pageId, pageName, accessToken, tokenExpiry } = req.body;
    if (!pageId || !pageName) return res.status(400).json({ error: 'กรุณากรอก Page ID และชื่อเพจ' });
    const result = await pageStore.add({ pageId, pageName, accessToken: accessToken || '', tokenExpiry: tokenExpiry || null });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, page: result.page });
};

exports.updatePage = async (req, res) => {
    const updated = await pageStore.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเพจ' });
    res.json({ ok: true, page: updated });
};

exports.deletePage = async (req, res) => {
    const page = await pageStore.remove(req.params.id);
    res.json({ success: !!page });
};

// ── Templates ──────────────────────────────
exports.getTemplates = async (req, res) => {
    const templates = await templateStore.load();
    const { folder } = req.query;
    if (folder === '__folders__') {
        const folders = await templateStore.listFolders();
        return res.json({ folders });
    }
    const filtered = folder ? templates.filter(t => t.folder === folder) : templates;
    res.json(filtered);
};

exports.createTemplate = async (req, res) => {
    const { name, message, images, folder } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
    const template = await templateStore.create({
        name: name?.trim() || '', message: message.trim(),
        images: Array.isArray(images) ? images : [],
        folder: folder?.trim() || null,
    });
    res.json({ ok: true, template });
};

exports.updateTemplate = async (req, res) => {
    const { name, message, images, folder } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
    const updated = await templateStore.update(req.params.id, {
        name: name?.trim() || '', message: message.trim(),
        images: Array.isArray(images) ? images : [],
        folder: folder?.trim() || null,
    });
    if (!updated) return res.status(404).json({ error: 'ไม่พบ Template' });
    res.json({ ok: true, template: updated });
};

exports.deleteTemplate = async (req, res) => {
    const t = await templateStore.remove(req.params.id);
    res.json({ success: !!t });
};
