// Tells the person who ordered a group-post job, in their SmartBoss bell,
// that it started / finished / could not be posted. Only the owner, only
// those three things — problems with the posting machine itself are shown
// on this site to everyone instead (public/js/group-notify.js).
//
// SmartBoss side: POST /api/webhooks/multipost/notify, authorised by a 60s
// token signed with the secret the SSO link already shares (SSO_SECRET here,
// SSO_MULTIPOST_SECRET there), iss "multipost" / aud "smartboss".
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connect } = require('./db');
const staffStore = require('./staffStore');

const SMARTBOSS_URL = (process.env.SMARTBOSS_URL || 'https://app.smartboss.in.th').replace(/\/+$/, '');
const EVENTS = ['started', 'finished'];
const MAX_TRIES = 3;

function label(message) {
    const m = String(message || '');
    const i = m.indexOf('|||');
    const text = i === -1 ? m : (m.slice(0, i).trim() || m.slice(i + 3).trim());
    return text.replace(/\s+/g, ' ').slice(0, 70);
}

function compose(job, event) {
    const total = (job.groups || []).length;
    const name = `"${label(job.message)}"`;
    const page = job.postAsPage ? ` · ในนาม ${job.postAsPage}` : '';
    if (event === 'started') {
        return { title: 'เริ่มโพสงานของคุณแล้ว', body: `${name} · ${total} กลุ่ม${page}` };
    }
    const results = job.results || [];
    const ok = results.filter(r => r.status === 'success').length;
    if (ok === 0) {
        const reason = (results.find(r => r.error) || {}).error;
        return { title: 'โพสไม่สำเร็จ — ไม่มีกลุ่มไหนโพสได้', body: `${name}${reason ? ` — ${reason}` : ''}` };
    }
    const failed = total - ok;
    return {
        title: `โพสเสร็จแล้ว ${ok}/${total} กลุ่ม`,
        body: `${name}${page}${failed > 0 ? ` · ไม่สำเร็จ ${failed} กลุ่ม` : ''}`,
    };
}

async function postToSmartboss(smartbossUserId, { title, body, key }) {
    const secret = process.env.SSO_SECRET;
    if (!secret) return false;
    const token = jwt.sign({ title, body, key }, secret, {
        algorithm: 'HS256', issuer: 'multipost', audience: 'smartboss',
        subject: String(smartbossUserId), expiresIn: 60, jwtid: crypto.randomUUID(),
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
        const r = await fetch(`${SMARTBOSS_URL}/api/webhooks/multipost/notify`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal,
        });
        return r.ok;
    } catch { return false; } finally { clearTimeout(timer); }
}

// Sends at most once per job per event (claimed atomically on the job row, so
// the posting machine's call and the web's fallback sweep can't both send).
async function send(jobId, event) {
    if (!EVENTS.includes(event) || !process.env.SSO_SECRET) return { sent: false, reason: 'disabled' };
    await connect();
    let _id;
    try { _id = new mongoose.Types.ObjectId(String(jobId)); } catch { return { sent: false, reason: 'bad-id' }; }
    const jobs = mongoose.connection.db.collection('groupjobs');
    const job = await jobs.findOne({ _id });
    if (!job || !job.staffId) return { sent: false, reason: 'no-owner' };
    if (event === 'finished' && !['success', 'failed'].includes(job.status)) return { sent: false, reason: 'not-finished' };

    const staff = await staffStore.findById(job.staffId);
    if (!staff || !staff.smartbossUserId) return { sent: false, reason: 'not-linked' };

    const flag = `sbNotified.${event}`;
    const tries = `sbNotified.${event}Tries`;
    // Give up after a few failed deliveries (SmartBoss down / not deployed yet)
    // rather than retrying on every status poll.
    if (((job.sbNotified || {})[`${event}Tries`] || 0) >= MAX_TRIES) return { sent: false, reason: 'gave-up' };
    const claim = await jobs.updateOne({ _id, [flag]: { $ne: true } }, { $set: { [flag]: true } });
    if (!claim.modifiedCount) return { sent: false, reason: 'already' };

    const ok = await postToSmartboss(staff.smartbossUserId, { ...compose(job, event), key: `${String(_id)}:${event}` });
    // Not delivered: release the claim so the next attempt (fallback sweep) can retry.
    if (!ok) await jobs.updateOne({ _id }, { $set: { [flag]: false }, $inc: { [tries]: 1 } }).catch(() => {});
    return { sent: ok, reason: ok ? null : 'smartboss-unreachable' };
}

module.exports = { send, compose, EVENTS };
