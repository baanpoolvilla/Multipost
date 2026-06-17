// ── State ────────────────────────────────────────────────────
const _timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
let _accounts = [], _groups = [], _selected = [], _jobs = [], _jobFilter = 'all', _jobsVisible = 20;
let _history = [], _historyFilter = 'all', _historyLoaded = false;
let _webUrl = agent.webUrl || localStorage.getItem('_webUrl') || '';
let _catCollapsed = {}; // category → true (collapsed) / false (expanded)
let _statusInterval = null;
let _selectedPage = null;
let _recentLoaded = false;
let _selectedImages = [];   // array of { path (Supabase URL or fs path), url (preview), name, uploading? }
async function _uploadFileToSupabase(file) {
    // Electron exposes file.path (OS path) — let main process read & upload directly
    if (!file.path) throw new Error('ไม่พบ path ของไฟล์ — กรุณาลองใหม่');
    return await agent.uploadFile(file.path, file.type || 'application/octet-stream');
}

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    setupPushEvents();
    // Run each init step independently — a hanging IPC must not block the others
    try { await Promise.race([refreshStatus(), _timeout(4000)]); } catch {}
    try { await Promise.race([loadAccounts(),  _timeout(5000)]); } catch {}
    try { await Promise.race([loadJobs(),      _timeout(5000)]); } catch {}
    try { loadGroups(); } catch {}
    _statusInterval = setInterval(() => { refreshStatus().catch(()=>{}); }, 5000);
    checkScheduledNotifications();
    checkExpiredJobsBanner();

    let _jobRefreshing = false;
    setInterval(async () => {
        if (_jobRefreshing) return;
        _jobRefreshing = true;
        try {
            const fresh = await agent.listJobs();
            const freshIds = new Set(fresh.map(j => j._id));
            let changed = false;
            // Update/add jobs from server
            fresh.forEach(j => {
                const i = _jobs.findIndex(x => x._id === j._id);
                if (i !== -1) { if (_jobs[i].status !== j.status) { _jobs[i] = j; changed = true; } }
                else { _jobs.unshift(j); changed = true; }
            });
            // Remove pending/running jobs that left the server; keep terminal-state jobs visible
            const TERMINAL = ['success', 'failed', 'expired', 'cancelled'];
            const before = _jobs.length;
            _jobs = _jobs.filter(j => TERMINAL.includes(j.status) || freshIds.has(j._id));
            if (_jobs.length !== before) changed = true;
            if (changed) renderJobs();
        } catch {} finally { _jobRefreshing = false; }
    }, 8000);

    let _grpRefreshing = false;
    setInterval(async () => {
        if (_grpRefreshing) return;
        _grpRefreshing = true;
        try { await refreshGroupsSilent(); } catch {} finally { _grpRefreshing = false; }
    }, 12000);
});

// ── Tab navigation ────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-'+btn.dataset.tab)?.classList.add('active');
        });
    });
}

// ── Push events ───────────────────────────────────────────────
function setupPushEvents() {
    agent.on('log',          msg  => appendLog(msg));
    agent.on('runner:status',data => setRunnerUI(data.running));
    agent.on('accounts:updated', ()  => loadAccounts());
    agent.on('jobs:updated', job  => {
        const i = _jobs.findIndex(j=>j._id===job._id);
        if (i!==-1) _jobs[i]=job; else _jobs.unshift(job);
        renderJobs();
    });
    agent.on('jobs:progress', ()  => {});
}

// ── Status ────────────────────────────────────────────────────
async function refreshStatus() {
    const s = await agent.getStatus();
    document.getElementById('statApi').textContent     = `port ${s.apiPort}`;
    document.getElementById('statDb').textContent      = s.dbConnected ? 'Connected' : 'Offline';
    document.getElementById('statUptime').textContent  = fmtUptime(s.uptime);
    document.getElementById('statRunner').textContent  = s.running ? 'กำลังโพสอยู่' : 'หยุด';

    setDot('dotApi',    true);
    setDot('dotDb',     s.dbConnected);
    setDot('dotRunner', s.running);
    document.getElementById('lblApi').textContent    = `API: :${s.apiPort}`;
    document.getElementById('lblDb').textContent     = s.dbConnected ? 'DB: เชื่อมต่อแล้ว' : 'DB: ออฟไลน์';
    document.getElementById('lblRunner').textContent = s.running ? 'ระบบ: กำลังโพส' : 'ระบบ: หยุด';

    setRunnerUI(s.running);
}

function setDot(id, ok) {
    const d = document.getElementById(id);
    d.className = 'dot ' + (ok ? 'ok' : 'err');
}

// ── Runner ────────────────────────────────────────────────────
async function startRunner() {
    await agent.startRunner();
    setRunnerUI(true);
    appendLog('[▶] ระบบโพสอัตโนมัติเริ่มทำงานแล้ว');
}
async function stopRunner() {
    await agent.stopRunner();
    setRunnerUI(false);
    appendLog('[⏹] ระบบโพสอัตโนมัติหยุดแล้ว');
}
function setRunnerUI(running) {
    document.getElementById('btnStart').disabled = running;
    document.getElementById('btnStop').disabled  = !running;
}

// ── Accounts ──────────────────────────────────────────────────
async function loadAccounts() {
    _accounts = await agent.listAccounts();
    renderAccounts();
    updateAccountSelect();
}

let _loggingIn = new Set();

function renderAccounts() {
    const el = document.getElementById('accountsList');
    document.getElementById('accCount').textContent = _accounts.length;
    if (!_accounts.length) { el.innerHTML='<div class="empty-state">ยังไม่มีบัญชี — กด "+ เพิ่มบัญชี" ด้านบน</div>'; return; }
    el.innerHTML = _accounts.map(a => {
        const init      = a.email[0].toUpperCase();
        const ts        = a.loginedAt ? fmtDate(a.loginedAt) : '—';
        const loading   = _loggingIn.has(a.id);
        const loggedIn  = a.status === 'logged_in';

        const loginBtn = loading
            ? `<button class="btn btn-secondary" style="font-size:11px;padding:.3rem .65rem;margin-left:.4rem" disabled>⏳ กำลังเข้าสู่ระบบ...</button>`
            : loggedIn
                ? `<button class="btn btn-secondary" style="font-size:11px;padding:.3rem .55rem;margin-left:.4rem;opacity:.7"
                     onclick="loginAcc('${a.id}')" title="เข้าสู่ระบบใหม่ (session หมดอายุ)">🔄 เข้าใหม่</button>`
                : `<button class="btn btn-primary" style="font-size:11px;padding:.3rem .65rem;margin-left:.4rem"
                     onclick="loginAcc('${a.id}')">เข้าสู่ระบบ</button>`;

        return `
          <div class="acc-item">
            <div class="acc-avatar">${init}</div>
            <div class="acc-info">
              <div class="acc-email">${esc(a.email)}</div>
              <div class="acc-meta">${loading ? '🔄 กำลัง auto-fill รหัสผ่านในเบราว์เซอร์...' : 'เข้าสู่ระบบล่าสุด: ' + ts}</div>
            </div>
            <span class="acc-status ${loading ? 'running' : a.status}">${loading ? 'กำลังเข้าสู่ระบบ' : statusAccTH(a.status)}</span>
            ${loginBtn}
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .65rem"
              onclick="logoutAcc('${a.id}')" ${!loggedIn||loading?'disabled':''}>ออกจากระบบ</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)"
              onclick="removeAcc('${a.id}')" title="ลบบัญชี" ${loading?'disabled':''}>🗑</button>
          </div>`;
    }).join('');
}

function updateAccountSelect() {
    const sel = document.getElementById('jobAccount');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— เลือกบัญชี Facebook —</option>';
    _accounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id; opt.textContent = a.email;
        if (a.status==='logged_in') opt.textContent += ' ✓';
        sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
    // Update avatar
    const av = document.getElementById('fbAvatar');
    if (av) {
        const acc = _accounts.find(a => a.id === sel.value) || _accounts.find(a => a.status === 'logged_in');
        av.textContent = acc ? acc.email[0].toUpperCase() : '?';
    }
}

function toggleAddAccount() {
    const f = document.getElementById('addAccountForm');
    f.style.display = f.style.display==='none' ? '' : 'none';
}

async function addAccount() {
    const email = document.getElementById('accEmail').value.trim();
    const pass  = document.getElementById('accPassword').value;
    if (!email||!pass) { alert('กรุณากรอก Email และรหัสผ่านให้ครบ'); return; }
    const res = await agent.addAccount(email, pass);
    if (res.error) { alert(res.error); return; }
    document.getElementById('accEmail').value = '';
    document.getElementById('accPassword').value = '';
    toggleAddAccount();
    await loadAccounts();
    appendLog(`[✅] เพิ่มบัญชีแล้ว: ${email}`);
    // Auto-login ทันทีหลังเพิ่ม — ไม่ต้องกดปุ่ม "เข้าสู่ระบบ" อีกรอบ
    const acc = _accounts.find(a => a.email === email);
    if (acc) await loginAcc(acc.id);
}

