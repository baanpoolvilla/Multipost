const fs   = require('fs');
const path = require('path');
const { sendToPages } = require('../services/facebookService');
const postStore = require('../services/postStore');
const pageStore = require('../services/pageStore');

// ── Dashboard ──────────────────────────────────
exports.showDashboard = (req, res) =>
    res.render('dashboard', {
        pages:       pageStore.load(),
        recentPosts: postStore.load().slice(0, 5),
    });

// ── Send post ──────────────────────────────────
exports.sendPost = async (req, res) => {
    const { message, feelingEmoji, feelingLabel, location } = req.body;
    const images = (req.files || []).map(f => f.filename);

    if (!message || !message.trim())
        return res.status(400).json({ error: 'กรุณากรอกข้อความ' });

    let pageIds = req.body.selectedPages;
    if (pageIds) pageIds = [].concat(pageIds);

    const feeling  = feelingEmoji ? { emoji: feelingEmoji, label: feelingLabel } : null;
    const results  = await sendToPages(message.trim(), pageIds || null);
    const successCount = results.filter(r => r.status === 'success').length;

    const post = postStore.create({
        message: message.trim(), feeling,
        location: location || null, images, results,
        successCount, failCount: results.length - successCount,
    });

    res.json({ id: post.id });
};

// ── Result / History / Overview ────────────────
exports.showResult = (req, res) => {
    const post = postStore.getById(req.params.id);
    if (!post) return res.redirect('/');
    res.render('result', { post });
};

exports.showHistory = (req, res) =>
    res.render('history', { posts: postStore.load() });

exports.deletePost = (req, res) => {
    const post = postStore.remove(req.params.id);
    if (post?.images) {
        post.images.forEach(img => {
            try { fs.unlinkSync(path.join(__dirname, '../public/uploads', img)); } catch {}
        });
    }
    res.json({ success: !!post });
};

exports.showOverview = (req, res) => {
    const posts = postStore.load();
    const allPages = pageStore.load();
    let totalLikes = 0, totalComments = 0, totalShares = 0, totalReach = 0, totalFollowersGained = 0;
    const pageStats = {};

    allPages.forEach(p => {
        pageStats[p.pageId] = { pageName: p.pageName, posts: 0, success: 0, likes: 0, comments: 0, shares: 0, reach: 0, followersGained: 0 };
    });

    posts.forEach(post => {
        post.results.forEach(r => {
            if (!pageStats[r.pageId])
                pageStats[r.pageId] = { pageName: r.pageName, posts: 0, success: 0, likes: 0, comments: 0, shares: 0, reach: 0, followersGained: 0 };
            pageStats[r.pageId].posts++;
            if (r.status === 'success') {
                pageStats[r.pageId].success++;
                if (r.analytics) {
                    const a = r.analytics;
                    pageStats[r.pageId].likes           += a.likes           || 0;
                    pageStats[r.pageId].comments        += a.comments        || 0;
                    pageStats[r.pageId].shares          += a.shares          || 0;
                    pageStats[r.pageId].reach           += a.reach           || 0;
                    pageStats[r.pageId].followersGained += a.followersGained || 0;
                    totalLikes     += a.likes           || 0;
                    totalComments  += a.comments        || 0;
                    totalShares    += a.shares          || 0;
                    totalReach     += a.reach           || 0;
                    totalFollowersGained += a.followersGained || 0;
                }
            }
        });
    });

    const byDay = {};
    posts.forEach(p => { const d = p.createdAt.slice(0,10); byDay[d] = (byDay[d]||0)+1; });
    const chartLabels = [], chartData = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0,10);
        chartLabels.push(key.slice(5)); chartData.push(byDay[key]||0);
    }

    res.render('overview', {
        totalPosts: posts.length, totalSuccess: posts.reduce((s,p)=>s+p.successCount,0),
        totalFail:  posts.reduce((s,p)=>s+p.failCount,0),
        totalLikes, totalComments, totalShares, totalReach, totalFollowersGained,
        pageStats: Object.values(pageStats), recentPosts: posts.slice(0,10),
        chartLabels: JSON.stringify(chartLabels), chartData: JSON.stringify(chartData),
    });
};

// ── Page management ────────────────────────────
exports.showPages = (req, res) =>
    res.render('pages', { pages: pageStore.load() });

exports.addPage = (req, res) => {
    const { pageId, pageName, accessToken, tokenExpiry } = req.body;
    if (!pageId || !pageName) return res.status(400).json({ error: 'กรุณากรอก Page ID และชื่อเพจ' });
    const result = pageStore.add({ pageId, pageName, accessToken: accessToken || '', tokenExpiry: tokenExpiry || null });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true, page: result.page });
};

exports.updatePage = (req, res) => {
    const updated = pageStore.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเพจ' });
    res.json({ ok: true, page: updated });
};

exports.deletePage = (req, res) => {
    const page = pageStore.remove(req.params.id);
    res.json({ success: !!page });
};
