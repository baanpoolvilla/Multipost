// ── State ────────────────────────────────────────────────────
let _accounts = [], _groups = [], _selected = [], _jobs = [], _jobFilter = 'all';
let _statusInterval = null;

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    setupPushEvents();
    await refreshStatus();
    await loadAccounts();
    await loadJobs();
    loadGroups();
    _statusInterval = setInterval(refreshStatus, 5000);
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
    document.getElementById('statRunner').textContent  = s.running ? 'กำลังทำงาน' : 'หยุด';

    setDot('dotApi',    true);
    setDot('dotDb',     s.dbConnected);
    setDot('dotRunner', s.running);
    document.getElementById('lblApi').textContent    = `API: :${s.apiPort}`;
    document.getElementById('lblDb').textContent     = s.dbConnected ? 'DB: Connected' : 'DB: Offline';
    document.getElementById('lblRunner').textContent = s.running ? 'Runner: กำลังทำ' : 'Runner: หยุด';

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
    appendLog('[▶] Runner เริ่มทำงาน');
}
async function stopRunner() {
    await agent.stopRunner();
    setRunnerUI(false);
    appendLog('[⏹] Runner หยุดแล้ว');
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
    if (!_accounts.length) { el.innerHTML='<div class="empty-state">ยังไม่มี Account</div>'; return; }
    el.innerHTML = _accounts.map(a => {
        const init = a.email[0].toUpperCase();
        const ts   = a.loginedAt ? fmtDate(a.loginedAt) : '—';
        return `
          <div class="acc-item">
            <div class="acc-avatar">${init}</div>
            <div class="acc-info">
              <div class="acc-email">${esc(a.email)}</div>
              <div class="acc-meta">Login: ${ts}</div>
            </div>
            <span class="acc-status ${a.status}">${statusAccTH(a.status)}</span>
            <button class="btn btn-primary" style="font-size:11px;padding:.3rem .65rem;margin-left:.4rem"
              onclick="loginAcc('${a.id}')">Login</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .65rem"
              onclick="logoutAcc('${a.id}')" ${a.status!=='logged_in'?'disabled':''}>Logout</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)"
              onclick="removeAcc('${a.id}')">🗑</button>
          </div>`;
    }).join('');
}

function updateAccountSelect() {
    const sel = document.getElementById('jobAccount');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Auto (account ที่ login อยู่)</option>';
    _accounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id; opt.textContent = a.email;
        if (a.status==='logged_in') opt.textContent += ' ✓';
        sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
}

function toggleAddAccount() {
    const f = document.getElementById('addAccountForm');
    f.style.display = f.style.display==='none' ? '' : 'none';
}

async function addAccount() {
    const email = document.getElementById('accEmail').value.trim();
    const pass  = document.getElementById('accPassword').value;
    if (!email||!pass) { alert('กรุณากรอกข้อมูลให้ครบ'); return; }
    const res = await agent.addAccount(email, pass);
    if (res.error) { alert(res.error); return; }
    document.getElementById('accEmail').value = '';
    document.getElementById('accPassword').value = '';
    toggleAddAccount();
    await loadAccounts();
    appendLog(`[✅] เพิ่ม Account: ${email}`);
}

async function removeAcc(id) {
    if (!confirm('ลบ account นี้?')) return;
    await agent.removeAccount(id);
    await loadAccounts();
}

async function loginAcc(id) {
    appendLog('[🔑] กำลัง Login...');
    const res = await agent.loginAccount(id);
    if (res.ok) appendLog('[✅] '+res.message);
    else appendLog('[❌] '+(res.error||'Login ไม่สำเร็จ'));
    await loadAccounts();
}

async function logoutAcc(id) {
    await agent.logoutAccount(id);
    await loadAccounts();
    appendLog('[⏹] Logout แล้ว');
}

// ── Groups ────────────────────────────────────────────────────
async function loadGroups() {
    const el = document.getElementById('groupPickList');
    el.innerHTML = '<div class="loading">กำลังโหลด...</div>';
    _groups = await agent.getGroups();
    _selected = _groups.map(() => true);
    renderGroupsInline();
}

