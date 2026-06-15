const fs         = require('fs');
const imgStore   = require('./agentImageStore');

let _store   = null;
let _bot     = null;
let _accounts = null;
let _emit    = null;
let _running = false;
let _timer   = null;

function init(store, bot, accounts, emit) {
    _store    = store;
    _bot      = bot;
    _accounts = accounts;
    _emit     = emit;
}

function isRunning() { return _running; }

function start() {
    if (_running) return;
    _running = true;
    log('▶ Runner เริ่มทำงาน');
    _emit?.('runner:status', { running: true });
    scheduleNext(1000);
}

function stop() {
    if (!_running) return;
    _running = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    log('⏹ Runner หยุดแล้ว');
    _emit?.('runner:status', { running: false });
}

function log(msg) {
    const ts = new Date().toLocaleTimeString('th-TH', { hour12:false });
    _emit?.('log', `[${ts}] ${msg}`);
}

function scheduleNext(delay=3000) {
    if (!_running) return;
    _timer = setTimeout(poll, delay);
}

async function poll() {
    if (!_running) return;
    try {
        const jobs = await _store.getPendingJobs();
        if (jobs.length) await processJob(jobs[0]);
    } catch(e) { log(`❌ Runner error: ${e.message}`); }
    scheduleNext();
}

async function processJob(job) {
    const id = job._id?.toString?.() ?? job._id;
    log(`📋 เริ่ม Job: "${job.message.slice(0,50)}..."`);
    log(`   ${job.groups.length} กลุ่ม · delay ${job.delaySeconds}s`);

    await _store.updateJob(id, { status:'running' });
    _emit?.('jobs:updated', { ...job, _id:id, status:'running' });

    // Determine which account to use
    const acc = job.accountId
        ? _accounts.get(job.accountId)
        : _accounts.getActive();

    if (!acc) {
        log('❌ ไม่มี account ที่ login อยู่ — หยุด Job');
        await _store.updateJob(id, { status:'failed', results: [] });
        _emit?.('jobs:updated', { ...job, _id:id, status:'failed' });
        return;
    }

    // Open ONE page and switch identity on it — reuse same page for all groups
    log(`ℹ️ postAsPage: ${job.postAsPage || '(ไม่ได้เลือก — โพสเป็น user)'}`);
    let sharedPage = null;
    let sharedPageId = null;
    if (job.postAsPage) {
        const result = await _bot.openSwitchedPage(acc.id, job.postAsPage, (m) => log(`   ${m}`));
        sharedPage   = result?.page   || null;
        sharedPageId = result?.pageId || null;
    }

    // Download images from Supabase / MongoDB to temp files
    let tempImagePaths = [];
    const rawImages = job.images || [];
    if (rawImages.length > 0) {
        log(`📥 โหลดรูปภาพ ${rawImages.length} รูป...`);
        for (const filename of rawImages) {
            if (!filename) continue;
            // Local video stored with localpath:: prefix (Supabase unavailable at upload time)
            if (filename.startsWith('localpath::')) {
                const actualPath = filename.slice('localpath::'.length);
                if (fs.existsSync(actualPath)) {
                    tempImagePaths.push(actualPath);
                } else {
                    log(`   ⚠️ ไม่พบไฟล์วิดีโอ — อาจถูกย้ายหรือลบแล้ว: ${require('path').basename(actualPath)}`);
                }
                continue;
            }
            // Already an absolute path on disk → use directly
            if (require('path').isAbsolute(filename) && fs.existsSync(filename)) {
                tempImagePaths.push(filename);
            } else {
                // Supabase URL or MongoDB filename → download to temp
                const tmpPath = await imgStore.downloadToTemp(filename);
                if (tmpPath) tempImagePaths.push(tmpPath);
                else log(`   ⚠️ โหลดรูปไม่ได้: ${filename}`);
            }
        }
        log(`   ✅ พร้อมแนบ ${tempImagePaths.length} รูป`);
    }

    const results = [];
    let ok = 0;

    for (let i=0; i<job.groups.length; i++) {
        if (!_running) break;
        const g = job.groups[i];
        log(`➡️ [${i+1}/${job.groups.length}] ${g.groupName}`);
        _emit?.('jobs:progress', { groupName:g.groupName, status:'posting', current:i+1, total:job.groups.length });

        const res = await _bot.postToGroup(acc.id, g.groupId, g.groupName, job.message, job.postAsPage||null, (m)=>log(`   ${m}`), sharedPage, sharedPageId, tempImagePaths);
        results.push({ groupId:g.groupId, groupName:g.groupName, status:res.ok?'success':'failed', error:res.error||null, timestamp:new Date().toISOString() });

        if (res.ok) { ok++; log(`   ✅ สำเร็จ`); _emit?.('jobs:progress', { groupName:g.groupName, status:'success' }); }
        else        { log(`   ❌ ${res.error}`); _emit?.('jobs:progress', { groupName:g.groupName, status:'failed', error:res.error }); }

        if (i < job.groups.length-1 && job.delaySeconds>0 && _running) {
            log(`   ⏳ รอ ${job.delaySeconds}s...`);
            await sleep(job.delaySeconds*1000);
        }
    }

    // Switch back to personal and close the shared page
    if (sharedPage) {
        await _bot.switchBackOnPage(sharedPage, (m) => log(`   ${m}`), job.postAsPage).catch(()=>{});
    }

    // Clean up temp image files
    for (const p of tempImagePaths) {
        try { if (p.startsWith(require('os').tmpdir())) fs.unlinkSync(p); } catch {}
    }

    const status = ok>0 ? 'done' : 'failed';
    await _store.updateJob(id, { status, results });
    _emit?.('jobs:updated', { ...job, _id:id, status, results });
    log(`✅ เสร็จ: ${ok}/${job.groups.length} สำเร็จ`);
    log('─────────────────────────────');
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { init, start, stop, isRunning };
