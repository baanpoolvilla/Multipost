// ── State ────────────────────────────────────────────────────
const _timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
let _accounts = [], _groups = [], _selected = [], _jobs = [], _jobFilter = 'all', _jobsVisible = 20;
let _statusInterval = null;
let _selectedPage = null;
let _recentLoaded = false;
let _selectedImages = [];   // array of { path, url } (path = fs path, url = objectURL)

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

function renderAccounts() {
    const el = document.getElementById('accountsList');
    document.getElementById('accCount').textContent = _accounts.length;
    if (!_accounts.length) { el.innerHTML='<div class="empty-state">ยังไม่มีบัญชี — กด "+ เพิ่มบัญชี" ด้านบน</div>'; return; }
    el.innerHTML = _accounts.map(a => {
        const init = a.email[0].toUpperCase();
        const ts   = a.loginedAt ? fmtDate(a.loginedAt) : '—';
        return `
          <div class="acc-item">
            <div class="acc-avatar">${init}</div>
            <div class="acc-info">
              <div class="acc-email">${esc(a.email)}</div>
              <div class="acc-meta">เข้าสู่ระบบล่าสุด: ${ts}</div>
            </div>
            <span class="acc-status ${a.status}">${statusAccTH(a.status)}</span>
            <button class="btn btn-primary" style="font-size:11px;padding:.3rem .65rem;margin-left:.4rem"
              onclick="loginAcc('${a.id}')">เข้าสู่ระบบ</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .65rem"
              onclick="logoutAcc('${a.id}')" ${a.status!=='logged_in'?'disabled':''}>ออกจากระบบ</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)"
              onclick="removeAcc('${a.id}')" title="ลบบัญชี">🗑</button>
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
}

async function removeAcc(id) {
    if (!confirm('ต้องการลบบัญชีนี้ออกหรือไม่?')) return;
    await agent.removeAccount(id);
    await loadAccounts();
}

async function loginAcc(id) {
    appendLog('[🔑] กำลังเข้าสู่ระบบ Facebook...');
    const res = await agent.loginAccount(id);
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

// Smart refresh — preserves current selections, only re-renders on change
async function refreshGroupsSilent() {
    const fresh = await agent.getGroups();
    if (fresh.length === _groups.length &&
        fresh.every((g, i) => g.groupId === _groups[i]?.groupId)) return;
    const prevMap = new Map(_groups.map((g, i) => [g.groupId, _selected[i]]));
    _groups   = fresh;
    _selected = fresh.map(g => prevMap.has(g.groupId) ? prevMap.get(g.groupId) : true);
    renderGroupsInline();
    updateGroupCount();
}

function renderGroupsInline() {
    const el    = document.getElementById('groupPickList');
    if (!_groups.length) {
        el.innerHTML = '<div class="empty-list">ยังไม่มีกลุ่ม — กรุณาเพิ่มกลุ่มในเว็บแอปก่อน</div>';
        document.getElementById('showMoreGroupsBtn').style.display = 'none';
        return;
    }
    const show = _groups.slice(0, 5);
    el.innerHTML = show.map((g, i) => `
      <div class="pick-item" onclick="togGrp(${i})">
        <label for="g_${i}">${esc(g.groupName)}</label>
        <input type="checkbox" id="g_${i}" ${_selected[i]?'checked':''} onchange="_selected[${i}]=this.checked">
      </div>`).join('');
    const moreBtn = document.getElementById('showMoreGroupsBtn');
    if (_groups.length > 5) {
        document.getElementById('showMoreCount').textContent = _groups.length;
        moreBtn.style.display = '';
    } else {
        moreBtn.style.display = 'none';
    }
}

function renderGroupsModal() {
    const el = document.getElementById('groupsModalList');
    if (!el) return;
    el.innerHTML = _groups.map((g, i) => `
      <div class="pick-item" onclick="togGrpM(${i})">
        <label for="gm_${i}">${esc(g.groupName)}</label>
        <input type="checkbox" id="gm_${i}" ${_selected[i]?'checked':''} onchange="_selected[${i}]=this.checked;_syncInline(${i})">
      </div>`).join('');
}

function _syncInline(i) { const c=document.getElementById(`g_${i}`); if(c) c.checked=_selected[i]; }

function openGroupsModal()  { renderGroupsModal(); document.getElementById('groupsModal').style.display='flex'; }
function closeGroupsModal(e){ if(!e||e.target===document.getElementById('groupsModal')) document.getElementById('groupsModal').style.display='none'; }

function togGrp(i) { _selected[i]=!_selected[i]; const c=document.getElementById(`g_${i}`); if(c) c.checked=_selected[i]; updateGroupCount(); }
function togGrpM(i){ _selected[i]=!_selected[i]; const c=document.getElementById(`gm_${i}`); if(c) c.checked=_selected[i]; _syncInline(i); updateGroupCount(); }

function selAll()  { _selected=_selected.map(()=>true);  renderGroupsInline(); renderGroupsModal(); updateGroupCount(); }
function selNone() { _selected=_selected.map(()=>false); renderGroupsInline(); renderGroupsModal(); updateGroupCount(); }
function selectedGroups() { return _groups.filter((_,i)=>_selected[i]); }

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
    const f = document.getElementById('createJobForm');
    const opening = f.style.display === 'none';
    f.style.display = opening ? '' : 'none';
    if (opening) updateGroupCount();
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

    const imagePaths = _selectedImages.map(i => i.path).filter(Boolean);

    const job = await agent.createJob({ message:msg, groups, delaySeconds:delay, accountId:accId||undefined, postAsPage:postAs||undefined, images:imagePaths });
    if (job) {
        _jobs.unshift(job); renderJobs();
        document.getElementById('jobMsg').value = '';
        // Reset attachments
        _selectedImages.forEach(i => URL.revokeObjectURL(i.url));
        _selectedImages = [];
        document.getElementById('photoPreviewRow').style.display = 'none';
        toggleCreateJob();
        const info = [groups.length + ' กลุ่ม', postAs ? postAs : null, imagePaths.length ? imagePaths.length+' รูป' : null].filter(Boolean).join(' · ');
        appendLog(`[📋] สร้างคิวโพสแล้ว: "${msg.slice(0,40)}..." → ${info}`);
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
    const n  = _selected.filter(Boolean).length;
    const el = document.getElementById('fbGroupCount');
    if (el) el.textContent = `เลือกแล้ว ${n} กลุ่ม`;
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

function onImageFilesSelected(input) {
    for (const file of input.files) {
        const url = URL.createObjectURL(file);
        _selectedImages.push({ path: file.path || '', url, name: file.name });
    }
    input.value = '';
    renderImagePreviews();
}

function removeImage(i) {
    URL.revokeObjectURL(_selectedImages[i].url);
    _selectedImages.splice(i, 1);
    renderImagePreviews();
}

function renderImagePreviews() {
    const row = document.getElementById('photoPreviewRow');
    if (!_selectedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
    row.style.display = 'flex';
    row.innerHTML = _selectedImages.map((img, i) => `
      <div class="fb-photo-thumb">
        <img src="${img.url}" alt="${esc(img.name)}">
        <button class="rm-btn" onclick="removeImage(${i})" title="ลบ">✕</button>
      </div>`).join('') +
      `<button class="fb-photo-add-btn" onclick="openImagePicker()" title="เพิ่มรูปอีก">+</button>`;
}

// ── Templates ─────────────────────────────────────────────────
let _templates = [];

async function loadTemplates() {
    _templates = await agent.listTemplates();
    renderTemplates();
}

function renderTemplates() {
    const el = document.getElementById('templatesList');
    if (!_templates.length) { el.innerHTML='<div class="empty-state">ยังไม่มีรูปแบบโพสที่บันทึก</div>'; return; }
    el.innerHTML = _templates.map(t => `
      <div class="tpl-item">
        <div class="tpl-info">
          <div class="tpl-name">${esc(t.name||'ไม่มีชื่อ')}</div>
          <div class="tpl-meta">${(t.groups||[]).length} กลุ่ม · หน่วง ${t.delaySeconds} วิ/กลุ่ม</div>
        </div>
        <button class="btn btn-primary" style="font-size:11px;padding:.3rem .6rem" onclick="applyTemplate('${t.id}')">ใช้รูปแบบนี้</button>
        <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)" onclick="removeTemplate('${t.id}')" title="ลบรูปแบบนี้">🗑</button>
      </div>`).join('');
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
    const imgs   = _selectedImages.map(i => i.path).filter(Boolean);
    if (!msg && !grps.length) { alert('กรุณากรอกข้อความหรือเลือกกลุ่มก่อนบันทึกรูปแบบ'); return; }
    _templates = await agent.saveTemplate({ name, message:msg, groups:grps, delaySeconds:del, postAsPage:postAs||undefined, images: imgs });
    renderTemplates();
    document.getElementById('templateName').value = '';
    appendLog(`[💾] บันทึกรูปแบบโพส: "${name}"${imgs.length ? ` · ${imgs.length} รูป` : ''}`);
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
    // Restore images from MongoDB data URLs (works on any machine)
    _selectedImages.forEach(i => { try { URL.revokeObjectURL(i.url); } catch {} });
    _selectedImages = (t.imageDataUrls || [])
        .filter(x => x.dataUrl)
        .map(x => ({ path: x.filename, url: x.dataUrl, name: x.filename }));
    renderImagePreviews();
    // Show create form if hidden
    const f = document.getElementById('createJobForm');
    if (f.style.display==='none') f.style.display='';
    document.getElementById('templatesPanel').style.display='none';
    appendLog(`[📁] โหลดรูปแบบโพส: "${t.name}"${_selectedImages.length ? ` · ${_selectedImages.length} รูป` : ''}`);
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

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(iso){ try{ return new Date(iso).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour12:false,dateStyle:'short',timeStyle:'short'}); }catch{return iso||'';} }
function fmtUptime(s){ if(!s)return'—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}m`:`${m}m`; }
function statusAccTH(s){ return {logged_in:'เข้าสู่ระบบแล้ว',logged_out:'ออกจากระบบ',error:'มีข้อผิดพลาด'}[s]||s; }
function statusJobTH(s){ return {pending:'รอดำเนินการ',running:'กำลังโพส',done:'สำเร็จ',failed:'ล้มเหลว'}[s]||s; }
