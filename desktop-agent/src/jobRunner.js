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

    // Switch to page identity ONCE before posting to all groups
    let identitySwitched = false;
    if (job.postAsPage) {
        identitySwitched = await _bot.switchIdentity(acc.id, job.postAsPage, (m) => log(`   ${m}`));
    }

    const results = [];
    let ok = 0;

    for (let i=0; i<job.groups.length; i++) {
        if (!_running) break;
        const g = job.groups[i];
        log(`➡️ [${i+1}/${job.groups.length}] ${g.groupName}`);
        _emit?.('jobs:progress', { groupName:g.groupName, status:'posting', current:i+1, total:job.groups.length });

        const res = await _bot.postToGroup(acc.id, g.groupId, g.groupName, job.message, job.postAsPage||null, (m)=>log(`   ${m}`));
        results.push({ groupId:g.groupId, groupName:g.groupName, status:res.ok?'success':'failed', error:res.error||null, timestamp:new Date().toISOString() });

        if (res.ok) { ok++; log(`   ✅ สำเร็จ`); _emit?.('jobs:progress', { groupName:g.groupName, status:'success' }); }
        else        { log(`   ❌ ${res.error}`); _emit?.('jobs:progress', { groupName:g.groupName, status:'failed', error:res.error }); }

        if (i < job.groups.length-1 && job.delaySeconds>0 && _running) {
            log(`   ⏳ รอ ${job.delaySeconds}s...`);
            await sleep(job.delaySeconds*1000);
        }
    }

    // Switch back to personal account after all groups done
    if (identitySwitched) {
        await _bot.switchIdentityBack(acc.id, (m) => log(`   ${m}`));
    }

    const status = ok>0 ? 'done' : 'failed';
    await _store.updateJob(id, { status, results });
    _emit?.('jobs:updated', { ...job, _id:id, status, results });
    log(`✅ เสร็จ: ${ok}/${job.groups.length} สำเร็จ`);
    log('─────────────────────────────');
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { init, start, stop, isRunning };
