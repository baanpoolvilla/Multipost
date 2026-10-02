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
let _warnedNoAccount = false;
let _busy = false; // a job, a Facebook deletion, or runWhenIdle() is using the browser

// Runs fn only if the browser isn't in use, and keeps the queue from starting
// a job until it finishes. Returns false if busy (caller retries later).
async function runWhenIdle(fn) {
    if (_busy) return false;
    _busy = true;
    try { await fn(); } finally { _busy = false; }
    return true;
}
const EXPIRE_SWEEP_INTERVAL_MS = 30 * 1000; // don't hit the DB on every 3s poll tick
const LOCK_RETRY_MS = 2000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000; // well under postingLock's LOCK_STALE_MS (5 min)
const POSTER_STARTUP_GRACE_MS = 2 * 60 * 60 * 1000;  // scheduled jobs overdue longer than this are expired
const POSTER_STARTUP_STALE_MS = 12 * 60 * 60 * 1000; // immediate jobs waiting longer than this are expired

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
        // Nothing of ours is in flight (fresh launch, or a stop that already
        // finished): anything still marked running/locked by this machine was
        // left behind by a close or crash — release it now instead of
        // waiting out the 5-minute stale-lock timeout.
        if (!_busy) {
            await postingLock.release(_agentId).catch(() => {});
            const recovered = await _store.recoverInterrupted?.(_agentId);
            if (recovered) log(`⚠️ พบงานที่ค้างจากการปิดโปรแกรมระหว่างโพส ${recovered} งาน — บันทึกเป็นล้มเหลว (ไม่โพสซ้ำอัตโนมัติ)`);
        }
        // Jobs missed while this machine was off are expired rather than
        // posted late. The always-on posting machine is only off for restarts
        // or outages, so it tolerates a short gap (a quick restart must not
        // expire the queue it is about to work through).
        const expired = _store.isPosterAgent?.()
            ? await _store.expireOverdueJobs(POSTER_STARTUP_GRACE_MS, { force: true, immediateStaleMs: POSTER_STARTUP_STALE_MS })
            : await _store.expireOverdueJobs(0);
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
            // Jobs another machine left "running" when it went offline.
            if (_store.isPosterAgent?.()) await _store.recoverInterrupted?.();
        }
        // Without a signed-in Facebook account every job would just fail, so
        // leave them queued (for this machine once signed in, or another one).
        if (!_accounts.getActive()) {
            if (!_warnedNoAccount) { log('⏸ ยังไม่มีบัญชี Facebook ที่เข้าสู่ระบบ — งานจะรอในคิวจนกว่าจะเข้าสู่ระบบ'); _warnedNoAccount = true; }
            scheduleNext();
            return;
        }
        _warnedNoAccount = false;
        if (_busy) { scheduleNext(); return; }
        _busy = true;
        try {
            const job = await _store.claimNextJob();
            if (job) await processJob(job);
            else {
                const del = await _store.claimNextFbDeletion?.();
                if (del) await processFbDeletion(del);
            }
        } finally { _busy = false; }
    } catch(e) { log(`❌ Runner error: ${e.message}`); }
    scheduleNext();
}