async function removeAcc(id) {
    if (!confirm('ต้องการลบบัญชีนี้ออกหรือไม่?')) return;
    await agent.removeAccount(id);
    await loadAccounts();
}

async function loginAcc(id) {
    _loggingIn.add(id);
    renderAccounts();
    appendLog('[🔑] กำลังเปิดเบราว์เซอร์และกรอก Email/รหัสผ่านให้อัตโนมัติ...');
    appendLog('[ℹ️] ถ้า Facebook ขอยืนยันตัวตน (OTP/โทรศัพท์/อีเมล) ให้ทำในเบราว์เซอร์ที่เปิดขึ้นมาได้เลย');
    const res = await agent.loginAccount(id);
    _loggingIn.delete(id);
    if (res.ok) appendLog('[✅] '+res.message);
    else appendLog('[❌] '+(res.error||'เข้าสู่ระบบไม่สำเร็จ'));
    await loadAccounts();
}

async function logoutAcc(id) {
    await agent.logoutAccount(id);
    await loadAccounts();
    appendLog('[⏹] ออกจากระบบแล้ว');
}

// ── Groups ────────────────────────────────────────────────────
async function loadGroups() {
    const el = document.getElementById('groupPickList');
    el.innerHTML = '<div class="loading">กำลังโหลด...</div>';
    _groups = await agent.getGroups();
    _selected = _groups.map(() => true);
    renderGroupsInline();
    updateGroupCount();
}

// Smart refresh — preserves current selections, re-renders on any change
async function refreshGroupsSilent() {
    const fresh = await agent.getGroups();
    const fp = g => g.groupId + ':' + (g.categories || [g.category || 'ทั่วไป']).slice().sort().join(',');
    const oldMap = new Map(_groups.map(g => [g.groupId, fp(g)]));
    const changed = fresh.length !== _groups.length || fresh.some(g => oldMap.get(g.groupId) !== fp(g));
    if (!changed) return;
    const prevMap = new Map(_groups.map((g, i) => [g.groupId, _selected[i]]));
    _groups   = fresh;
    _selected = fresh.map(g => prevMap.has(g.groupId) ? prevMap.get(g.groupId) : true);
    renderGroupsInline();
    renderGroupsModal();
    updateGroupCount();
}

// ── Category helpers ──────────────────────────────────────────
// _lastCats keeps the ordered cats array from the last render so
// onclick handlers can pass a numeric index instead of a Thai string
// (Thai chars in element IDs cause duplicate-ID bugs via /\W/g replacement)
let _lastCats = [];

function _isCatCollapsed(cat) {
    if (cat in _catCollapsed) return _catCollapsed[cat];
    return cat !== 'ทั่วไป';
}

function _getCatGroups() {
    // catMap  → groups displayed under their PRIMARY non-ทั่วไป cat (no duplicates)
    // catAll  → every non-ทั่วไป cat → ALL groups that belong to it (for selection)
    // ทั่วไป appears in cats ONLY if some group has no other category at all.
    const catMap = {};
    const catAll = {};
    const nonGenSet = new Set();
    let hasGenOnly = false;

    _groups.forEach((g, i) => {
        const gcats = (g.categories && g.categories.length) ? g.categories : [g.category || 'ทั่วไป'];
        const nonGen = gcats.filter(c => c !== 'ทั่วไป');
        const primaryCat = nonGen[0] || 'ทั่วไป';

        if (primaryCat === 'ทั่วไป') hasGenOnly = true;
        if (!catMap[primaryCat]) catMap[primaryCat] = [];
        catMap[primaryCat].push({ g, i });

        nonGen.forEach(cat => {
            nonGenSet.add(cat);
            if (!catAll[cat]) catAll[cat] = [];
            catAll[cat].push({ g, i });
        });
    });

    const cats = [
        ...(hasGenOnly ? ['ทั่วไป'] : []),
        ...[...nonGenSet].sort(),
    ];
    return { cats, catMap, catAll };
}

// Returns the authoritative item list for a category:
// ทั่วไป uses catMap (only truly uncategorised groups),
// all other cats use catAll (every member, for selection + count).
function _catItems(cat, catMap, catAll) {
    return cat === 'ทั่วไป' ? (catMap[cat] || []) : (catAll[cat] || []);
}

function _renderCatBlock(cat, catMap, catAll, pfx, ci) {
    const items     = _catItems(cat, catMap, catAll);
    const collapsed = _isCatCollapsed(cat);
    const cbId      = `${pfx}_ch_${ci}`;
    const cntId     = `${pfx}_cnt_${ci}`;
    const grpPfx    = pfx === 'i' ? 'g' : 'gm';
    const selCount  = items.filter(({i}) => _selected[i]).length;
    const chevStyle = `display:inline-block;font-size:10px;color:var(--text3);transition:transform .15s;transform:${collapsed?'rotate(-90deg)':'rotate(0)'}`;
    const cbStyle   = `accent-color:var(--accent);width:14px;height:14px;flex-shrink:0;cursor:pointer`;

    const bodyHtml = items.map(({g,i}) => `
      <div class="pick-item pick-indent" onclick="togGrp(${i})">
        <input type="checkbox" id="${grpPfx}_${ci}_${i}" data-grp="${i}" ${_selected[i]?'checked':''}
               onclick="event.stopPropagation()"
               onchange="_selected[${i}]=this.checked;_syncCb(${i});updateGroupCount()"
               style="${cbStyle}">
        <label for="${grpPfx}_${ci}_${i}" onclick="event.stopPropagation()" style="flex:1;cursor:pointer">${esc(g.groupName)}</label>
      </div>`).join('');

    return `<div class="pick-cat">
      <div class="pick-cat-hd" onclick="toggleCatGrp(${ci})">
        <input type="checkbox" id="${cbId}" onclick="event.stopPropagation();toggleCatSel(${ci},this.checked)"
               style="${cbStyle}">
        <label for="${cbId}" onclick="event.stopPropagation()"
               style="flex:1;cursor:pointer;font-size:11.5px;font-weight:700;color:var(--text)">
          📍 ${esc(cat)} <span id="${cntId}" style="font-weight:400;color:var(--text3)">${selCount}/${items.length} กลุ่ม</span>
        </label>
        <span style="${chevStyle}">▼</span>
      </div>
      <div class="pick-cat-body" style="display:${collapsed?'none':'block'}">
        ${bodyHtml}
      </div>
    </div>`;
}

function _applyIndeterminate(pfx, cats, catMap, catAll) {
    cats.forEach((cat, ci) => {
        const items    = _catItems(cat, catMap, catAll);
        const selCount = items.filter(({i}) => _selected[i]).length;
        const allC     = selCount === items.length;
        const someC    = selCount > 0;
        const cb  = document.getElementById(`${pfx}_ch_${ci}`);
        const cnt = document.getElementById(`${pfx}_cnt_${ci}`);
        if (cb)  { cb.checked = allC; cb.indeterminate = someC && !allC; }
        if (cnt) cnt.textContent = `${selCount}/${items.length} กลุ่ม`;
    });
}

function toggleCatGrp(ci) {
    const cat = _lastCats[ci];
    if (cat !== undefined) _catCollapsed[cat] = !_isCatCollapsed(cat);
    renderGroupsInline();
    renderGroupsModal();
}

function toggleCatSel(ci, checked) {
    const cat = _lastCats[ci];
    if (!cat) return;
    const { catMap, catAll } = _getCatGroups();
    _catItems(cat, catMap, catAll).forEach(({ i }) => { _selected[i] = checked; });
    renderGroupsInline();
    renderGroupsModal();
    updateGroupCount();
}

function _syncCatCb(ci) {
    const cat = _lastCats[ci];
    if (!cat) return;
    const { catMap, catAll } = _getCatGroups();
    const items    = _catItems(cat, catMap, catAll);
    const selCount = items.filter(({i}) => _selected[i]).length;
    const allC     = selCount === items.length;
    const someC    = selCount > 0;
    ['i', 'm'].forEach(pfx => {
        const cb  = document.getElementById(`${pfx}_ch_${ci}`);
        const cnt = document.getElementById(`${pfx}_cnt_${ci}`);
        if (cb)  { cb.checked = allC; cb.indeterminate = someC && !allC; }
        if (cnt) cnt.textContent = `${selCount}/${items.length} กลุ่ม`;
    });
}

function _syncCb(i) {
    // Sync all checkbox instances for this group (may appear in multiple categories)
    document.querySelectorAll(`[data-grp="${i}"]`).forEach(cb => { cb.checked = _selected[i]; });
    // Sync all category headers that include this group
    const { catMap, catAll } = _getCatGroups();
    _lastCats.forEach((cat, ci) => {
        if (_catItems(cat, catMap, catAll).some(x => x.i === i)) _syncCatCb(ci);
    });
}