function renderGroupsInline() {
    const el    = document.getElementById('groupPickList');
    const badge = document.getElementById('groupCountBadge');
    if (badge) badge.textContent = _groups.length || '';
    if (!_groups.length) {
        el.innerHTML = '<div class="empty-list">ไม่มีกลุ่ม — เพิ่มในเว็บก่อน</div>';
        document.getElementById('showMoreGroupsBtn').style.display = 'none';
        return;
    }
    const show = _groups.slice(0, 5);
    el.innerHTML = show.map((g, i) => `
      <div class="pick-item" onclick="togGrp(${i})">
        <input type="checkbox" id="g_${i}" ${_selected[i]?'checked':''} onchange="_selected[${i}]=this.checked">
        <label for="g_${i}">${esc(g.groupName)}</label>
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
        <input type="checkbox" id="gm_${i}" ${_selected[i]?'checked':''} onchange="_selected[${i}]=this.checked;_syncInline(${i})">
        <label for="gm_${i}">${esc(g.groupName)}</label>
      </div>`).join('');
}

function _syncInline(i) { const c=document.getElementById(`g_${i}`); if(c) c.checked=_selected[i]; }

function openGroupsModal()  { renderGroupsModal(); document.getElementById('groupsModal').style.display='flex'; }
function closeGroupsModal(e){ if(!e||e.target===document.getElementById('groupsModal')) document.getElementById('groupsModal').style.display='none'; }

function togGrp(i) { _selected[i]=!_selected[i]; const c=document.getElementById(`g_${i}`); if(c) c.checked=_selected[i]; }
function togGrpM(i){ _selected[i]=!_selected[i]; const c=document.getElementById(`gm_${i}`); if(c) c.checked=_selected[i]; _syncInline(i); }

function selAll()  { _selected=_selected.map(()=>true);  renderGroupsInline(); renderGroupsModal(); }
function selNone() { _selected=_selected.map(()=>false); renderGroupsInline(); renderGroupsModal(); }
function selectedGroups() { return _groups.filter((_,i)=>_selected[i]); }

// ── Recent posts ──────────────────────────────────────────────
async function loadRecentPosts() {
    const el = document.getElementById('recentPostsList');
    el.innerHTML = '<div class="loading">กำลังโหลด...</div>';
    const posts = await agent.getRecentPosts();
    if (!posts.length) { el.innerHTML='<div class="empty-list">ยังไม่มีโพสต์</div>'; return; }
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
    renderJobs();
}

function filterJobs(btn, filter) {
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _jobFilter = filter;
    renderJobs();
}

function renderJobs() {
    const el = document.getElementById('jobsList');
    const filtered = _jobFilter==='all' ? _jobs : _jobs.filter(j=>j.status===_jobFilter);
    const pending = _jobs.filter(j=>j.status==='pending').length;
    const badge = document.getElementById('pendingBadge');
    if (pending>0) { badge.textContent=pending; badge.style.display=''; }
    else badge.style.display='none';

    if (!filtered.length) { el.innerHTML='<div class="empty-state">ไม่มี Job</div>'; return; }
    const icons = { pending:'⏳', running:'🔄', done:'✅', failed:'❌' };
    el.innerHTML = filtered.map(j=>{
        const ok  = (j.results||[]).filter(r=>r.status==='success').length;
        const tot = j.groups?.length||0;
        const meta = (j.status==='done'||j.status==='failed') ? `${ok}/${tot} กลุ่ม` : `${tot} กลุ่ม · ${j.delaySeconds}s`;
        return `<div class="job-item">
          <div class="job-icon">${icons[j.status]||'❓'}</div>
          <div class="job-body">
            <div class="job-msg">${esc(j.message)}</div>
            <div class="job-meta">${meta} · ${fmtDate(j.createdAt)}</div>
          </div>
          <span class="job-status ${j.status}">${statusJobTH(j.status)}</span>
          <button class="job-del" onclick="deleteJob('${j._id}')">🗑</button>
        </div>`;
    }).join('');
}

function toggleCreateJob() {
    const f = document.getElementById('createJobForm');
    f.style.display = f.style.display==='' ? 'none' : '';
}

