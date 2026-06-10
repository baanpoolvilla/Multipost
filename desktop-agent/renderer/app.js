// ── State ────────────────────────────────────────────────────
let _groups   = [];
let _jobs     = [];
let _running  = false;
let _loggedIn = false;

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    await checkLogin();
    await loadGroups();
    await refreshJobs();
    await syncRunnerStatus();
    registerPushEvents();
});

// ── Push events from main process ────────────────────────────
function registerPushEvents() {
    agent.onLog((msg) => appendLog(msg));

    agent.onJobUpdate((job) => {
        const idx = _jobs.findIndex(j => j._id === job._id);
        if (idx !== -1) _jobs[idx] = job;
        else _jobs.unshift(job);
        renderJobs();
    });

    agent.onProgress(({ groupName, status }) => {
        // Visual feedback can be added later; log is sufficient for now
    });
}

// ── Facebook Login ────────────────────────────────────────────
async function loginFacebook() {
    const email    = document.getElementById('fbEmail').value.trim();
    const password = document.getElementById('fbPassword').value;

    if (!email || !password) {
        alert('กรุณากรอก Email และ Password ก่อน');
        return;
    }

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.textContent = '⏳ กำลัง Login...';
    appendLog('[ℹ️] กำลัง Login Facebook อัตโนมัติ...');

    const result = await agent.loginFacebook(email, password);
    btn.disabled = false;
    btn.textContent = '🔑 Login อัตโนมัติ';

    if (result.ok) {
        setFBStatus(true);
        document.getElementById('fbPassword').value = '';
        appendLog('[✅] ' + result.message);
    } else {
        setFBStatus(false);
        appendLog('[❌] ' + (result.error || result.message || 'Login ไม่สำเร็จ'));
    }
}

async function checkLogin() {
    const { loggedIn } = await agent.checkLogin();
    setFBStatus(loggedIn);
}

function setFBStatus(loggedIn) {
    _loggedIn = loggedIn;
    const pill = document.getElementById('fbStatusPill');
    const hint = document.getElementById('loginHint');
    pill.className = 'status-pill ' + (loggedIn ? 'online' : 'offline');
    pill.innerHTML = `<span class="dot"></span> Facebook: ${loggedIn ? 'Login แล้ว ✓' : 'ยังไม่ Login'}`;
    hint.textContent = loggedIn
        ? 'Login สำเร็จแล้ว พร้อมโพสต์'
        : 'กด "เปิด Browser" เพื่อ Login Facebook';
}

// ── Recent Posts ──────────────────────────────────────────────
let _selectedPostIdx = -1;

async function loadRecentPosts() {
    const el = document.getElementById('recentPostsList');
    el.innerHTML = '<div class="loading">กำลังโหลด...</div>';
    const posts = await agent.getRecentPosts();
    if (!posts.length) {
        el.innerHTML = '<div class="empty-list">ยังไม่มีโพสต์ในประวัติ</div>';
        return;
    }
    el.innerHTML = posts.map((p, i) => {
        const msg  = p.message.length > 60 ? p.message.slice(0, 60) + '...' : p.message;
        const date = fmtDate(p.createdAt);
        const urls = p.postUrls.length ? `· ${p.postUrls.length} URL` : '';
        return `
          <div class="recent-post-item" id="rpi_${i}" onclick="selectPost(${i})">
            <div class="recent-post-msg">${escHtml(msg)}</div>
            <div class="recent-post-meta">✓ ${p.successCount} เพจ ${urls} · ${date}</div>
          </div>`;
    }).join('');
    el.dataset.posts = JSON.stringify(posts);
}

function selectPost(i) {
    const posts = JSON.parse(document.getElementById('recentPostsList').dataset.posts || '[]');
    const post  = posts[i];
    if (!post) return;

    // Highlight selected
    document.querySelectorAll('.recent-post-item').forEach(el => el.classList.remove('selected'));
    document.getElementById(`rpi_${i}`)?.classList.add('selected');
    _selectedPostIdx = i;

    // Fill message with post content + first URL if any
    let msg = post.message;
    if (post.postUrls.length) msg += '\n\n' + post.postUrls[0];
    document.getElementById('jobMessage').value = msg;
}

// ── Groups ────────────────────────────────────────────────────
async function loadGroups() {
    document.getElementById('groupList').innerHTML = '<div class="loading">กำลังโหลดกลุ่ม...</div>';
    _groups = await agent.getGroups();
    renderGroups();
}

function renderGroups() {
    const el = document.getElementById('groupList');
    if (!_groups.length) {
        el.innerHTML = '<div class="empty-list">ไม่มีกลุ่ม — เพิ่มกลุ่มใน "จัดการเพจ" บนเว็บก่อน</div>';
        document.getElementById('selectedCount').style.display = 'none';
        return;
    }
    el.innerHTML = _groups.map((g, i) => `
      <div class="group-item" onclick="toggleGroup(${i})">
        <input type="checkbox" id="grp_${i}" checked>
        <label for="grp_${i}">${escHtml(g.groupName)}</label>
      </div>
    `).join('');
    updateSelectedCount();
    document.getElementById('selectedCount').style.display = '';
}