function renderGroupsInline() {
    const el = document.getElementById('groupPickList');
    const moreBtn = document.getElementById('showMoreGroupsBtn');
    if (moreBtn) moreBtn.style.display = 'none';
    if (!_groups.length) {
        el.innerHTML = '<div class="empty-list">ยังไม่มีกลุ่ม — กรุณาเพิ่มกลุ่มในเว็บแอปก่อน</div>';
        return;
    }
    const { cats, catMap, catAll } = _getCatGroups();
    _lastCats = cats;
    el.innerHTML = cats.map((cat, ci) => _renderCatBlock(cat, catMap, catAll, 'i', ci)).join('');
    _applyIndeterminate('i', cats, catMap, catAll);
}

function renderGroupsModal() {
    const el = document.getElementById('groupsModalList');
    if (!el) return;
    const { cats, catMap, catAll } = _getCatGroups();
    el.innerHTML = cats.map((cat, ci) => _renderCatBlock(cat, catMap, catAll, 'm', ci)).join('');
    _applyIndeterminate('m', cats, catMap, catAll);
}

function openGroupsModal()  { renderGroupsModal(); document.getElementById('groupsModal').style.display='flex'; }
function closeGroupsModal(e){ if(!e||e.target===document.getElementById('groupsModal')) document.getElementById('groupsModal').style.display='none'; }

function togGrp(i) {
    _selected[i] = !_selected[i];
    _syncCb(i);   // syncs all checkboxes + all category headers for this group
    updateGroupCount();
}
function togGrpM(i) { togGrp(i); }

function selAll()  { _selected=_selected.map(()=>true);  renderGroupsInline(); renderGroupsModal(); updateGroupCount(); }
function selNone() { _selected=_selected.map(()=>false); renderGroupsInline(); renderGroupsModal(); updateGroupCount(); }
function selectedGroups() {
    // deduplicate เพราะ many-to-many — กลุ่มเดียวอาจอยู่ใน _selected หลาย index
    const seen = new Set();
    return _groups.filter((g, i) => {
        if (!_selected[i] || seen.has(g.groupId)) return false;
        seen.add(g.groupId);
        return true;
    });
}

// ── Recent posts ──────────────────────────────────────────────
async function loadRecentPosts() {
    const el = document.getElementById('recentPostsList');
    el.innerHTML = '<div class="loading">กำลังโหลด...</div>';
    const posts = await agent.getRecentPosts();
    if (!posts.length) { el.innerHTML='<div class="empty-list">ยังไม่มีประวัติโพส</div>'; return; }
    el.dataset.posts = JSON.stringify(posts);
    el.innerHTML = posts.map((p,i)=>{
        const msg = p.message.length>55 ? p.message.slice(0,55)+'...' : p.message;
        const urls = p.postUrls.length ? ` · ${p.postUrls.length} URL` : '';
        return `<div class="pick-item" id="rp_${i}" onclick="pickPost(${i})">
          <div style="flex:1;min-width:0">
            <div class="pick-msg">${esc(msg)}</div>
            <div class="pick-meta">✓ ${p.successCount} เพจ${urls} · ${fmtDate(p.createdAt)}</div>
          </div></div>`;
    }).join('');
}

function pickPost(i) {
    const posts = JSON.parse(document.getElementById('recentPostsList').dataset.posts||'[]');
    const p = posts[i]; if(!p) return;
    document.querySelectorAll('.recent-post-item,.pick-item').forEach(e=>e.classList.remove('selected'));
    document.getElementById(`rp_${i}`)?.classList.add('selected');
    let msg = p.message;
    if (p.postUrls.length) msg += '\n\n' + p.postUrls[0];
    document.getElementById('jobMsg').value = msg;
}

// ── Jobs ──────────────────────────────────────────────────────
async function loadJobs() {
    _jobs = await agent.listJobs();
    _jobsVisible = 20;
    renderJobs();
}

function filterJobs(btn, filter) {
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _jobFilter = filter;
    _jobsVisible = 20;
    if (_agentTimelineOn) toggleAgentTimelineView();
    renderJobs();
}

function renderJobs() {
    _jobs.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const el = document.getElementById('jobsList');
    const filtered = _jobFilter==='all' ? _jobs
        : _jobFilter==='scheduled' ? _jobs.filter(j=>j.status==='pending' && j.scheduledAt)
        : _jobs.filter(j=>j.status===_jobFilter);
    const pending = _jobs.filter(j=>j.status==='pending').length;
    const badge = document.getElementById('pendingBadge');
    if (pending>0) { badge.textContent=pending; badge.style.display=''; }
    else badge.style.display='none';

    const bulkBar = document.getElementById('jqAgentBulkBar');
    if (bulkBar && _jobFilter!=='scheduled') bulkBar.style.display='none';

    if (!filtered.length) { el.innerHTML='<div class="empty-state">ยังไม่มีรายการโพส</div>'; return; }
    const icons = { pending:'⏳', running:'🔄', success:'✅', failed:'❌', expired:'⏰', cancelled:'🚫' };
    const shown = filtered.slice(0, _jobsVisible);
    let html = shown.map(j=>{
        const ok  = (j.results||[]).filter(r=>r.status==='success').length;
        const tot = j.groups?.length||0;
        const pageTag = j.postAsPage ? ` · 🏢 ${esc(j.postAsPage)}` : '';
        const meta = (j.status==='success'||j.status==='failed') ? `${ok}/${tot} กลุ่ม${pageTag}` : `${tot} กลุ่ม · ${j.delaySeconds}s${pageTag}`;
        const { display, modeTag } = _parseJobMsg(j.message);
        const imgBadge = (j.images||[]).length > 0 ? `<span style="font-size:10px;background:#e7f3ff;color:#1877f2;border-radius:4px;padding:.05rem .4rem;margin-left:.3rem">📸 ${j.images.length}</span>` : '';
        const now = new Date();
        const schedBadge = j.scheduledAt ? (() => {
            const t = new Date(j.scheduledAt);
            const overdue = t < now;
            const label = fmtDate(j.scheduledAt);
            return `<span style="font-size:10px;background:${overdue?'#fde8e8':'#fff3cd'};color:${overdue?'#c62828':'#856404'};border-radius:4px;padding:.05rem .4rem;margin-left:.3rem">${overdue?'⚠️':'⏰'} ${label}</span>`;
        })() : '';
        const reschedBtn = (j.status === 'pending' || j.status === 'expired') ? `<button onclick="agentReschedule('${j._id}','${j.scheduledAt||''}')" style="background:none;border:none;cursor:pointer;font-size:13px;padding:.1rem .2rem" title="${j.status==='expired'?'เลื่อนเวลา (ใช้ได้ทันที)':'แก้ไขเวลา'}">🕐</button>` : '';
        const retryBtn = j.status === 'failed' ? `<button onclick="retryJobAgent('${j._id}')" style="background:none;border:none;cursor:pointer;font-size:13px;padding:.1rem .2rem" title="ลองใหม่">🔁</button>` : '';
        const selCb = (_jobFilter==='scheduled' && j.status==='pending' && j.scheduledAt)
            ? `<input type="checkbox" class="jqAgentSelCb" data-id="${j._id}" onchange="updateAgentJqSelection()" style="accent-color:#856404;cursor:pointer;width:15px;height:15px;margin-right:.2rem">`
            : '';
        return `<div class="job-item">
          ${selCb}
          <div class="job-icon">${icons[j.status]||'❓'}</div>
          <div class="job-body">
            <div class="job-msg">${modeTag ? `<span class="job-mode-tag">${modeTag}</span> ` : ''}${esc(display)}${imgBadge}${schedBadge}</div>
            <div class="job-meta">${meta} · ${fmtDate(j.createdAt)}</div>
          </div>
          <span class="job-status ${j.status}">${statusJobTH(j.status)}</span>
          ${reschedBtn}
          ${retryBtn}
          <button class="job-del" onclick="deleteJob('${j._id}')">🗑</button>
        </div>`;
    }).join('');
    if (filtered.length > _jobsVisible) {
        html += `<div style="padding:.65rem;text-align:center;border-top:1px solid var(--border)">
          <button class="btn btn-secondary" style="font-size:12px;padding:.35rem .85rem" onclick="showMoreJobs()">
            เพิ่มเติม (${filtered.length - _jobsVisible} รายการ)
          </button>
        </div>`;
    }
    el.innerHTML = html;
    updateAgentJqSelection();
}

let _agentTimelineOn = false;
function toggleAgentTimelineView() {
    _agentTimelineOn = !_agentTimelineOn;
    const view = document.getElementById('agentTimelineView');
    const card = document.getElementById('jobsListCard');
    const btn  = document.getElementById('btnAgentTimelineView');
    if (_agentTimelineOn) {
        renderAgentTimeline();
        view.style.display = '';
        card.style.display = 'none';
        btn.classList.add('active');
    } else {
        view.style.display = 'none';
        card.style.display = '';
        btn.classList.remove('active');
    }
}