// Deletes the real Facebook posts of a job the user deleted from history.
// Goes through the same global posting lock as posting (one Facebook action
// at a time across all machines) and pauses between posts.
async function processFbDeletion(req) {
    const targets = req.targets || [];
    log(`🗑 ลบโพสบน Facebook: "${(req.message || '').slice(0, 40)}..." (${targets.filter(t => t.status === 'pending').length} โพสต์) · สั่งโดย ${req.requestedByName || 'ไม่ทราบ'}`);

    const acc = (req.accountId && _accounts.get(req.accountId)) || _accounts.getActive();
    if (!acc) {
        await _store.finishFbDeletion(req, targets, true);
        return;
    }

    log('🔒 รอคิว (global lock)...');
    while (!(await postingLock.acquire(_agentId))) {
        if (!_running) { await _store.finishFbDeletion(req, targets, true); return; }
        await sleep(LOCK_RETRY_MS);
    }
    log('🔓 ได้คิวแล้ว เริ่มลบโพสต์');
    const lockRenewTimer = setInterval(() => { postingLock.renew(_agentId).catch(() => {}); }, LOCK_RENEW_INTERVAL_MS);

    let interrupted = false;
    try {
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            if (t.status !== 'pending') continue;
            if (!_running) { interrupted = true; break; }
            log(`➡️ [${i + 1}/${targets.length}] ${t.groupName}`);
            const res = await _bot.deletePostByUrl(acc.id, t.postUrl, req.message, (m) => log(`   ${m}`));
            t.status = res.status;
            t.error  = res.error || null;
            if (res.status === 'deleted')      log('   ✅ ลบแล้ว');
            else if (res.status === 'gone')    log('   ✅ โพสนี้ไม่อยู่แล้ว');
            else                               log(`   ${res.status === 'skipped' ? '⏭️ ข้าม' : '❌'} ${res.error}`);
            await _store.updateFbDeletion(req._id, { targets });

            // Session expired: every remaining post would fail the same way.
            if (res.authRequired) {
                targets.forEach(x => { if (x.status === 'pending') { x.status = 'failed'; x.error = res.error; } });
                break;
            }
            if (_running && targets.slice(i + 1).some(x => x.status === 'pending')) {
                const s = 6 + Math.floor(Math.random() * 7);
                log(`   ⏳ รอ ${s}s...`);
                await sleep(s * 1000);
            }
        }
    } finally {
        clearInterval(lockRenewTimer);
        await postingLock.release(_agentId).catch(() => {});
    }

    await _store.finishFbDeletion(req, targets, interrupted);
    const c = s => targets.filter(t => t.status === s).length;
    if (interrupted) log(`⏸ หยุดกลางคัน — ลบไปแล้ว ${c('deleted') + c('gone')}/${targets.length} จะทำต่อเมื่อเปิด Agent อีกครั้ง`);
    else log(`✅ ลบโพสบน Facebook เสร็จ: ลบแล้ว ${c('deleted') + c('gone')} · ข้าม ${c('skipped')} · ไม่สำเร็จ ${c('failed')} จาก ${targets.length}`);
    log('─────────────────────────────');
}

