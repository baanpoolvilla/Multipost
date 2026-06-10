const jobStore    = require('./jobStore');
const facebookBot = require('./facebookBot');

let _running = false;
let _timer   = null;
let _emit    = null;

function isRunning() { return _running; }

function start(emit) {
    if (_running) return;
    _running = true;
    _emit    = emit;
    log('▶ Runner เริ่มทำงาน — ตรวจสอบ job ทุก 3 วินาที');
    scheduleNext(1000);
}

function stop() {
    if (!_running) return;
    _running = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    log('⏹ Runner หยุดแล้ว');
}

function log(msg) {
    const ts = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
    _emit?.('log', `[${ts}] ${msg}`);
}

function scheduleNext(delay = 3000) {
    if (!_running) return;
    _timer = setTimeout(poll, delay);
}

async function poll() {
    if (!_running) return;
    try {
        const jobs = await jobStore.getPendingJobs();
        if (jobs.length > 0) {
            await processJob(jobs[0]);
        }
    } catch (e) {
        log(`❌ Runner error: ${e.message}`);
    }
    scheduleNext();
}

async function processJob(job) {
    const id = job._id?.toString?.() ?? job._id;
    log(`📋 เริ่ม Job: "${job.message.slice(0, 50)}${job.message.length > 50 ? '...' : ''}"`);
    log(`   กลุ่มเป้าหมาย: ${job.groups.length} กลุ่ม`);

    await jobStore.updateJob(id, { status: 'running' });
    _emit?.('job-update', { ...job, _id: id, status: 'running' });

    const results = [];
    let successCount = 0;

    for (let i = 0; i < job.groups.length; i++) {
        if (!_running) {
            log('⚠️ Runner ถูกหยุด — Job ยังค้างอยู่');
            break;
        }

        const group = job.groups[i];
        log(`➡️ [${i + 1}/${job.groups.length}] โพสต์ → ${group.groupName}`);
        _emit?.('progress', { groupName: group.groupName, status: 'posting', current: i + 1, total: job.groups.length });

        const result = await facebookBot.postToGroup(
            group.groupId,
            group.groupName,
            job.message,
            (msg) => log(`   ${msg}`)
        );

        const entry = {
            groupId: group.groupId,
            groupName: group.groupName,
            status: result.ok ? 'success' : 'failed',
            error: result.error || null,
            timestamp: new Date().toISOString(),
        };
        results.push(entry);

        if (result.ok) {
            successCount++;
            log(`   ✅ สำเร็จ`);
            _emit?.('progress', { groupName: group.groupName, status: 'success' });
        } else {
            log(`   ❌ ล้มเหลว: ${result.error}`);
            _emit?.('progress', { groupName: group.groupName, status: 'failed', error: result.error });
        }

        // Delay between groups (skip after last)
        if (i < job.groups.length - 1 && job.delaySeconds > 0 && _running) {
            log(`   ⏳ รอ ${job.delaySeconds} วินาที...`);
            await sleep(job.delaySeconds * 1000);
        }
    }

    const finalStatus = successCount > 0 ? 'done' : 'failed';
    await jobStore.updateJob(id, { status: finalStatus, results });

    const updated = { ...job, _id: id, status: finalStatus, results };
    _emit?.('job-update', updated);
    log(`✅ Job เสร็จ: ${successCount}/${job.groups.length} กลุ่มสำเร็จ`);
    log('─────────────────────────────────────────');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, stop, isRunning };