function dt24Get(prefix) {
    const d = document.getElementById(prefix+'_d')?.value;
    if (!d) return '';
    const h = String(document.getElementById(prefix+'_h').value||0).padStart(2,'0');
    const m = String(document.getElementById(prefix+'_m').value||0).padStart(2,'0');
    return `${d}T${h}:${m}`;
}
function dt24Set(prefix, localStr) {
    const [d,t] = (localStr||'').split('T');
    document.getElementById(prefix+'_d').value = d||'';
    const [h,m] = (t||'').split(':');
    document.getElementById(prefix+'_h').value = h||'';
    document.getElementById(prefix+'_m').value = m||'';
}

function toggleComposeTimeline() {
    const view = document.getElementById('composeTimelineView');
    const show = view.style.display === 'none';
    view.style.display = show ? '' : 'none';
    if (show) renderComposeTimeline();
}

function renderComposeTimeline() {
    const view = document.getElementById('composeTimelineView');
    const items = _jobs.filter(j => j.status === 'pending' && j.scheduledAt);
    if (!items.length) {
        view.innerHTML = '<div class="empty-state">ยังไม่มีรายการที่ตั้งเวลาไว้</div>';
        return;
    }
    const byDate = {};
    items.forEach(j => {
        const d = new Date(j.scheduledAt);
        const key = d.toLocaleDateString('en-CA');
        (byDate[key] = byDate[key] || []).push(j);
    });
    const now = new Date();
    const hourLines = [0, 4, 8, 12, 16, 20];
    const cols = Object.keys(byDate).sort().map(key => {
        const d = new Date(key + 'T00:00:00');
        const label = d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
        const chips = byDate[key].map(j => {
            const t = new Date(j.scheduledAt);
            const top = ((t.getHours() + t.getMinutes() / 60) / 24 * 100).toFixed(2);
            const overdue = t < now;
            const time = t.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
            const { display } = _parseJobMsg(j.message);
            const msg = (display || '').slice(0, 30);
            return `<div onclick="dt24Set('jobScheduledAt','${_toBkkLocalAgent(t)}')" title="${time} — ${esc(msg)}"
              style="position:absolute;left:4px;right:4px;top:${top}%;background:${overdue ? '#fde8e8' : '#fff3cd'};color:${overdue ? '#c62828' : '#856404'};border:1px solid ${overdue ? '#f5b5b5' : '#ffe08a'};border-radius:5px;padding:.15rem .35rem;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;z-index:1">
              ${overdue ? '⚠️' : '⏰'} ${time} ${esc(msg)}</div>`;
        }).join('');
        const lines = hourLines.map(h => `<div style="position:absolute;left:0;right:0;top:${(h/24*100).toFixed(2)}%;border-top:1px dashed var(--border);font-size:10px;color:var(--text2);padding-left:2px">${String(h).padStart(2,'0')}:00</div>`).join('');
        return `<div style="flex:0 0 150px;min-width:150px">
          <div style="font-size:12px;font-weight:700;color:var(--text);text-align:center;margin-bottom:.4rem">${label}</div>
          <div style="position:relative;height:360px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">${lines}${chips}</div>
        </div>`;
    }).join('');
    view.innerHTML = `<div style="display:flex;gap:.6rem">${cols}</div>`;
}

function _toBkkLocalAgent(date) {
    return date.toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T').slice(0, 16);
}

function renderAgentTimeline() {
    const view = document.getElementById('agentTimelineView');
    const items = _jobs.filter(j => j.status === 'pending' && j.scheduledAt);
    if (!items.length) {
        view.innerHTML = '<div class="empty-state">ยังไม่มีรายการที่ตั้งเวลาไว้</div>';
        return;
    }
    const byDate = {};
    items.forEach(j => {
        const d = new Date(j.scheduledAt);
        const key = d.toLocaleDateString('en-CA');
        (byDate[key] = byDate[key] || []).push(j);
    });
    const now = new Date();
    const hourLines = [0, 4, 8, 12, 16, 20];
    const cols = Object.keys(byDate).sort().map(key => {
        const d = new Date(key + 'T00:00:00');
        const label = d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
        const chips = byDate[key].map(j => {
            const t = new Date(j.scheduledAt);
            const top = ((t.getHours() + t.getMinutes() / 60) / 24 * 100).toFixed(2);
            const overdue = t < now;
            const time = t.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
            const { display } = _parseJobMsg(j.message);
            const msg = (display || '').slice(0, 30);
            return `<div onclick="agentReschedule('${j._id}','${j.scheduledAt||''}')" title="${time} — ${esc(msg)}"
              style="position:absolute;left:4px;right:4px;top:${top}%;background:${overdue ? '#fde8e8' : '#fff3cd'};color:${overdue ? '#c62828' : '#856404'};border:1px solid ${overdue ? '#f5b5b5' : '#ffe08a'};border-radius:5px;padding:.15rem .35rem;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;z-index:1">
              ${overdue ? '⚠️' : '⏰'} ${time} ${esc(msg)}</div>`;
        }).join('');
        const lines = hourLines.map(h => `<div style="position:absolute;left:0;right:0;top:${(h/24*100).toFixed(2)}%;border-top:1px dashed var(--border);font-size:10px;color:var(--text2);padding-left:2px">${String(h).padStart(2,'0')}:00</div>`).join('');
        return `<div style="flex:0 0 150px;min-width:150px">
          <div style="font-size:12px;font-weight:700;color:var(--text);text-align:center;margin-bottom:.4rem">${label}</div>
          <div style="position:relative;height:360px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">${lines}${chips}</div>
        </div>`;
    }).join('');
    view.innerHTML = `<div style="display:flex;gap:.6rem">${cols}</div>`;
}

function updateAgentJqSelection() {
    const bar = document.getElementById('jqAgentBulkBar');
    if (!bar) return;
    if (_jobFilter !== 'scheduled') { bar.style.display = 'none'; return; }
    const checked = document.querySelectorAll('.jqAgentSelCb:checked').length;
    bar.style.display = checked ? 'flex' : 'none';
    const cnt = document.getElementById('jqAgentSelCount');
    if (cnt) cnt.textContent = checked;
}

function clearAgentJqSelection() {
    document.querySelectorAll('.jqAgentSelCb').forEach(cb => cb.checked = false);
    updateAgentJqSelection();
}

async function bulkRescheduleAgentJobs() {
    const ids = [...document.querySelectorAll('.jqAgentSelCb')].filter(cb => cb.checked).map(cb => cb.dataset.id);
    if (!ids.length) return;
    const val = prompt(`เลื่อนเวลาโพส ${ids.length} รายการ ไปเป็นเวลาใหม่\nรูปแบบ: YYYY-MM-DDTHH:MM`, '');
    if (val === null || !val.trim()) return;
    try {
        const scheduledAt = new Date(val.trim() + ':00+07:00').toISOString();
        await Promise.all(ids.map(id => agent.rescheduleJob(id, scheduledAt)));
        await loadJobs();
        appendLog(`[🕐] เลื่อนเวลาโพส ${ids.length} รายการ → ${new Date(scheduledAt).toLocaleString('th-TH', { timeZone:'Asia/Bangkok', hour12:false })}`);
    } catch(e) {
        alert('เลื่อนเวลาไม่สำเร็จ: ' + e.message);
    }
}

function showMoreJobs() {
    _jobsVisible += 20;
    renderJobs();
}

async function deleteAllJobs() {
    const n = _jobs.length;
    if (!n) return;
    const running = _jobs.filter(j=>j.status==='pending'||j.status==='running').length;
    const msg = running
        ? `มีรายการที่รอ/กำลังโพสอยู่ ${running} รายการ\nต้องการลบคิวทั้งหมด ${n} รายการหรือไม่?`
        : `ต้องการลบรายการโพสทั้งหมด ${n} รายการหรือไม่?`;
    if (!confirm(msg)) return;
    await agent.deleteAllJobs();
    _jobs = []; _jobsVisible = 20;
    renderJobs();
    appendLog('[🗑] ลบรายการโพสทั้งหมดแล้ว');
}

function toggleCreateJob() {
    document.querySelector('.nav-item[data-tab="compose"]')?.click();
}