async function processJob(job) {
    const id = job._id?.toString?.() ?? job._id;
    log(`📋 เริ่ม Job: "${job.message.slice(0,50)}..."`);
    log(`   ${job.groups.length} กลุ่ม · delay ${job.delaySeconds}s`);

    // Job was already atomically claimed as RUNNING via claimNextJob()
    _emit?.('jobs:updated', { ...job, _id:id, status: STATUS.RUNNING });

    // The job's own account if it exists on THIS machine — a job created on
    // another machine (or the web) carries an id this machine doesn't have,
    // so fall back to whoever is signed in here.
    const acc = (job.accountId && _accounts.get(job.accountId)) || _accounts.getActive();

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

    // A missing file (deleted after 30 days, or never stored) must not turn
    // into a post without the picture — fail the job so it gets re-sent.
    const wanted = rawImages.filter(Boolean).length;
    if (tempImagePaths.length < wanted) {
        const err = `โหลดรูป/วิดีโอได้ไม่ครบ (${tempImagePaths.length}/${wanted}) — ไฟล์อาจถูกลบเพราะเกิน 30 วัน กรุณาแนบใหม่แล้วสั่งอีกครั้ง · ไม่ได้โพส`;
        log(`⛔ ${err}`);
        for (const p of tempImagePaths) { try { if (p.startsWith(require('os').tmpdir())) fs.unlinkSync(p); } catch {} }
        const results = job.groups.map(g => ({ groupId:g.groupId, groupName:g.groupName, status:'failed', error:err, timestamp:new Date().toISOString(), postUrl:null }));
        await _store.updateJob(id, { status: STATUS.FAILED, results });
        _emit?.('jobs:updated', { ...job, _id:id, status: STATUS.FAILED, results });
        notifyOwner(id, 'finished');
        return;
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
    notifyOwner(id, 'started'); // owner's SmartBoss notice — not awaited

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
        let switchFailed = false;
        if (job.postAsPage) {
            const result = await _bot.openSwitchedPage(acc.id, job.postAsPage, (m) => log(`   ${m}`));
            if (result?.switched) {
                sharedPage   = result.page;
                sharedPageId = result.pageId || null;
            } else {
                // Never fall through and post as the personal profile when the
                // job asked for a Page — fail it so the owner can retry.
                switchFailed = true;
                await result?.page?.close().catch(() => {});
                const err = `สลับเป็นเพจ "${job.postAsPage}" ไม่ได้ — ไม่ได้โพส (เพื่อไม่ให้โพสผิดตัวตน)`;
                log(`⛔ ${err}`);
                for (const g of job.groups) results.push({ groupId:g.groupId, groupName:g.groupName, status:'failed', error:err, timestamp:new Date().toISOString(), postUrl:null });
            }
        }

        // The browser window can disappear mid-job (closed by hand on the
        // posting machine, or crashed). Reopen it and retry that group instead
        // of failing every remaining group — a few times at most per job.
        let reopened = 0;
        const MAX_REOPEN = 2;
        let retryingGroup = -1;

        for (let i=0; i<job.groups.length && !switchFailed; i++) {
            if (!_running) { interrupted = true; break; }
            const g = job.groups[i];
            log(`➡️ [${i+1}/${job.groups.length}] ${g.groupName}`);
            _emit?.('jobs:progress', { groupName:g.groupName, status:'posting', current:i+1, total:job.groups.length });

            const res = await _bot.postToGroup(acc.id, g.groupId, g.groupName, job.message, job.postAsPage||null, (m)=>log(`   ${m}`), sharedPage, sharedPageId, tempImagePaths);

            if (!res.ok && _bot.isClosedError?.(res.error) && retryingGroup !== i) {
                if (reopened >= MAX_REOPEN) {
                    const err = 'หน้าต่างโพสถูกปิดซ้ำหลายครั้ง — หยุดงาน (อย่าปิดหน้าต่าง Chromium บนเครื่องโพสหลักระหว่างโพส)';
                    log(`⛔ ${err}`);
                    for (const rest of job.groups.slice(i)) results.push({ groupId:rest.groupId, groupName:rest.groupName, status:'failed', error:err, timestamp:new Date().toISOString(), postUrl:null });
                    await _store.saveProgress?.(id, results);
                    break;
                }
                reopened++;
                log(`   ⚠️ หน้าต่างโพสถูกปิด — เปิดใหม่แล้วลองกลุ่มนี้อีกครั้ง (${reopened}/${MAX_REOPEN})`);
                if (job.postAsPage) {
                    await sharedPage?.close().catch(() => {});
                    const again = await _bot.openSwitchedPage(acc.id, job.postAsPage, (m) => log(`   ${m}`));
                    if (!again?.switched) {
                        await again?.page?.close().catch(() => {});
                        sharedPage = null;
                        const err = `เปิดหน้าต่างใหม่แล้วสลับเป็นเพจ "${job.postAsPage}" ไม่ได้ — หยุดงาน (เพื่อไม่ให้โพสผิดตัวตน)`;
                        log(`⛔ ${err}`);
                        for (const rest of job.groups.slice(i)) results.push({ groupId:rest.groupId, groupName:rest.groupName, status:'failed', error:err, timestamp:new Date().toISOString(), postUrl:null });
                        await _store.saveProgress?.(id, results);
                        break;
                    }
                    sharedPage   = again.page;
                    sharedPageId = again.pageId || null;
                }
                retryingGroup = i;
                i--;
                continue;
            }
            retryingGroup = -1;

            results.push({ groupId:g.groupId, groupName:g.groupName, status:res.ok?'success':'failed', error:res.error||null, timestamp:new Date().toISOString(), postUrl:res.postUrl||null });
            await _store.saveProgress?.(id, results);

            if (res.ok) { ok++; log(`   ✅ สำเร็จ`); _emit?.('jobs:progress', { groupName:g.groupName, status:'success' }); }
            else        { log(`   ❌ ${res.error}`); _emit?.('jobs:progress', { groupName:g.groupName, status:'failed', error:res.error }); }

            // Not signed in: every remaining group would fail the same way,
            // so record them with the reason and stop instead of grinding through.
            if (res.authRequired) {
                for (const rest of job.groups.slice(i + 1)) {
                    results.push({ groupId:rest.groupId, groupName:rest.groupName, status:'failed', error:res.error, timestamp:new Date().toISOString(), postUrl:null });
                }
                log(`⛔ หยุดงาน: ${res.error}`);
                // Session gone: stop claiming more jobs until someone signs in again.
                if (res.error.startsWith('Session หมดอายุ')) {
                    _accounts.updateStatus(acc.id, 'error');
                    _emit?.('accounts:updated');
                }
                break;
            }

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
    if (interrupted) {
        const attempted = new Set(results.map(r => String(r.groupId)));
        for (const g of job.groups) {
            if (!attempted.has(String(g.groupId))) results.push({ groupId:g.groupId, groupName:g.groupName, status:'failed', error:'ไม่ได้โพส — ระบบโพสถูกหยุดกลางคัน', timestamp:new Date().toISOString(), postUrl:null });
        }
    }
    const status = interrupted ? STATUS.FAILED : (ok>0 ? STATUS.SUCCESS : STATUS.FAILED);
    const pageData = sharedPageId ? { pageId: sharedPageId, pageName: job.postAsPage || null } : {};
    const saved = await _store.updateJob(id, { status, results, ...pageData });
    if (!saved) {
        log('⚠️ งานนี้ถูกลบออกจากคิวระหว่างที่กำลังโพส — กู้คืนเข้าประวัติให้อัตโนมัติ');
        await _store.restoreDeletedJob(job, { status, results, ...pageData })
            .catch(e => log(`❌ กู้คืนประวัติไม่สำเร็จ: ${e.message}`));
    }
    _emit?.('jobs:updated', { ...job, _id:id, status, results, ...pageData });
    notifyOwner(id, 'finished');
    if (interrupted) log(`⏸ ถูกหยุดกลางคัน: โพสสำเร็จ ${ok}/${job.groups.length} กลุ่ม — กลุ่มที่เหลือบันทึกว่า "ไม่ได้โพส"`);
    else log(`✅ เสร็จ: ${ok}/${job.groups.length} สำเร็จ`);
    log('─────────────────────────────');
}

// Tells the web (→ the job owner's SmartBoss bell) and logs what happened, so
// a notice that didn't go out is visible here instead of failing silently.
function notifyOwner(id, event) {
    if (!_store.notifyWeb) return;
    Promise.resolve(_store.notifyWeb(id, event)).then(r => {
        const what = event === 'started' ? 'เริ่มโพส' : 'โพสเสร็จ';
        if (r && r.ok && r.sent) log(`📨 แจ้ง SmartBoss ของเจ้าของงาน (${what}) แล้ว`);
        else if (r && r.ok) log(`📨 ไม่ได้แจ้ง SmartBoss (${what}): ${({ 'not-linked': 'บัญชีผู้สั่งยังไม่ผูก SmartBoss', 'no-owner': 'งานไม่มีผู้สั่ง', already: 'แจ้งไปแล้ว', disabled: 'ยังไม่ได้ตั้งค่า', 'smartboss-unreachable': 'ติดต่อ SmartBoss ไม่ได้' })[r.reason] || r.reason}`);
        else log(`⚠️ แจ้ง SmartBoss (${what}) ไม่สำเร็จ: ${(r && r.error) || 'ติดต่อเว็บ Multi Post ไม่ได้'} — เว็บจะส่งให้ภายหลัง`);
    }).catch(() => {});
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { init, start, stop, isRunning, runWhenIdle };
