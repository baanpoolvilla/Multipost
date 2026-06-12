const pageStore  = require('./pageStore');
const imageStore = require('./imageStore');

const FB_API = 'https://graph.facebook.com/v21.0';

function isVideoFile(filename) {
    return /\.(mp4|mov|avi|webm|gif)$/i.test(filename);
}

async function uploadPhoto(targetId, accessToken, filename) {
    const result = await imageStore.getBuffer(filename);
    if (!result) return null;

    const form = new FormData();
    form.append('source', new Blob([result.buffer], { type: result.contentType }), filename);
    form.append('published', 'false');
    form.append('access_token', accessToken);

    const res  = await fetch(`${FB_API}/${targetId}/photos`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.id;
}

async function uploadVideo(pageId, accessToken, message, filename) {
    const result = await imageStore.getBuffer(filename);
    if (!result) throw new Error(`ไม่พบไฟล์วิดีโอ: ${filename}`);

    const form = new FormData();
    form.append('source', new Blob([result.buffer], { type: result.contentType }), filename);
    form.append('description', message);
    form.append('access_token', accessToken);

    const res  = await fetch(`${FB_API}/${pageId}/videos`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.id;
}

async function fbPost(pageId, accessToken, message, mediaFiles) {
    const videoFiles = mediaFiles.filter(f => isVideoFile(f));
    const photoFiles = mediaFiles.filter(f => !isVideoFile(f));

    // Video/GIF post → use /videos endpoint (first video; Facebook doesn't support multi-video in one post)
    if (videoFiles.length > 0) {
        const videoId = await uploadVideo(pageId, accessToken, message, videoFiles[0]);
        return {
            fbPostId: `${pageId}_${videoId}`,
            postUrl:  `https://www.facebook.com/${pageId}/videos/${videoId}`,
        };
    }

    // Photo post → use /feed with attached_media
    const params = new URLSearchParams({ message, access_token: accessToken });
    if (photoFiles.length > 0) {
        const photoIds = [];
        for (const filename of photoFiles) {
            try {
                const id = await uploadPhoto(pageId, accessToken, filename);
                if (id) photoIds.push(id);
            } catch (e) {
                console.warn('[fbPost] image skip:', filename, e.message);
            }
        }
        if (photoIds.length > 0)
            params.set('attached_media', JSON.stringify(photoIds.map(id => ({ media_fbid: id }))));
    }

    const res = await fetch(`${FB_API}/${pageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const [pgId, pId] = data.id.split('_');
    return {
        fbPostId: data.id,
        postUrl:  `https://www.facebook.com/${pgId}/posts/${pId}`,
    };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendToPages(message, pageIds = null, images = [], delaySeconds = 0) {
    const all   = await pageStore.load();
    const pages = pageIds
        ? all.filter(p => pageIds.includes(p.pageId))
        : all.filter(p => p.enabled !== false);
    const results = [];

    for (let i = 0; i < pages.length; i++) {
        const page      = pages[i];
        const timestamp = new Date().toISOString();
        try {
            if (!page.accessToken) throw new Error('ไม่มี Access Token สำหรับเพจนี้');
            const { fbPostId, postUrl } = await fbPost(page.pageId, page.accessToken, message, images);
            results.push({
                timestamp, pageId: page.pageId, pageName: page.pageName,
                message, status: 'success', fbPostId, postUrl, analytics: null,
            });
        } catch (err) {
            results.push({
                timestamp, pageId: page.pageId, pageName: page.pageName,
                message, status: 'failed', error: err.message, analytics: null,
            });
        }
        if (i < pages.length - 1 && delaySeconds > 0) {
            await sleep(delaySeconds * 1000);
        }
    }
    return results;
}

async function fetchPagesFromToken(accessToken, appId, appSecret) {
    // If App credentials available, exchange user token → long-lived first.
    // This makes the returned Page Access Tokens PERMANENT (never expire).
    let tokenToUse = accessToken;
    if (appId && appSecret) {
        try {
            const exchUrl  = `${FB_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(accessToken)}`;
            const exchData = await (await fetch(exchUrl)).json();
            if (!exchData.error && exchData.access_token) tokenToUse = exchData.access_token;
        } catch {}
    }

    // Try User Access Token first → returns all managed pages
    const url  = `${FB_API}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(tokenToUse)}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.error) return data.data || [];

    // Fallback: might be a Page Access Token → fetch the page itself
    if (data.error.code === 100 || data.error.code === 200) {
        const r2   = await fetch(`${FB_API}/me?fields=id,name&access_token=${encodeURIComponent(tokenToUse)}`);
        const d2   = await r2.json();
        if (d2.error) throw new Error(d2.error.message);
        return [{ id: d2.id, name: d2.name, access_token: tokenToUse }];
    }

    throw new Error(data.error.message);
}

async function refreshPostAnalytics(fbPostId, accessToken) {
    // Basic metrics — no special permissions needed
    const baseUrl = `${FB_API}/${fbPostId}?fields=likes.summary(true),comments.summary(true),shares&access_token=${encodeURIComponent(accessToken)}`;
    const baseRes = await fetch(baseUrl);
    const base    = await baseRes.json();
    if (base.error) throw new Error(base.error.message);

    // Reach — try multiple metrics, use first non-zero value
    let reach = 0;
    const reachMetrics = ['post_impressions_unique', 'post_impressions', 'post_impressions_organic_unique', 'post_impressions_organic'];
    for (const metric of reachMetrics) {
        if (reach > 0) break;
        try {
            const r = await fetch(`${FB_API}/${fbPostId}/insights?metric=${metric}&period=lifetime&access_token=${encodeURIComponent(accessToken)}`);
            const d = await r.json();
            if (d.error) {
                console.log(`[Analytics] ${metric} error:`, d.error.code, d.error.message);
                continue;
            }
            const val = d.data?.[0]?.values?.[0]?.value ?? d.data?.[0]?.values?.at(-1)?.value;
            if (typeof val === 'number' && val > 0) reach = val;
        } catch (e) { console.log(`[Analytics] ${metric} fetch error:`, e.message); }
    }

    return {
        likes:    base.likes?.summary?.total_count    || 0,
        comments: base.comments?.summary?.total_count || 0,
        shares:   base.shares?.count                  || 0,
        reach,
    };
}

async function fetchPageGroups(pageId, accessToken) {
    // Try /me/groups with the page token (works if token has groups_access_member_info)
    const url  = `${FB_API}/me/groups?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
    const res  = await fetch(url);
    const data = await res.json();
    // error code 100 or 200 = permission not available → return empty gracefully
    if (data.error) {
        if (data.error.code === 100 || data.error.code === 200 || data.error.code === 10) {
            return { groups: [], notSupported: true };
        }
        throw new Error(data.error.message);
    }
    return { groups: (data.data || []).map(g => ({ groupId: g.id, groupName: g.name })), notSupported: false };
}

module.exports = { sendToPages, fetchPagesFromToken, refreshPostAnalytics, fetchPageGroups };