async function createJob() {
    const msg    = document.getElementById('jobMsg').value.trim();
    const groups = selectedGroups();
    const delay  = parseInt(document.getElementById('jobDelay').value)||5;
    const accId  = document.getElementById('jobAccount').value||null;
    const postAs = _selectedPage || null;

    if (!msg)         { alert('กรุณากรอกข้อความที่ต้องการโพส'); return; }
    if (!groups.length){ alert('กรุณาเลือกกลุ่มที่จะโพสอย่างน้อย 1 กลุ่ม'); return; }
    if (!accId)        { alert('กรุณาเลือกบัญชี Facebook ก่อนโพส'); return; }
    const _selAcc = _accounts.find(a => a.id === accId);
    if (_selAcc && _selAcc.status !== 'logged_in') { alert(`บัญชี "${_selAcc.email}" ยังไม่ได้เข้าสู่ระบบ\nกรุณากด "เข้าสู่ระบบ" ที่หน้าบัญชีก่อน`); return; }

    const imagePaths = _selectedImages.filter(i => !i.uploading).map(i => i.path).filter(Boolean);
    const schedInput = dt24Get('jobScheduledAt');
    const scheduledAt = schedInput ? new Date(schedInput + ':00+07:00').toISOString() : null;
    if (scheduledAt && new Date(scheduledAt) <= new Date()) {
        alert('เวลาที่ตั้งไว้ต้องเป็นในอนาคต');
        return;
    }

    const job = await agent.createJob({ message:msg, groups, delaySeconds:delay, accountId:accId||undefined, postAsPage:postAs||undefined, images:imagePaths, scheduledAt });
    if (job) {
        _jobs.unshift(job); renderJobs();
        document.getElementById('jobMsg').value = '';
        dt24Set('jobScheduledAt', '');
        document.getElementById('composeTimelineView').style.display = 'none';
        // Reset attachments
        _selectedImages.forEach(i => URL.revokeObjectURL(i.url));
        _selectedImages = [];
        document.getElementById('photoPreviewRow').style.display = 'none';
        const _n = document.getElementById('videoLocalNotice');
        if (_n) _n.style.display = 'none';
        document.querySelectorAll('.pick-item.selected').forEach(e => e.classList.remove('selected'));
        const info = [groups.length + ' กลุ่ม', postAs ? postAs : null, imagePaths.length ? imagePaths.length+' รูป' : null].filter(Boolean).join(' · ');
        appendLog(`[📋] สร้างคิวโพสแล้ว: "${msg.slice(0,40)}..." → ${info}`);
        if (scheduledAt) {
            const when = new Date(scheduledAt).toLocaleString('th-TH', { timeZone:'Asia/Bangkok', hour12:false, dateStyle:'short', timeStyle:'short' });
            agent.notify('ตั้งเวลาโพสสำเร็จ', `"${msg.slice(0,50)}" จะโพสเวลา ${when}`);
        }
        document.querySelector('.nav-item[data-tab="jobs"]')?.click();
    }
}

async function deleteJob(id) {
    await agent.deleteJob(id);
    _jobs = _jobs.filter(j=>j._id!==id);
    renderJobs();
}

async function retryJobAgent(id) {
    try {
        const job = await agent.retryJob(id);
        const i = _jobs.findIndex(j=>j._id===id);
        if (i!==-1 && job) _jobs[i] = job;
        renderJobs();
        appendLog(`[🔁] นำงาน ${id.slice(-6)} เข้าคิวใหม่แล้ว`);
    } catch(e) {
        alert('ลองใหม่ไม่สำเร็จ: ' + e.message);
    }
}

async function agentReschedule(id, currentScheduledAt) {
    const current = currentScheduledAt
        ? new Date(currentScheduledAt).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16)
        : '';
    const val = prompt(`แก้ไขเวลาโพส (ปล่อยว่างเพื่อล้าง)\nรูปแบบ: YYYY-MM-DDTHH:MM\n\nเวลาปัจจุบัน: ${current || 'ยังไม่ได้ตั้ง'}`, current);
    if (val === null) return; // cancelled
    try {
        const scheduledAt = val.trim() ? new Date(val.trim() + ':00+07:00').toISOString() : null;
        await agent.rescheduleJob(id, scheduledAt);
        const job = _jobs.find(j => j._id === id);
        if (job) { job.scheduledAt = scheduledAt; renderJobs(); }
        appendLog(`[🕐] แก้ไขเวลาโพส job ${id.slice(-6)} → ${scheduledAt ? new Date(scheduledAt).toLocaleString('th-TH', { timeZone:'Asia/Bangkok', hour12:false }) : 'ล้างแล้ว'}`);
    } catch(e) {
        alert('แก้ไขเวลาไม่สำเร็จ: ' + e.message);
    }
}

// ── Page chips + account change ───────────────────────────────
async function fetchAccountPages() {
    const accId = document.getElementById('jobAccount').value;
    if (!accId) { alert('กรุณาเลือกบัญชี Facebook ก่อน'); return; }
    const btn = document.getElementById('fetchPagesBtn');
    btn.textContent = '⏳'; btn.disabled = true;
    try {
        const pages = await agent.getAccountPages(accId);
        renderPageChips(pages);
        appendLog(pages.length ? `[📄] พบ ${pages.length} เพจ` : '[⚠️] ไม่พบเพจ — บัญชีนี้อาจยังไม่ได้เข้าสู่ระบบ');
    } finally {
        btn.textContent = '🔄'; btn.disabled = false;
    }
}

function renderPageChips(pages) {
    const el = document.getElementById('pageChips');
    if (!el) return;
    el.innerHTML = '';
    const addChip = (name, label) => {
        const btn = document.createElement('button');
        const isActive = name === '' ? !_selectedPage : name === _selectedPage;
        btn.className = 'page-chip' + (isActive ? ' active' : '');
        btn.textContent = label;
        btn.dataset.page = name;
        btn.addEventListener('click', () => selectPageChip(btn, name));
        el.appendChild(btn);
    };
    addChip('', 'บัญชีส่วนตัว');
    pages.forEach(p => addChip(p.name, p.name));
}

function selectPageChip(btn, name) {
    _selectedPage = name || null;
    document.querySelectorAll('#pageChips .page-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
}

async function onAccountChange() {
    const sel = document.getElementById('jobAccount');
    const acc = _accounts.find(a => a.id === sel.value);
    const av  = document.getElementById('fbAvatar');
    if (av) av.textContent = acc ? acc.email[0].toUpperCase() : '?';
    _selectedPage = null;
    renderPageChips([]);
    if (sel.value) fetchAccountPages();
}

function updateGroupCount() {
    const el = document.getElementById('fbGroupCount');
    if (!el) return;
    const sel   = selectedGroups();
    const n     = sel.length;
    const total = _groups.length;
    if (n === 0) { el.textContent = 'ยังไม่ได้เลือกกลุ่ม'; return; }
    el.textContent = n === total ? `เลือกทั้งหมด ${n} กลุ่ม` : `เลือก ${n}/${total} กลุ่ม`;
}

function toggleRecentPosts() {
    const p   = document.getElementById('recentPostsPanel');
    const btn = document.getElementById('btnRecentPosts');
    const open = p.style.display === '';
    p.style.display = open ? 'none' : '';
    btn?.classList.toggle('active', !open);
    if (!open && !_recentLoaded) { _recentLoaded = true; loadRecentPosts(); }
}

// ── Photo upload ──────────────────────────────────────────────
function openImagePicker() {
    document.getElementById('imageFileInput').click();
}

async function onImageFilesSelected(input) {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;

    // Add entries with local preview immediately
    const entries = files.map(f => ({
        path: '', url: URL.createObjectURL(f), name: f.name, uploading: true,
    }));
    _selectedImages.push(...entries);
    renderImagePreviews();

    // Generate video thumbnails in background (non-blocking)
    entries.forEach(async (entry) => {
        if (_isVideo(entry.name)) {
            entry.thumb = await _generateVideoThumbnail(entry.url);
            renderImagePreviews();
        }
    });

    // Upload each file via main process (Supabase if configured, else local fallback)
    await Promise.all(entries.map(async (entry, idx) => {
        try {
            entry.path = await _uploadFileToSupabase(files[idx]);
            entry.uploading = false;
            if (entry.path.startsWith('localpath::')) {
                entry.localOnly = true;
                appendLog(`[📁] วิดีโอบันทึก local (ใช้ได้เฉพาะเครื่องนี้): ${entry.name}`);
            } else if (entry.path.startsWith('http')) {
                appendLog(`[☁️] อัปโหลด Supabase สำเร็จ (ใช้ได้ทุกเครื่อง): ${entry.name}`);
            } else {
                // MongoDB filename — images shared via cloud DB
                appendLog(`[🗄️] รูปบันทึกลง MongoDB (ใช้ได้ทุกเครื่อง): ${entry.name}`);
            }
        } catch (e) {
            entry.uploading = false;
            entry.uploadError = e.message;
            appendLog(`[❌] อัปโหลดไม่สำเร็จ: ${entry.name} — ${e.message}`);
        }
        renderImagePreviews();
    }));
}

function removeImage(i) {
    URL.revokeObjectURL(_selectedImages[i].url);
    _selectedImages.splice(i, 1);
    renderImagePreviews();
}

const _VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv']);
function _isVideo(name) { return _VIDEO_EXTS.has((name||'').split('.').pop().toLowerCase()); }

function _generateVideoThumbnail(blobUrl) {
    return new Promise(resolve => {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'metadata';
        video.src = blobUrl;
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(null); } };
        video.onloadedmetadata = () => { video.currentTime = 0.5; };
        video.onseeked = () => {
            if (done) return; done = true;
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 160; canvas.height = 120;
                canvas.getContext('2d').drawImage(video, 0, 0, 160, 120);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            } catch { resolve(null); }
        };
        video.onerror = finish;
        setTimeout(finish, 4000);
    });
}

