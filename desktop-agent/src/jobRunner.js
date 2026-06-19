const fs         = require('fs');
const imgStore   = require('./agentImageStore');
const { STATUS } = require('./scheduler/statuses');

let _store   = null;
let _bot     = null;
let _accounts = null;
let _emit    = null;
let _running = false;
let _timer   = null;
let _lastExpireSweep = 0;
const EXPIRE_SWEEP_INTERVAL_MS = 30 * 1000; // don't hit the DB on every 3s poll tick

function init(store, bot, accounts, emit) {
    _store    = store;
    _bot      = bot;
    _accounts = accounts;
    _emit     = emit;
}

function isRunning() { return _running; }

async function start() {
    if (_running) return;
    _running = true;
    log('▶ Runner เริ่มทำงาน');
    _emit?.('runner:status', { running: true });

    // Part 9: catch up on expiry BEFORE the queue is ever polled, so a job
    // that became overdue while the Agent was offline is never posted late.
    // Use grace=0 at startup: any scheduled job past its time is expired
    // immediately (no leeway). Periodic sweeps use DEFAULT_GRACE_MS to let
    // sequential jobs survive while a previous job is being processed.
    try {
        await _store.migrateLegacyStatuses?.();
        const expired = await _store.expireOverdueJobs(0);
        if (expired) log(`⏱ พบงานหมดเวลา ${expired} รายการ — ย้ายไปสถานะ "หมดเวลา" (ไม่โพสอัตโนมัติ)`);
        _lastExpireSweep = Date.now();
    } catch (e) { log(`⚠️ ตรวจสอบงานหมดเวลาไม่สำเร็จ: ${e.message}`); }

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
        if (Date.now() - _lastExpireSweep > EXPIRE_SWEEP_INTERVAL_MS) {
            _lastExpireSweep = Date.now();
            const expired = await _store.expireOverdueJobs();
            if (expired) log(`⏱ พบงานหมดเวลา ${expired} รายการ — ย้ายไปสถานะ "หมดเวลา" (ไม่โพสอัตโนมัติ)`);
        }
        const job = await _store.claimNextJob();
        if (job) await processJob(job);
    } catch(e) { log(`❌ Runner error: ${e.message}`); }
    scheduleNext();
}

async function processJob(job) {
    const id = job._id?.toString?.() ?? job._id;
    log(`📋 เริ่ม Job: "${job.message.slice(0,50)}..."`);
    log(`   ${job.groups.length} กลุ่ม · delay ${job.delaySeconds}s`);

    // Job was already atomically claimed as RUNNING via claimNextJob()
    _emit?.('jobs:updated', { ...job, _id:id, status: STATUS.RUNNING });

    // Determine which account to use
    const acc = job.accountId
        ? _accounts.get(job.accountId)
        : _accounts.getActive();

    if (!acc) {
        log('❌ ไม่มี account ที่ login อยู่ — หยุด Job');
        await _store.updateJob(id, { status: STATUS.FAILED, results: [] });
        _emit?.('jobs:updated', { ...job, _id:id, status: STATUS.FAILED });
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
        results.push({ groupId:g.groupId, groupName:g.groupName, status:res.ok?'success':'failed', error:res.error||null, timestamp:new Date().toISOString(), postUrl:res.postUrl||null });

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

    const status = ok>0 ? STATUS.SUCCESS : STATUS.FAILED;
    const pageData = sharedPageId ? { pageId: sharedPageId, pageName: job.postAsPage || null } : {};
    await _store.updateJob(id, { status, results, ...pageData });
    _emit?.('jobs:updated', { ...job, _id:id, status, results, ...pageData });
    log(`✅ เสร็จ: ${ok}/${job.groups.length} สำเร็จ`);
    log('─────────────────────────────');
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { init, start, stop, isRunning };
