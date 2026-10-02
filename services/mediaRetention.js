// Deletes photos/videos older than RETENTION_DAYS that nothing still needs,
// so they stop filling the database (and cloud storage when it is set up).
// Run once a day (Vercel Cron → GET /api/cron/cleanup-media).
//
// Kept no matter how old: files used by a template (group or page), by a
// group job that hasn't run yet, or by a scheduled page post. A file's age
// comes from its name — every upload is named "<Date.now()>-<random>.<ext>";
// anything not named that way is left alone.
const mongoose = require('mongoose');
const { connect } = require('./db');

const RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS, 10) || 30;

function uploadedAt(ref) {
    const name = String(ref || '').split('?')[0].split('/').pop();
    const m = name.match(/^(\d{13})-/);
    return m ? Number(m[1]) : null;
}
const baseName = ref => decodeURIComponent(String(ref || '').split('?')[0].split('/').pop());

async function inUse(db) {
    const keep = new Set();
    const add = list => (list || []).forEach(r => { if (r) { keep.add(String(r)); keep.add(baseName(r)); } });
    const scan = async (col, filter) => {
        const docs = await db.collection(col).find(filter, { projection: { images: 1 } }).toArray().catch(() => []);
        docs.forEach(d => add(d.images));
    };
    await scan('agenttemplates', {});
    await scan('templates', {});
    await scan('groupjobs', { status: { $in: ['pending', 'running'] } });
    await scan('posts', { status: { $in: ['pending', 'scheduled'] } });
    return keep;
}

async function run({ dryRun = false } = {}) {
    await connect();
    const db = mongoose.connection.db;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const keep = await inUse(db);
    const old = ref => { const t = uploadedAt(ref); return t !== null && t < cutoff; };
    const removable = ref => old(ref) && !keep.has(String(ref)) && !keep.has(baseName(ref));
    const summary = { retentionDays: RETENTION_DAYS, dbFiles: 0, indexed: 0, cloudFiles: 0, kept: keep.size, dryRun };

    // 1. Files stored in the database (the fallback used while cloud storage is down).
    const dbIds = (await db.collection('images').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).filter(removable);
    summary.dbFiles = dbIds.length;
    if (!dryRun && dbIds.length) await db.collection('images').deleteMany({ _id: { $in: dbIds } });

    // 2. Cloud storage (Supabase) — only when it is configured and reachable.
    let supa = null;
    try { if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) supa = require('./supabaseStore'); } catch {}
    const idx = await db.collection('mediaindex').find({}, { projection: { _id: 1, url: 1 } }).toArray().catch(() => []);
    const idxGone = idx.filter(d => removable(d._id));
    summary.indexed = idxGone.length;
    if (!dryRun && idxGone.length) {
        if (supa) for (const d of idxGone) await supa.remove(d.url || d._id).catch(() => {});
        await db.collection('mediaindex').deleteMany({ _id: { $in: idxGone.map(d => d._id) } });
    }
    // Files uploaded straight from the browser aren't indexed — list the bucket.
    if (supa) {
        try {
            const names = await supa.listNames();
            const gone = names.filter(removable);
            summary.cloudFiles = gone.length;
            if (!dryRun) for (let i = 0; i < gone.length; i += 100) await supa.removeMany(gone.slice(i, i + 100));
        } catch (e) { summary.cloudError = e.message; }
    }
    return summary;
}

module.exports = { run, uploadedAt, RETENTION_DAYS };