function renderImagePreviews() {
    const row = document.getElementById('photoPreviewRow');
    if (!_selectedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
    row.style.display = 'flex';
    row.innerHTML = _selectedImages.map((img, i) => `
      <div class="fb-photo-thumb">
        ${img.uploading
          ? `<div style="width:100%;height:100%;background:var(--hover);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:4px;gap:3px">
               <span style="font-size:14px">☁️</span>
               <span style="font-size:8px;color:var(--text3);text-align:center">กำลังอัปโหลด...</span>
             </div>`
          : img.uploadError
            ? `<div style="width:100%;height:100%;background:#3d1a1a;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:4px;gap:3px;padding:3px">
                 <span style="font-size:14px">❌</span>
                 <span style="font-size:7px;color:#ff6b6b;text-align:center;line-height:1.3">${esc(img.uploadError.slice(0,50))}</span>
               </div>`
          : img.missing
            ? `<div style="width:100%;height:100%;background:var(--hover);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:4px;gap:3px">
                 <span style="font-size:20px">🎬</span>
                 <span style="font-size:8.5px;color:var(--text3);text-align:center;line-height:1.3;padding:0 3px">${esc(img.name)}</span>
                 <span style="font-size:8px;color:#e67e22;font-weight:600">อัปโหลดใหม่</span>
               </div>`
            : _isVideo(img.name)
              ? `<div style="width:100%;height:100%;position:relative;border-radius:4px;overflow:hidden;background:#0d0d0d">
                   ${img.thumb
                     ? `<img src="${img.thumb}" style="width:100%;height:100%;object-fit:cover">`
                     : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><span style="font-size:22px">🎬</span></div>`}
                   <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                     <div style="background:rgba(0,0,0,.5);border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center">
                       <span style="color:#fff;font-size:11px;margin-left:2px">▶</span>
                     </div>
                   </div>
                 </div>`
              : `<img src="${img.url}" alt="${esc(img.name)}">
                 ${img.localOnly ? `<span style="position:absolute;bottom:2px;left:3px;font-size:9px;background:rgba(0,0,0,.55);color:#fff;border-radius:3px;padding:1px 3px">📁</span>` : ''}`}
        <button class="rm-btn" onclick="removeImage(${i})" title="ลบ">✕</button>
      </div>`).join('') +
      `<button class="fb-photo-add-btn" onclick="openImagePicker()" title="เพิ่มรูป/วิดีโออีก">+</button>`;
}

// ── Templates ─────────────────────────────────────────────────
let _templates = [];

async function loadTemplates() {
    _templates = await agent.listTemplates();
    renderTemplates();
}

let _agentTplFolder = '';

function _agentUpdateFolderChips() {
    const el = document.getElementById('agentFolderChips');
    if (!el) return;
    const folders = [...new Set(_templates.map(t => t.folder).filter(Boolean))].sort();
    const cur = document.getElementById('templateFolder')?.value || '';
    if (!folders.length) { el.innerHTML = ''; return; }
    el.innerHTML = folders.map(f => {
        const sel = f === cur;
        const fEsc = f.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        const fJs  = f.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return `<button type="button" onclick="_agentFolderChipClick('${fJs}',this)"
            style="padding:.18rem .5rem;border-radius:999px;border:1px solid ${sel?'#f7b928':'var(--border)'};background:${sel?'rgba(247,185,40,.18)':'transparent'};color:${sel?'#1a1a1a':'var(--text2)'};font-size:10px;cursor:pointer;font-family:inherit;transition:all .12s">📁 ${fEsc}</button>`;
    }).join('');
}
function _agentFolderChipClick(folderName, btn) {
    const inp = document.getElementById('templateFolder');
    if (!inp) return;
    const alreadySel = inp.value === folderName;
    const el = document.getElementById('agentFolderChips');
    if (el) el.querySelectorAll('button').forEach(b => {
        b.style.borderColor='var(--border)'; b.style.background='transparent'; b.style.color='var(--text2)';
    });
    if (!alreadySel) {
        inp.value = folderName;
        btn.style.borderColor='#f7b928'; btn.style.background='rgba(247,185,40,.18)'; btn.style.color='#1a1a1a';
    } else { inp.value = ''; }
}
function _agentFolderTyped() {
    const el = document.getElementById('agentFolderChips');
    if (el) el.querySelectorAll('button').forEach(b => {
        b.style.borderColor='var(--border)'; b.style.background='transparent'; b.style.color='var(--text2)';
    });
}

function renderTemplates() {
    const el = document.getElementById('templatesList');
    if (!_templates.length) { el.innerHTML='<div class="empty-state">ยังไม่มีเทมเพลตที่บันทึก</div>'; _agentUpdateFolderChips(); return; }

    // Render folder tabs
    const folders = [...new Set(_templates.map(t => t.folder).filter(Boolean))].sort();
    let tabHtml = `<div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:.5rem">
      <button onclick="_agentTplFolder='';renderTemplates()" style="padding:.2rem .5rem;border-radius:5px;border:1px solid ${_agentTplFolder===''?'var(--accent)':'var(--border)'};background:${_agentTplFolder===''?'var(--accent)':'transparent'};color:${_agentTplFolder===''?'#fff':'var(--text2)'};font-size:10px;cursor:pointer;font-family:inherit">ทั้งหมด</button>`;
    folders.forEach(f => {
        const active = _agentTplFolder === f;
        tabHtml += `<button onclick="_agentTplFolder='${f.replace(/'/g,"\\'")}';renderTemplates()" style="padding:.2rem .5rem;border-radius:5px;border:1px solid ${active?'#f7b928':'var(--border)'};background:${active?'#f7b928':'transparent'};color:${active?'#1a1a1a':'var(--text2)'};font-size:10px;cursor:pointer;font-family:inherit">📁 ${esc(f)}</button>`;
    });
    if (_agentTplFolder) {
        tabHtml += `<button onclick="postAllInFolder()" style="padding:.2rem .5rem;border-radius:5px;border:none;background:var(--accent);color:#fff;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;margin-left:auto">▶ โพสต์ทั้งหมด</button>`;
    }
    tabHtml += '</div>';

    const filtered = _agentTplFolder ? _templates.filter(t => t.folder === _agentTplFolder) : _templates;
    const rows = filtered.map(t => {
        const hasLocalVid  = (t.images||[]).some(p => p.startsWith('localpath::'));
        const cloudCount   = (t.images||[]).filter(p => p.startsWith('http')).length;
        const localImgCount = (t.images||[]).filter(p => !p.startsWith('localpath::') && !p.startsWith('http')).length;
        const imgCount     = cloudCount + localImgCount;
        let meta = `${(t.groups||[]).length} กลุ่ม · หน่วง ${t.delaySeconds} วิ/กลุ่ม`;
        if (imgCount)    meta += ` · 🖼 ${imgCount}`;
        if (cloudCount)  meta += ` · <span style="color:#27ae60">☁️ Cloud</span>`;
        if (hasLocalVid) meta += ` · <span style="color:#e67e22">🎬 วิดีโอ ต้องอัพโหลดใหม่ทุกครั้ง</span>`;
        const folderBadge = t.folder ? `<span style="font-size:9px;background:rgba(247,185,40,.15);color:#f7b928;border-radius:3px;padding:.05rem .25rem;margin-left:.25rem">📁 ${esc(t.folder)}</span>` : '';
        return `
      <div class="tpl-item">
        <div class="tpl-info">
          <div class="tpl-name">${esc(t.name||'ไม่มีชื่อ')}${folderBadge}</div>
          <div class="tpl-meta">${meta}</div>
        </div>
        <button class="btn btn-primary" style="font-size:11px;padding:.3rem .6rem" onclick="applyTemplate('${t.id}')">ใช้รูปแบบนี้</button>
        <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)" onclick="removeTemplate('${t.id}')" title="ลบรูปแบบนี้">🗑</button>
      </div>`;
    }).join('');
    el.innerHTML = tabHtml + (rows || '<div class="empty-state" style="padding:.8rem">ไม่มีเทมเพลตใน folder นี้</div>');
    _agentUpdateFolderChips();
}

function toggleTemplates() {
    const p = document.getElementById('templatesPanel');
    if (p.style.display === 'none') { loadTemplates(); p.style.display = ''; }
    else p.style.display = 'none';
}

