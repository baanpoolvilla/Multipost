// ── State ────────────────────────────────────────────────────
const _timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
let _accounts = [], _groups = [], _selected = [], _jobs = [], _jobFilter = 'all', _jobsVisible = 20;
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

    let _jobRefreshing = false;
    setInterval(async () => {
        if (_jobRefreshing) return;
        _jobRefreshing = true;
        try {
            const fresh = await agent.listJobs();
            if (JSON.stringify(fresh.map(j=>j._id+j.status)) !== JSON.stringify(_jobs.map(j=>j._id+j.status))) {
                _jobs = fresh;
                renderJobs();
            }
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
    renderJobs();
}

function renderJobs() {
    const el = document.getElementById('jobsList');
    const filtered = _jobFilter==='all' ? _jobs : _jobs.filter(j=>j.status===_jobFilter);
    const pending = _jobs.filter(j=>j.status==='pending').length;
    const badge = document.getElementById('pendingBadge');
    if (pending>0) { badge.textContent=pending; badge.style.display=''; }
    else badge.style.display='none';

    if (!filtered.length) { el.innerHTML='<div class="empty-state">ยังไม่มีรายการโพส</div>'; return; }
    const icons = { pending:'⏳', running:'🔄', done:'✅', failed:'❌' };
    const shown = filtered.slice(0, _jobsVisible);
    let html = shown.map(j=>{
        const ok  = (j.results||[]).filter(r=>r.status==='success').length;
        const tot = j.groups?.length||0;
        const pageTag = j.postAsPage ? ` · 🏢 ${esc(j.postAsPage)}` : '';
        const meta = (j.status==='done'||j.status==='failed') ? `${ok}/${tot} กลุ่ม${pageTag}` : `${tot} กลุ่ม · ${j.delaySeconds}s${pageTag}`;
        const { display, modeTag } = _parseJobMsg(j.message);
        const imgBadge = (j.images||[]).length > 0 ? `<span style="font-size:10px;background:#e7f3ff;color:#1877f2;border-radius:4px;padding:.05rem .4rem;margin-left:.3rem">📸 ${j.images.length}</span>` : '';
        return `<div class="job-item">
          <div class="job-icon">${icons[j.status]||'❓'}</div>
          <div class="job-body">
            <div class="job-msg">${modeTag ? `<span class="job-mode-tag">${modeTag}</span> ` : ''}${esc(display)}${imgBadge}</div>
            <div class="job-meta">${meta} · ${fmtDate(j.createdAt)}</div>
          </div>
          <span class="job-status ${j.status}">${statusJobTH(j.status)}</span>
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

    const job = await agent.createJob({ message:msg, groups, delaySeconds:delay, accountId:accId||undefined, postAsPage:postAs||undefined, images:imagePaths });
    if (job) {
        _jobs.unshift(job); renderJobs();
        document.getElementById('jobMsg').value = '';
        // Reset attachments
        _selectedImages.forEach(i => URL.revokeObjectURL(i.url));
        _selectedImages = [];
        document.getElementById('photoPreviewRow').style.display = 'none';
        const _n = document.getElementById('videoLocalNotice');
        if (_n) _n.style.display = 'none';
        document.querySelectorAll('.pick-item.selected').forEach(e => e.classList.remove('selected'));
        const info = [groups.length + ' กลุ่ม', postAs ? postAs : null, imagePaths.length ? imagePaths.length+' รูป' : null].filter(Boolean).join(' · ');
        appendLog(`[📋] สร้างคิวโพสแล้ว: "${msg.slice(0,40)}..." → ${info}`);
        document.querySelector('.nav-item[data-tab="jobs"]')?.click();
    }
}

async function deleteJob(id) {
    await agent.deleteJob(id);
    _jobs = _jobs.filter(j=>j._id!==id);
    renderJobs();
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

function renderTemplates() {
    const el = document.getElementById('templatesList');
    if (!_templates.length) { el.innerHTML='<div class="empty-state">ยังไม่มีเทมเพลตที่บันทึก</div>'; return; }
    el.innerHTML = _templates.map(t => {
        const hasLocalVid  = (t.images||[]).some(p => p.startsWith('localpath::'));
        const cloudCount   = (t.images||[]).filter(p => p.startsWith('http')).length;
        const localImgCount = (t.images||[]).filter(p => !p.startsWith('localpath::') && !p.startsWith('http')).length;
        const imgCount     = cloudCount + localImgCount;
        let meta = `${(t.groups||[]).length} กลุ่ม · หน่วง ${t.delaySeconds} วิ/กลุ่ม`;
        if (imgCount)    meta += ` · 🖼 ${imgCount}`;
        if (cloudCount)  meta += ` · <span style="color:#27ae60">☁️ Cloud</span>`;
        if (hasLocalVid) meta += ` · <span style="color:#e67e22">🎬 วิดีโอ ต้องอัพโหลดใหม่ทุกครั้ง</span>`;
        return `
      <div class="tpl-item">
        <div class="tpl-info">
          <div class="tpl-name">${esc(t.name||'ไม่มีชื่อ')}</div>
          <div class="tpl-meta">${meta}</div>
        </div>
        <button class="btn btn-primary" style="font-size:11px;padding:.3rem .6rem" onclick="applyTemplate('${t.id}')">ใช้รูปแบบนี้</button>
        <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)" onclick="removeTemplate('${t.id}')" title="ลบรูปแบบนี้">🗑</button>
      </div>`;
    }).join('');
}

function toggleTemplates() {
    const p = document.getElementById('templatesPanel');
    if (p.style.display === 'none') { loadTemplates(); p.style.display = ''; }
    else p.style.display = 'none';
}

async function saveTemplate() {
    const name   = document.getElementById('templateName').value.trim() || `Template ${_templates.length+1}`;
    const msg    = document.getElementById('jobMsg').value.trim();
    const grps   = selectedGroups();
    const del    = parseInt(document.getElementById('jobDelay').value)||5;
    const postAs = _selectedPage || null;
    const imgs   = _selectedImages.filter(i => !i.uploading).map(i => i.path).filter(Boolean);
    if (!msg && !grps.length) { alert('กรุณากรอกข้อความหรือเลือกกลุ่มก่อนบันทึกรูปแบบ'); return; }
    _templates = await agent.saveTemplate({ name, message:msg, groups:grps, delaySeconds:del, postAsPage:postAs||undefined, images: imgs });
    renderTemplates();
    document.getElementById('templateName').value = '';
    appendLog(`[💾] บันทึกเทมเพลต: "${name}"${imgs.length ? ` · ${imgs.length} รูป` : ''}`);
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

async function removeTemplate(id) {
    if (!confirm('ต้องการลบรูปแบบโพสนี้หรือไม่?')) return;
    _templates = await agent.deleteTemplate(id);
    renderTemplates();
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
function statusJobTH(s){ return {pending:'รอดำเนินการ',running:'กำลังโพส',done:'สำเร็จ',failed:'ล้มเหลว'}[s]||s; }