function toggleGroup(i) {
    const cb = document.getElementById(`grp_${i}`);
    cb.checked = !cb.checked;
    updateSelectedCount();
}

function updateSelectedCount() {
    const n = document.querySelectorAll('.group-list input[type="checkbox"]:checked').length;
    document.getElementById('selectedNum').textContent = n;
}

function selectAllGroups()  {
    document.querySelectorAll('.group-list input[type="checkbox"]').forEach(c => c.checked = true);
    updateSelectedCount();
}
function deselectAllGroups() {
    document.querySelectorAll('.group-list input[type="checkbox"]').forEach(c => c.checked = false);
    updateSelectedCount();
}

function getSelectedGroups() {
    return _groups.filter((_, i) => {
        const cb = document.getElementById(`grp_${i}`);
        return cb && cb.checked;
    });
}

// ── Create Job ────────────────────────────────────────────────
async function createJob() {
    const message = document.getElementById('jobMessage').value.trim();
    if (!message) { alert('กรุณากรอกข้อความ'); return; }

    const groups = getSelectedGroups();
    if (!groups.length) { alert('กรุณาเลือกอย่างน้อย 1 กลุ่ม'); return; }

    const delay = parseInt(document.getElementById('jobDelay').value, 10) || 5;

    const job = await agent.createJob({ message, groups, delaySeconds: delay });
    if (job) {
        _jobs.unshift(job);
        renderJobs();
        document.getElementById('jobMessage').value = '';
        appendLog(`[📋] สร้าง Job ใหม่: "${message.slice(0, 40)}..." → ${groups.length} กลุ่ม`);
    }
}

// ── Jobs list ─────────────────────────────────────────────────
async function refreshJobs() {
    _jobs = await agent.getJobs();
    renderJobs();
}

function renderJobs() {
    const el = document.getElementById('jobsList');
    document.getElementById('jobCountBadge').textContent = _jobs.length;

    if (!_jobs.length) {
        el.innerHTML = '<div class="empty-state">ยังไม่มี Job</div>';
        return;
    }

    el.innerHTML = _jobs.map(j => {
        const icon  = { pending: '⏳', running: '🔄', done: '✅', failed: '❌' }[j.status] || '❓';
        const total = j.groups?.length || 0;
        const ok    = (j.results || []).filter(r => r.status === 'success').length;
        const meta  = j.status === 'done' || j.status === 'failed'
            ? `${ok}/${total} กลุ่มสำเร็จ`
            : `${total} กลุ่ม · หน่วง ${j.delaySeconds}s`;
        return `
          <div class="job-item">
            <div class="job-status-icon">${icon}</div>
            <div class="job-body">
              <div class="job-msg">${escHtml(j.message)}</div>
              <div class="job-meta">
                ${meta}
                &nbsp;·&nbsp;
                ${fmtDate(j.createdAt)}
              </div>
            </div>
            <span class="job-status ${j.status}">${statusTH(j.status)}</span>
            <button class="job-delete" title="ลบ" onclick="deleteJob('${j._id}')">🗑</button>
          </div>
        `;
    }).join('');
}

async function deleteJob(id) {
    await agent.deleteJob(id);
    _jobs = _jobs.filter(j => j._id !== id);
    renderJobs();
    appendLog(`[🗑] ลบ Job ${id}`);
}

// ── Runner ────────────────────────────────────────────────────
async function startRunner() {
    if (!_loggedIn) {
        alert('กรุณา Login Facebook ก่อนเริ่ม Runner');
        return;
    }
    await agent.startRunner();
    setRunnerStatus(true);
}

async function stopRunner() {
    await agent.stopRunner();
    setRunnerStatus(false);
}

async function syncRunnerStatus() {
    const { running } = await agent.runnerStatus();
    setRunnerStatus(running);
}

function setRunnerStatus(running) {
    _running = running;
    document.getElementById('btnStart').disabled = running;
    document.getElementById('btnStop').disabled  = !running;
    const pill = document.getElementById('runnerStatusPill');
    pill.className = 'status-pill ' + (running ? 'online' : 'offline');
    pill.innerHTML = `<span class="dot"></span> Runner: ${running ? 'กำลังทำงาน' : 'หยุด'}`;
}

// ── Log ───────────────────────────────────────────────────────
function appendLog(msg) {
    const el  = document.getElementById('logOutput');
    const line = document.createElement('span');
    line.className = 'log-line';

    if (msg.includes('✅') || msg.includes('สำเร็จ')) line.classList.add('log-ok');
    else if (msg.includes('❌') || msg.includes('ล้มเหลว') || msg.includes('error')) line.classList.add('log-err');
    else if (msg.includes('ℹ️') || msg.includes('📋') || msg.includes('🔄')) line.classList.add('log-info');

    line.textContent = msg;
    el.appendChild(line);
    el.appendChild(document.createTextNode('\n'));
    el.scrollTop = el.scrollHeight;
}

function clearLog() {
    document.getElementById('logOutput').innerHTML = '';
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false, dateStyle: 'short', timeStyle: 'short' }); }
    catch { return iso; }
}

function statusTH(s) {
    return { pending: 'รอ', running: 'กำลังทำ', done: 'สำเร็จ', failed: 'ล้มเหลว' }[s] || s;
}