async function saveTemplate() {
    const name   = document.getElementById('templateName').value.trim() || `Template ${_templates.length+1}`;
    const folder = document.getElementById('templateFolder')?.value.trim() || null;
    const msg    = document.getElementById('jobMsg').value.trim();
    const grps   = selectedGroups();
    const del    = parseInt(document.getElementById('jobDelay').value)||5;
    const postAs = _selectedPage || null;
    const imgs   = _selectedImages.filter(i => !i.uploading).map(i => i.path).filter(Boolean);
    if (!msg && !grps.length) { alert('กรุณากรอกข้อความหรือเลือกกลุ่มก่อนบันทึกรูปแบบ'); return; }
    _templates = await agent.saveTemplate({ name, folder, message:msg, groups:grps, delaySeconds:del, postAsPage:postAs||undefined, images: imgs });
    renderTemplates();
    document.getElementById('templateName').value = '';
    if (document.getElementById('templateFolder')) { document.getElementById('templateFolder').value = ''; _agentFolderTyped(); }
    appendLog(`[💾] บันทึกเทมเพลต: "${name}"${folder ? ` [${folder}]` : ''}${imgs.length ? ` · ${imgs.length} รูป` : ''}`);
}

async function applyTemplate(id) {
    // Fetch full template with image data URLs from MongoDB
    const t = await agent.getTemplate(id) || _templates.find(x => x.id === id || x._id === id);
    if (!t) return;
    document.getElementById('jobMsg').value   = t.message || '';
    document.getElementById('jobDelay').value = t.delaySeconds || 5;
    // Restore page chip selection
    if (t.postAsPage) {
        _selectedPage = t.postAsPage;
        const chips = document.getElementById('pageChips');
        if (chips) {
            let found = [...chips.querySelectorAll('.page-chip')].find(c => c.dataset.page === t.postAsPage);
            if (!found) {
                found = document.createElement('button');
                found.className = 'page-chip';
                found.textContent = t.postAsPage;
                found.dataset.page = t.postAsPage;
                found.addEventListener('click', () => selectPageChip(found, t.postAsPage));
                chips.appendChild(found);
            }
            selectPageChip(found, t.postAsPage);
        }
    } else {
        _selectedPage = null;
        const first = document.querySelector('#pageChips .page-chip');
        if (first) selectPageChip(first, '');
    }
    _selected = _groups.map(g => (t.groups||[]).some(tg=>tg.groupId===g.groupId));
    renderGroupsInline();
    updateGroupCount();
    // Restore images/videos from template
    _selectedImages.forEach(i => { try { if (i.url && !i.url.startsWith('http')) URL.revokeObjectURL(i.url); } catch {} });
    _selectedImages = (t.imageDataUrls || []).map(x => ({
        path:    x.supabaseUrl || x.localPath || x.filename || '',
        url:     x.supabaseUrl || x.dataUrl   || null,
        name:    x.filename    || '',
        missing: !!x.missing,
    }));
    renderImagePreviews();

    // Separate missing videos — show popup instead of inline "อัพโหลดใหม่" thumbnails
    const missingVideos = _selectedImages.filter(i => _isVideo(i.name) && i.missing);
    const cloudVideos   = _selectedImages.filter(i => _isVideo(i.name) && !i.missing);
    _selectedImages = _selectedImages.filter(i => !i.missing);
    renderImagePreviews();

    const notice = document.getElementById('videoLocalNotice');
    if (notice) notice.style.display = 'none';

    if (cloudVideos.length > 0) {
        appendLog(`[☁️] วิดีโอ ${cloudVideos.length} ไฟล์โหลดจาก Cloud เรียบร้อย`);
    }
    if (missingVideos.length > 0) {
        appendLog(`[⚠️] วิดีโอ ${missingVideos.length} ไฟล์ต้องอัพโหลดใหม่`);
        setTimeout(() => {
            const names = missingVideos.map(v => `• ${v.name}`).join('\n');
            if (confirm(`🎬 เทมเพลตนี้มีวิดีโอ ${missingVideos.length} ไฟล์ที่ต้องอัพโหลดใหม่\n\n${names}\n\nวิดีโอเก็บอยู่บนเครื่องนี้เท่านั้น ต้องเลือกไฟล์ใหม่ก่อนโพส\nกด OK เพื่อเลือกไฟล์วิดีโอ`)) {
                openImagePicker();
            }
        }, 350);
    }

    // Switch to compose tab
    document.querySelector('.nav-item[data-tab="compose"]')?.click();
    document.getElementById('templatesPanel').style.display='none';
    const mediaCount = _selectedImages.filter(i => !i.missing).length;
    appendLog(`[📁] โหลดเทมเพลต: "${t.name}"${mediaCount ? ` · ${mediaCount} ไฟล์` : ''}`);
}

async function postAllInFolder() {
    const items = _templates.filter(t => t.folder === _agentTplFolder);
    if (!items.length) return;

    const accId = document.getElementById('jobAccount').value || null;
    if (!accId) { alert('กรุณาเลือกบัญชี Facebook ก่อนโพส (เลือกที่แท็บสร้างโพส)'); return; }
    const _selAcc = _accounts.find(a => a.id === accId);
    if (_selAcc && _selAcc.status !== 'logged_in') { alert(`บัญชี "${_selAcc.email}" ยังไม่ได้เข้าสู่ระบบ`); return; }

    const spacingMin = prompt(`โพสต์ทั้งหมด ${items.length} รายการในโฟลเดอร์ "${_agentTplFolder}"\nเว้นช่วงกี่นาทีระหว่างโพสต์?`, '5');
    if (spacingMin === null) return;
    const spacingMs = Math.max(0, parseInt(spacingMin) || 0) * 60000;

    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
        const t = items[i];
        const scheduledAt = new Date(now + i * spacingMs).toISOString();
        const job = await agent.createJob({
            message: t.message || '', groups: t.groups || [], delaySeconds: t.delaySeconds || 5,
            accountId: accId, postAsPage: t.postAsPage || undefined, images: t.images || [], scheduledAt,
        });
        if (job) _jobs.unshift(job);
    }
    renderJobs();
    appendLog(`[📁▶] คิวโพสต์ทั้งหมด ${items.length} รายการจากโฟลเดอร์ "${_agentTplFolder}" เว้นช่วง ${spacingMin || 0} นาที`);
    document.querySelector('.nav-item[data-tab="jobs"]')?.click();
}

async function removeTemplate(id) {
    if (!confirm('ต้องการลบรูปแบบโพสนี้หรือไม่?')) return;
    _templates = await agent.deleteTemplate(id);
    renderTemplates();
}

// ── History ───────────────────────────────────────────────────
function onHistoryTabClick() {
    if (!_historyLoaded) loadHistory();
}

async function loadHistory() {
    _historyLoaded = true;
    const el = document.getElementById('historyList');
    if (el) el.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
    try {
        _history = await agent.getJobHistory();
    } catch { _history = []; }
    renderHistory();
}

