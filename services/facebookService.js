const fs       = require('fs');
const path     = require('path');
const pageStore = require('./pageStore');

const FB_API     = 'https://graph.facebook.com/v21.0';
const UPLOADS_DIR = process.env.VERCEL
    ? '/tmp/uploads'
    : path.join(__dirname, '../public/uploads');

const MIME_MAP = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };

async function uploadPhoto(targetId, accessToken, filename) {
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return null;   // skip missing files (Vercel /tmp cleanup)
    const buffer = fs.readFileSync(filePath);
    const ext    = path.extname(filename).slice(1).toLowerCase();
    const mime   = MIME_MAP[ext] || 'image/jpeg';

    const form = new FormData();
    form.append('source', new Blob([buffer], { type: mime }), filename);
    form.append('published', 'false');
    form.append('access_token', accessToken);

    const res  = await fetch(`${FB_API}/${targetId}/photos`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.id;
}

async function fbPost(pageId, accessToken, message, imageFiles) {
    const params = new URLSearchParams({ message, access_token: accessToken });

    if (imageFiles.length > 0) {
        const photoIds = [];
        for (const filename of imageFiles) {
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
    return data.id; // format: "pageId_postId"
}

async function sendToPages(message, pageIds = null, images = []) {
    const all   = await pageStore.load();
    const pages = pageIds ? all.filter(p => pageIds.includes(p.pageId)) : all;
    const results = [];

    for (const page of pages) {
        const timestamp = new Date().toISOString();
        try {
            if (!page.accessToken) throw new Error('ไม่มี Access Token สำหรับเพจนี้');
            const fbId = await fbPost(page.pageId, page.accessToken, message, images);
            const [pgId, pId] = fbId.split('_');
            const postUrl = `https://www.facebook.com/${pgId}/posts/${pId}`;
            results.push({
                timestamp, pageId: page.pageId, pageName: page.pageName,
                message, status: 'success', fbPostId: fbId, postUrl, analytics: null,
            });
        } catch (err) {
            results.push({
                timestamp, pageId: page.pageId, pageName: page.pageName,
                message, status: 'failed', error: err.message, analytics: null,
            });
        }
    }
    return results;
}

async function fetchPagesFromToken(accessToken) {
    // Try User Access Token first → returns all managed pages
    const url  = `${FB_API}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(accessToken)}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.error) return data.data || [];

    // Fallback: might be a Page Access Token → fetch the page itself
    if (data.error.code === 100 || data.error.code === 200) {
        const r2   = await fetch(`${FB_API}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`);
        const d2   = await r2.json();
        if (d2.error) throw new Error(d2.error.message);
        return [{ id: d2.id, name: d2.name, access_token: accessToken }];
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

async function sendToGroups(message, groupMap, images = []) {
    const results = [];
    for (const { groupId, groupName, pageId, accessToken } of groupMap) {
        const timestamp = new Date().toISOString();
        try {
            if (!accessToken) throw new Error('ไม่มี Access Token');
            const params = new URLSearchParams({ message, access_token: accessToken });
            if (images.length > 0) {
                const photoIds = [];
                for (const filename of images) {
                    try {
                        // Upload photo directly to the group (not the page) using user token
                        const id = await uploadPhoto(groupId, accessToken, filename);
                        if (id) photoIds.push(id);
                    } catch (e) {
                        console.warn('[sendToGroups] image skip:', filename, e.message);
                    }
                }
                if (photoIds.length > 0)
                    params.set('attached_media', JSON.stringify(photoIds.map(id => ({ media_fbid: id }))));
            }
            const res  = await fetch(`${FB_API}/${groupId}/feed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            results.push({
                timestamp, pageId, pageName: groupName, groupId, type: 'group',
                message, status: 'success', fbPostId: data.id,
                postUrl: `https://www.facebook.com/groups/${groupId}`,
                analytics: null,
            });
        } catch (err) {
            results.push({
                timestamp, pageId, pageName: groupName, groupId, type: 'group',
                message, status: 'failed', error: err.message, analytics: null,
            });
        }
    }
    return results;
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

module.exports = { sendToPages, sendToGroups, fetchPagesFromToken, refreshPostAnalytics, fetchPageGroups };