async function createJob() {
    const msg    = document.getElementById('jobMsg').value.trim();
    const groups = selectedGroups();
    const delay  = parseInt(document.getElementById('jobDelay').value)||5;
    const accId  = document.getElementById('jobAccount').value||null;

    if (!msg)         { alert('กรุณากรอกข้อความ'); return; }
    if (!groups.length){ alert('กรุณาเลือกอย่างน้อย 1 กลุ่ม'); return; }

    const job = await agent.createJob({ message:msg, groups, delaySeconds:delay, accountId:accId||undefined });
    if (job) {
        _jobs.unshift(job); renderJobs();
        document.getElementById('jobMsg').value = '';
        toggleCreateJob();
        appendLog(`[📋] สร้าง Job: "${msg.slice(0,40)}..." → ${groups.length} กลุ่ม`);
    }
}

async function deleteJob(id) {
    await agent.deleteJob(id);
    _jobs = _jobs.filter(j=>j._id!==id);
    renderJobs();
}

// ── Templates ─────────────────────────────────────────────────
let _templates = [];

async function loadTemplates() {
    _templates = await agent.listTemplates();
    renderTemplates();
}

function renderTemplates() {
    const el = document.getElementById('templatesList');
    if (!_templates.length) { el.innerHTML='<div class="empty-state">ยังไม่มี Template</div>'; return; }
    el.innerHTML = _templates.map(t => `
      <div class="tpl-item">
        <div class="tpl-info">
          <div class="tpl-name">${esc(t.name||'ไม่มีชื่อ')}</div>
          <div class="tpl-meta">${(t.groups||[]).length} กลุ่ม · delay ${t.delaySeconds}s</div>
        </div>
        <button class="btn btn-primary" style="font-size:11px;padding:.3rem .6rem" onclick="applyTemplate('${t.id}')">ใช้</button>
        <button class="btn btn-secondary" style="font-size:11px;padding:.3rem .5rem;color:var(--red)" onclick="removeTemplate('${t.id}')">🗑</button>
      </div>`).join('');
}

function toggleTemplates() {
    const p = document.getElementById('templatesPanel');
    if (p.style.display === 'none') { loadTemplates(); p.style.display = ''; }
    else p.style.display = 'none';
}

async function saveTemplate() {
    const name = document.getElementById('templateName').value.trim() || `Template ${_templates.length+1}`;
    const msg  = document.getElementById('jobMsg').value.trim();
    const grps = selectedGroups();
    const del  = parseInt(document.getElementById('jobDelay').value)||5;
    if (!msg && !grps.length) { alert('กรุณากรอกข้อความหรือเลือกกลุ่มก่อน'); return; }
    _templates = await agent.saveTemplate({ name, message:msg, groups:grps, delaySeconds:del });
    renderTemplates();
    document.getElementById('templateName').value = '';
    appendLog(`[💾] บันทึก Template: "${name}"`);
}

function applyTemplate(id) {
    const t = _templates.find(x=>x.id===id);
    if (!t) return;
    document.getElementById('jobMsg').value   = t.message || '';
    document.getElementById('jobDelay').value = t.delaySeconds || 5;
    _selected = _groups.map(g => (t.groups||[]).some(tg=>tg.groupId===g.groupId));
    renderGroupsInline();
    // Show create form if hidden
    const f = document.getElementById('createJobForm');
    if (f.style.display==='none') f.style.display='';
    document.getElementById('templatesPanel').style.display='none';
    appendLog(`[📁] โหลด Template: "${t.name}"`);
}

async function removeTemplate(id) {
    if (!confirm('ลบ Template นี้?')) return;
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
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(iso){ try{ return new Date(iso).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour12:false,dateStyle:'short',timeStyle:'short'}); }catch{return iso||'';} }
function fmtUptime(s){ if(!s)return'—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}m`:`${m}m`; }
function statusAccTH(s){ return {logged_in:'Login แล้ว',logged_out:'Logout',error:'Error'}[s]||s; }
function statusJobTH(s){ return {pending:'รอ',running:'กำลังทำ',done:'เสร็จ',failed:'ล้มเหลว'}[s]||s; }