function filterHistory(btn, filter) {
    document.querySelectorAll('[data-hfilter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _historyFilter = filter;
    renderHistory();
}

function renderHistory() {
    const el = document.getElementById('historyList');
    if (!el) return;
    const list = _historyFilter === 'all' ? _history : _history.filter(j => j.status === _historyFilter);

    if (!list.length) {
        el.innerHTML = '<div class="empty-state">ไม่พบประวัติโพส</div>';
        return;
    }
    el.innerHTML = list.map(j => {
        const ok  = (j.results||[]).filter(r => r.status === 'success').length;
        const tot = (j.groups||[]).length;
        const fail = tot - ok;
        const done = j.status === 'success';
        const icon = done ? '✅' : '❌';
        const statusCls = done ? 'done' : 'failed'; // CSS class names kept as-is (style.css)
        const statusTH  = done ? 'สำเร็จ' : 'ล้มเหลว';
        const msg = (j.message||'');
        const display = msg.includes('|||') ? msg.slice(0, msg.indexOf('|||')).trim() || msg.slice(msg.indexOf('|||')+3).trim() : msg;
        const preview = display.length > 55 ? display.slice(0, 55) + '…' : display;
        const failBadge = fail > 0
            ? `<span style="font-size:10px;background:#3d1a1a;color:#ff6b6b;border-radius:4px;padding:.05rem .4rem;margin-left:.3rem">❌ ${fail}</span>` : '';

        // Images: http → thumbnail, localpath:: → file:// thumbnail, fname → web /uploads/
        const httpImgs  = (j.images||[]).filter(p => p && p.startsWith('http'));
        const localImgs = (j.images||[]).filter(p => p && p.startsWith('localpath::'));
        const mongoImgs = (j.images||[]).filter(p => p && !p.startsWith('http') && !p.startsWith('localpath::'));
        const _base = _webUrl ? _webUrl.replace(/\/$/, '') : '';
        const allDisplayImgs = [
            ...httpImgs.map(url => ({ url, local: false })),
            ...localImgs.map(p  => ({ url: 'file:///' + p.replace('localpath::', '').replace(/\\/g, '/'), local: true })),
            ...(_base ? mongoImgs.map(p => ({ url: `${_base}/uploads/${p}`, local: false })) : []),
        ];
        const imgHtml = allDisplayImgs.length > 0
            ? `<div style="display:flex;gap:3px;margin-top:.4rem;flex-wrap:wrap">
                 ${allDisplayImgs.slice(0,4).map(({ url }) => {
                     const isVid = /\.(mp4|mov|avi|webm)$/i.test(url);
                     return isVid
                         ? `<div style="width:52px;height:52px;background:#111;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:20px">🎬</div>`
                         : `<img src="${url}" style="width:52px;height:52px;object-fit:cover;border-radius:4px;background:#2a2b2e" onerror="this.style.display='none'">`;
                 }).join('')}
                 ${allDisplayImgs.length > 4 ? `<div style="width:52px;height:52px;background:#2a2b2e;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text3)">+${allDisplayImgs.length-4}</div>` : ''}
               </div>`
            : '';

        return `<div class="job-item" style="flex-wrap:wrap;gap:.3rem">
          <div class="job-icon">${icon}</div>
          <div class="job-body" style="flex:1;min-width:0">
            <div class="job-msg">${esc(preview)}${failBadge}</div>
            <div class="job-meta">${ok}/${tot} กลุ่ม · ${fmtDate(j.createdAt)}</div>
            ${imgHtml}
          </div>
          <div style="display:flex;align-items:center;gap:.4rem;flex-shrink:0">
            <span class="job-status ${statusCls}">${statusTH}</span>
          </div>
        </div>`;
    }).join('');
}

// ── Log ───────────────────────────────────────────────────────
function appendLog(msg) {
    const el   = document.getElementById('logOutput');
    const line = document.createElement('span');
    line.style.display = 'block';
    if (msg.includes('✅')||msg.includes('สำเร็จ')) line.className='log-ok';
    else if (msg.includes('❌')||msg.includes('error')||msg.includes('ล้มเหลว')) line.className='log-err';
    else if (msg.includes('ℹ️')||msg.includes('📋')||msg.includes('▶')) line.className='log-info';
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}
function clearLog() { document.getElementById('logOutput').innerHTML=''; }

// ── Helpers ───────────────────────────────────────────────────
function _parseJobMsg(msg) {
    if (!msg) return { display: '', modeTag: null };
    if (msg.includes('|||')) {
        const sep  = msg.indexOf('|||');
        const text = msg.slice(0, sep).trim();
        const url  = msg.slice(sep + 3).trim();
        if (text) return { display: text, modeTag: '🔗 ลิงก์' };
        const short = url.length > 55 ? url.slice(0, 55) + '…' : url;
        return { display: short, modeTag: '↗ แชร์' };
    }
    return { display: msg, modeTag: null };
}

function togglePostingHelp() {
    const el  = document.getElementById('postingHelpPanel');
    const btn = document.getElementById('btnPostingHelp');
    const open = el.style.display === '';
    el.style.display = open ? 'none' : '';
    btn?.classList.toggle('active', !open);
}

function toggleDelayTip() {
    const el  = document.getElementById('delayTipPanel');
    const btn = document.getElementById('btnDelayTip');
    const open = el.style.display === '';
    el.style.display = open ? 'none' : '';
    if (btn) btn.style.color = open ? '' : 'var(--accent)';
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(iso){ try{ return new Date(iso).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour12:false,dateStyle:'short',timeStyle:'short'}); }catch{return iso||'';} }
function fmtUptime(s){ if(!s)return'—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}m`:`${m}m`; }
function statusAccTH(s){ return {logged_in:'เข้าสู่ระบบแล้ว',logged_out:'ออกจากระบบ',error:'มีข้อผิดพลาด'}[s]||s; }
function statusJobTH(s){ return {pending:'รอดำเนินการ',running:'กำลังโพส',success:'สำเร็จ',failed:'ล้มเหลว',expired:'หมดเวลา',cancelled:'ยกเลิก'}[s]||s; }

// ── Scheduled job notifications ───────────────────────────────
let _notifiedOverdue = new Set();

async function checkScheduledNotifications() {
    try {
        const jobs = await agent.listJobs();
        const now  = new Date();
        const scheduled = jobs.filter(j => j.status === 'pending' && j.scheduledAt);
        if (!scheduled.length) return;

        const overdue  = scheduled.filter(j => new Date(j.scheduledAt) < now);
        const upcoming = scheduled.filter(j => new Date(j.scheduledAt) >= now);

        // Show overdue banner once per session per job
        overdue.forEach(j => {
            if (_notifiedOverdue.has(j._id)) return;
            _notifiedOverdue.add(j._id);
            const msg = j.message.length > 40 ? j.message.slice(0, 40) + '…' : j.message;
            const schedTime = new Date(j.scheduledAt).toLocaleString('th-TH', { timeZone:'Asia/Bangkok', hour12:false, dateStyle:'short', timeStyle:'short' });
            appendLog(`⚠️ [แจ้งเตือน] งานโพส "${msg}" เลยเวลาที่ตั้งไว้แล้ว (${schedTime}) — Agent ต้องเปิดอยู่เพื่อโพส`);
        });

        if (scheduled.length > 0) {
            const banner = document.getElementById('scheduledBanner');
            if (!banner) {
                const b = document.createElement('div');
                b.id = 'scheduledBanner';
                b.style.cssText = 'background:#fff3cd;border:1px solid #ffe08a;border-radius:8px;padding:.5rem .85rem;margin:.4rem 0;font-size:12px;color:#856404;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap';
                b.innerHTML = `<i class="fa-solid fa-clock"></i>
                  <span>มีงานโพสที่ตั้งเวลาไว้ ${scheduled.length} งาน${overdue.length > 0 ? ` (เลยเวลาแล้ว ${overdue.length} งาน)` : ''} — Agent ต้องเปิดทิ้งไว้</span>
                  <button onclick="document.querySelector('.nav-item[data-tab=\'jobs\']')?.click()" style="background:#856404;color:#fff;border:none;border-radius:5px;padding:.2rem .5rem;font-size:11px;cursor:pointer;font-family:inherit">ดูคิว</button>`;
                const logEl = document.getElementById('agentLog') || document.querySelector('.log-panel');
                if (logEl) logEl.parentNode.insertBefore(b, logEl);
            }
        }
    } catch {}

    // Re-check every 60s for overdue
    setTimeout(checkScheduledNotifications, 60000);
}

// ── Expired job banner (Part 10) ────────────────────────────────
// Jobs that fell into 'expired' (overdue past the grace window while the
// Agent was offline) never auto-post — surface them so the user notices.
async function checkExpiredJobsBanner() {
    try {
        const expired = await agent.getExpiredJobs();
        const existing = document.getElementById('expiredBanner');
        if (!expired || !expired.length) {
            existing?.remove();
        } else if (existing) {
            existing.querySelector('span').textContent = `มีงานหมดเวลา ${expired.length} งาน — ระบบไม่โพสให้อัตโนมัติ`;
        } else {
            const b = document.createElement('div');
            b.id = 'expiredBanner';
            b.style.cssText = 'background:#fde8e8;border:1px solid #f5b5b5;border-radius:8px;padding:.5rem .85rem;margin:.4rem 0;font-size:12px;color:#c62828;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap';
            b.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
              <span>มีงานหมดเวลา ${expired.length} งาน — ระบบไม่โพสให้อัตโนมัติ</span>
              <button onclick="document.querySelector('.nav-item[data-tab=\\'jobs\\']')?.click(); filterJobs(document.querySelector('[data-filter=expired]'), 'expired')"
                style="background:#c62828;color:#fff;border:none;border-radius:5px;padding:.2rem .5rem;font-size:11px;cursor:pointer;font-family:inherit">ดูคิว</button>
              <button onclick="deleteAllExpiredJobs()" style="background:none;border:1px solid #c62828;color:#c62828;border-radius:5px;padding:.18rem .5rem;font-size:11px;cursor:pointer;font-family:inherit">ลบทั้งหมด</button>`;
            const logEl = document.getElementById('agentLog') || document.querySelector('.log-panel');
            if (logEl) logEl.parentNode.insertBefore(b, logEl);
        }
    } catch {}

    // Re-check every 60s regardless of outcome above
    setTimeout(checkExpiredJobsBanner, 60000);
}

async function deleteAllExpiredJobs() {
    const expired = await agent.getExpiredJobs().catch(() => []);
    if (!expired.length) return;
    if (!confirm(`ลบงานหมดเวลาทั้งหมด ${expired.length} รายการ? ลบแล้วกู้คืนไม่ได้`)) return;
    await Promise.all(expired.map(j => agent.deleteJob(j._id).catch(() => {})));
    _jobs = _jobs.filter(j => j.status !== 'expired');
    renderJobs();
    document.getElementById('expiredBanner')?.remove();
}
