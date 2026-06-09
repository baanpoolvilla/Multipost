const fs   = require('fs');
const path = require('path');
const { sendToPages, fetchPagesFromToken, refreshPostAnalytics, fetchPageGroups } = require('../services/facebookService');
const postStore     = require('../services/postStore');
const pageStore     = require('../services/pageStore');
const settingsStore = require('../services/settingsStore');

// ── Dashboard ──────────────────────────────────
exports.showDashboard = async (req, res) => {
    const [pages, posts] = await Promise.all([pageStore.load(), postStore.load()]);
    res.render('dashboard', { pages, recentPosts: posts.slice(0, 5) });
};

// ── Send post ──────────────────────────────────
exports.sendPost = async (req, res) => {
    const { message, feelingEmoji, feelingLabel, location } = req.body;
    const images = (req.files || []).map(f => f.filename);

    if (!message || !message.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อความ' });

    let pageIds = req.body.selectedPages;
    if (pageIds) pageIds = [].concat(pageIds);

    const feeling  = feelingEmoji ? { emoji: feelingEmoji, label: feelingLabel } : null;
    const results  = await sendToPages(message.trim(), pageIds || null, images);
    const successCount = results.filter(r => r.status === 'success').length;

    const post = await postStore.create({
        message: message.trim(), feeling,
        location: location || null, images, results,
        successCount, failCount: results.length - successCount,
    });

    res.json({ id: post.id });
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
        const uploadsDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, '../public/uploads');
        post.images.forEach(img => {
            try { fs.unlinkSync(path.join(uploadsDir, img)); } catch {}
        });
    }
    res.json({ success: !!post });
};

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
    posts.forEach(p => { const d = p.createdAt.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; });
    const chartLabels = [], chartData = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
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

exports.refreshAnalytics = async (req, res) => {
    const [posts, pages] = await Promise.all([postStore.load(), pageStore.load()]);
    const tokenMap = Object.fromEntries(pages.map(p => [p.pageId, p.accessToken]));
    let updated = 0, errors = 0;

    for (const post of posts) {
        let changed = false;
        for (const result of post.results) {
            if (result.status !== 'success' || !result.fbPostId) continue;
            const token = tokenMap[result.pageId];
            if (!token) continue;
            try {
                result.analytics = await refreshPostAnalytics(result.fbPostId, token);
                changed = true;
            } catch { errors++; }
        }
        if (changed) updated++;
    }
    await postStore.saveAll(posts);
    res.json({ ok: true, updated, errors });
};

// ── Daily Summary ──────────────────────────────
exports.dailySummary = async (req, res) => {
    const posts = await postStore.load();
    const today = new Date().toISOString().slice(0, 10);
    const date  = req.query.date || today;

    const dayPosts = posts.filter(p => p.createdAt.slice(0, 10) === date);
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

    res.json({
        date, totalPosts: dayPosts.length,
        totalSuccess, totalFail, successRate,
        totalLikes, totalComments, totalShares, totalReach,
        pages: [...pagesSet],
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
    const { fbAppId, fbAppSecret } = req.body;
    await settingsStore.save({ fbAppId: fbAppId || '', fbAppSecret: fbAppSecret || '' });
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
        const pages = await fetchPagesFromToken(token);
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
        const fbGroups = await fetchPageGroups(pageId, page.accessToken);
        const updated  = await pageStore.syncGroups(pageId, fbGroups);
        res.json({ ok: true, groups: updated.groups || [], fromFacebook: fbGroups.length });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
