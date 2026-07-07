const fs          = require('fs');
const imgStore    = require('./agentImageStore');
const postingLock = require('./postingLock');
const { STATUS }  = require('./scheduler/statuses');

let _store   = null;
let _bot     = null;
let _accounts = null;
let _emit    = null;
let _agentId = null;
let _running = false;
let _timer   = null;
let _lastExpireSweep = 0;
const EXPIRE_SWEEP_INTERVAL_MS = 30 * 1000; // don't hit the DB on every 3s poll tick
const LOCK_RETRY_MS = 2000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000; // well under postingLock's LOCK_STALE_MS (5 min)

function init(store, bot, accounts, emit, agentId) {
    _store    = store;
    _bot      = bot;
    _accounts = accounts;
    _emit     = emit;
    _agentId  = agentId;
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

    // Download images from Supabase / MongoDB to temp files — no Facebook
    // interaction involved, so this happens before the posting lock below
    // rather than holding it for longer than necessary.
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

    // Global posting lock — every Agent machine shares the same Facebook
    // session, so even though this job was already safely claimed by this
    // machine alone (claimNextJob), we still wait our turn here before any
    // actual Facebook action, so no two machines are ever mid-post at once.
    log('🔒 รอคิวโพส (global lock)...');
    while (!(await postingLock.acquire(_agentId))) {
        if (!_running) {
            // Agent stopped while still waiting for the lock — this job was
            // already flipped to RUNNING by claimNextJob, and nothing past
            // this point will ever run to write a final status. Revert it to
            // PENDING so claimNextDueJob can pick it up again later, instead
            // of leaving it stuck at "running" forever.
            log('⏸ Runner หยุดระหว่างรอคิว — คืนสถานะงานเป็น "รอดำเนินการ"');
            await _store.updateJob(id, { status: STATUS.PENDING }).catch(() => {});
            _emit?.('jobs:updated', { ...job, _id:id, status: STATUS.PENDING });
            return;
        }
        await sleep(LOCK_RETRY_MS);
    }
    log('🔓 ได้คิวแล้ว เริ่มโพส');

    // Renew on a fixed timer, not once per group — a per-group renew still
    // goes stale if delaySeconds (user-configurable) or a single group's
    // post itself takes close to LOCK_STALE_MS, since nothing touches
    // lockedAt again until the NEXT group finishes. A timer keeps the lock
    // fresh regardless of how slow any individual step is.
    const lockRenewTimer = setInterval(() => { postingLock.renew(_agentId).catch(() => {}); }, LOCK_RENEW_INTERVAL_MS);

    const results = [];
    let ok = 0;
    let interrupted = false;
    let sharedPage = null;
    let sharedPageId = null;
    try {
        // Open ONE page and switch identity on it — reuse same page for all groups
        log(`ℹ️ postAsPage: ${job.postAsPage || '(ไม่ได้เลือก — โพสเป็น user)'}`);
        if (job.postAsPage) {
            const result = await _bot.openSwitchedPage(acc.id, job.postAsPage, (m) => log(`   ${m}`));
            sharedPage   = result?.page   || null;
            sharedPageId = result?.pageId || null;
        }

        for (let i=0; i<job.groups.length; i++) {
            if (!_running) { interrupted = true; break; }
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
    } finally {
        clearInterval(lockRenewTimer);
        await postingLock.release(_agentId).catch(() => {});
    }

    // Clean up temp image files
    for (const p of tempImagePaths) {
        try { if (p.startsWith(require('os').tmpdir())) fs.unlinkSync(p); } catch {}
    }

    // Stopped mid-loop means some groups were never even attempted — they're
    // simply missing from `results`, not recorded as failed. Reporting that
    // as SUCCESS (the normal "ok>0" rule) would hide that the job never
    // finished; force FAILED so it's visibly flagged for the admin instead
    // of silently looking complete. (Not reverted to PENDING and re-run
    // automatically: the groups already posted above would be posted again
    // on a full retry, since there's no per-group resume — a human decides.)
    const status = interrupted ? STATUS.FAILED : (ok>0 ? STATUS.SUCCESS : STATUS.FAILED);
    const pageData = sharedPageId ? { pageId: sharedPageId, pageName: job.postAsPage || null } : {};
    await _store.updateJob(id, { status, results, ...pageData });
    _emit?.('jobs:updated', { ...job, _id:id, status, results, ...pageData });
    if (interrupted) log(`⏸ ถูกหยุดกลางคัน: โพสไปแล้ว ${results.length}/${job.groups.length} กลุ่ม (สำเร็จ ${ok}) — เหลือ ${job.groups.length - results.length} กลุ่มที่ยังไม่ได้ทำ`);
    else log(`✅ เสร็จ: ${ok}/${job.groups.length} สำเร็จ`);
    log('─────────────────────────────');
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { init, start, stop, isRunning };
