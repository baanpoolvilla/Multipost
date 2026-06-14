/* ═══════════════════════════════════════════
   Dashboard
═══════════════════════════════════════════ */
const messageEl   = document.getElementById('message');
const charCountEl = document.getElementById('charCount');
const imagePreview = document.getElementById('imagePreview');
const fileInput   = document.getElementById('fileInput');
const tagsBar     = document.getElementById('tagsBar');

let selectedFiles = [];

/* Char counter */
if (messageEl) {
  messageEl.addEventListener('input', () => {
    charCountEl.textContent = messageEl.value.length;
  });
}

/* Emoji */
function insertEmoji(emoji) {
  if (!messageEl) return;
  const s = messageEl.selectionStart, e = messageEl.selectionEnd;
  messageEl.value = messageEl.value.slice(0, s) + emoji + messageEl.value.slice(e);
  messageEl.selectionStart = messageEl.selectionEnd = s + emoji.length;
  messageEl.dispatchEvent(new Event('input'));
  messageEl.focus();
}

/* ── File validation helper ── */
const _ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|avi|webm)$/i;
const _IS_VID_EXT  = /\.(mp4|mov|avi|webm)$/i;
const _IMG_MAX_MB  = 4;    // Facebook Graph API photo limit
const _VID_MAX_MB  = 100;  // Server cap (Facebook allows up to 1 GB)
const _MAX_SIZE_MB = 100;  // legacy alias

function _checkFiles(incoming, alreadyHave, maxTotal) {
  const valid = [], problems = [];

  for (const f of incoming) {
    const isVid   = _IS_VID_EXT.test(f.name) || f.type.startsWith('video/');
    const sizeMB  = f.size / 1024 / 1024;
    const limitMB = isVid ? _VID_MAX_MB : _IMG_MAX_MB;

    if (!_ALLOWED_EXT.test(f.name)) {
      problems.push(`<b>${f.name}</b><br><span style="color:#888;font-size:.8rem">ไม่รองรับไฟล์ประเภทนี้ — รองรับเฉพาะ JPG, PNG, GIF, WebP, MP4, MOV, AVI, WebM</span>`);
    } else if (f.size > limitMB * 1024 * 1024) {
      const note = isVid
        ? `วิดีโอ: เซิร์ฟเวอร์จำกัดที่ ${_VID_MAX_MB} MB (Facebook รับสูงสุด 1 GB)`
        : `รูปภาพ: Facebook รับสูงสุด ${_IMG_MAX_MB} MB ต่อไฟล์`;
      problems.push(`<b>${f.name}</b> <span style="color:#e65100;font-weight:700">${sizeMB.toFixed(1)} MB</span><br><span style="color:#888;font-size:.8rem">เกินขนาดที่รับได้ — ${note}</span>`);
    } else {
      valid.push(f);
    }
  }

  const room = maxTotal - alreadyHave;
  if (valid.length > room) {
    const skipped = valid.splice(room);
    problems.push(`<b>${skipped.length} ไฟล์ถูกข้าม</b><br><span style="color:#888;font-size:.8rem">เกินจำนวนสูงสุด ${maxTotal} ไฟล์ต่อครั้ง</span>`);
  }

  if (problems.length) {
    Swal.fire({
      icon: 'warning',
      title: 'ไม่สามารถเพิ่มไฟล์บางรายการ',
      html: `<ul style="text-align:left;margin:.25rem 0 0;padding-left:1.1rem;list-style:disc">${problems.map(p => `<li style="margin:.45rem 0">${p}</li>`).join('')}</ul>
             <p style="margin-top:.75rem;font-size:.8rem;color:#65676b;border-top:1px solid #e4e6ea;padding-top:.6rem">
               📌 ขีดจำกัด Facebook: รูปภาพ <b>4 MB</b>/ไฟล์ · วิดีโอ <b>1 GB</b>/ไฟล์
             </p>`,
      confirmButtonColor: '#1877f2',
      confirmButtonText: 'ตกลง',
    });
  }

  return valid;
}

/* ── Image upload ── */
function triggerImage() { fileInput?.click(); }

if (fileInput) {
  fileInput.addEventListener('change', function () {
    const incoming = Array.from(this.files);
    this.value = '';
    const valid = _checkFiles(incoming, selectedFiles.length, 30);
    valid.forEach(file => {
      if (!selectedFiles.some(f => f.name === file.name && f.size === file.size))
        selectedFiles.push(file);
    });
    renderPreviews();
  });
}

function renderPreviews() {
  if (!imagePreview) return;
  if (!selectedFiles.length) { imagePreview.style.display = 'none'; imagePreview.innerHTML = ''; return; }
  imagePreview.style.display = 'grid';
  imagePreview.innerHTML = selectedFiles.map((f, i) => {
    const isVid = f.type.startsWith('video/');
    const thumb = isVid
      ? `<video src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover" muted playsinline></video>`
      : `<img src="${URL.createObjectURL(f)}" alt="">`;
    return `
    <div class="img-thumb">
      ${thumb}
      <button class="img-thumb-remove" type="button" onclick="removeImage(${i})">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>`;
  }).join('');
}

function removeImage(idx) { selectedFiles.splice(idx, 1); renderPreviews(); }

/* ── Page selector ── */
let selectedPageIds = new Set(
  typeof ALL_PAGES !== 'undefined' ? ALL_PAGES.map(p => p.pageId) : []
);

function togglePage(btn) {
  const id = btn.dataset.pageId;
  if (selectedPageIds.has(id)) { selectedPageIds.delete(id); btn.classList.remove('active'); }
  else                         { selectedPageIds.add(id);    btn.classList.add('active'); }
  syncAllChip(); updatePageCountLabel();
}

function toggleAllPages(btn) {
  const chips = [...document.querySelectorAll('.page-sel-chip[data-page-id]')];
  const allActive = btn.classList.contains('active');
  if (allActive) {
    selectedPageIds.clear();
    chips.forEach(c => c.classList.remove('active'));
    btn.classList.remove('active');
  } else {
    chips.forEach(c => { c.classList.add('active'); selectedPageIds.add(c.dataset.pageId); });
    btn.classList.add('active');
  }
  updatePageCountLabel();
}

/* ── Page popup selector (> 8 pages) ── */
async function openPagePopup() {
  if (typeof ALL_PAGES === 'undefined') return;
  const colors = ['purple','green','orange','blue','red'];

  const html = `
    <div style="display:flex;gap:.5rem;margin-bottom:.7rem">
      <button type="button" onclick="swalSelAll(true)"
        style="flex:1;padding:.4rem;background:#e7f0fd;color:#1877f2;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit">
        <i class="fa-solid fa-check-double"></i> เลือกทั้งหมด
      </button>
      <button type="button" onclick="swalSelAll(false)"
        style="flex:1;padding:.4rem;background:#f0f2f5;color:#65676b;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit">
        <i class="fa-solid fa-xmark"></i> ยกเลิกทั้งหมด
      </button>
    </div>
    <div style="display:flex;flex-direction:column;gap:.3rem;max-height:340px;overflow-y:auto;padding-right:2px">
      ${ALL_PAGES.map((p, i) => {
        const avatarColors = ['#7b2ff7','#2e7d32','#e65100','#1877f2','#c62828'];
        const checked = selectedPageIds.has(p.pageId) ? 'checked' : '';
        return `
          <label style="display:flex;align-items:center;gap:.6rem;padding:.45rem .6rem;border-radius:8px;cursor:pointer;border:1.5px solid ${checked ? '#1877f2' : '#e4e6ea'};background:${checked ? '#f0f5ff' : '#fff'};transition:all .12s" id="lbl-${p.pageId}">
            <input type="checkbox" id="pc-${p.pageId}" value="${p.pageId}" ${checked}
              onchange="swalChkChange('${p.pageId}',this)"
              style="width:16px;height:16px;accent-color:#1877f2;cursor:pointer;flex-shrink:0">
            <div style="width:28px;height:28px;border-radius:50%;background:${avatarColors[i%5]};display:flex;align-items:center;justify-content:center;color:#fff;font-size:.72rem;font-weight:700;flex-shrink:0">${p.pageName.slice(-1)}</div>
            <span style="flex:1;font-weight:600;font-size:.88rem">${p.pageName}</span>
            <span style="font-size:.72rem;color:#8a8d91;background:#f0f2f5;padding:.08rem .38rem;border-radius:4px">#${p.pageId}</span>
          </label>`;
      }).join('')}
    </div>`;

  await Swal.fire({
    title: '<i class="fa-solid fa-layer-group" style="color:#1877f2"></i> เลือกเพจที่จะโพสต์',
    html,
    showCancelButton: true,
    confirmButtonColor: '#1877f2',
    confirmButtonText: 'ยืนยันการเลือก',
    cancelButtonText: 'ยกเลิก',
    width: 460,
    didOpen: () => updateSwalCount(),
    preConfirm: () => {
      const checked = [...document.querySelectorAll('[id^="pc-"]:checked')].map(cb => cb.value);
      if (!checked.length) { Swal.showValidationMessage('กรุณาเลือกเพจอย่างน้อย 1 เพจ'); return false; }
      return checked;
    },
  }).then(result => {
    if (!result.isConfirmed) return;
    selectedPageIds = new Set(result.value);
    // sync visible chips (first 8)
    document.querySelectorAll('.page-sel-chip[data-page-id]').forEach(chip => {
      chip.classList.toggle('active', selectedPageIds.has(chip.dataset.pageId));
    });
    syncAllChip();
    updatePageCountLabel();
    updateMoreChip();
  });
}

function swalSelAll(select) {
  ALL_PAGES.forEach(p => {
    const cb = document.getElementById(`pc-${p.pageId}`);
    const lbl = document.getElementById(`lbl-${p.pageId}`);
    if (cb) {
      cb.checked = select;
      if (lbl) { lbl.style.borderColor = select ? '#1877f2' : '#e4e6ea'; lbl.style.background = select ? '#f0f5ff' : '#fff'; }
    }
  });
  updateSwalCount();
}

function swalChkChange(pageId, cb) {
  const lbl = document.getElementById(`lbl-${pageId}`);
  if (lbl) { lbl.style.borderColor = cb.checked ? '#1877f2' : '#e4e6ea'; lbl.style.background = cb.checked ? '#f0f5ff' : '#fff'; }
  updateSwalCount();
}

function updateSwalCount() {
  const count = document.querySelectorAll('[id^="pc-"]:checked').length;
  const btn = document.querySelector('.swal2-confirm');
  if (btn) btn.textContent = `ยืนยัน ${count} เพจ`;
}

function updateMoreChip() {
  const chip = document.getElementById('morePageChip');
  if (!chip || typeof ALL_PAGES === 'undefined') return;
  const extraPages = ALL_PAGES.slice(8);
  const selectedExtra = extraPages.filter(p => selectedPageIds.has(p.pageId)).length;
  const label = document.getElementById('morePageChipLabel');
  if (selectedExtra > 0) {
    chip.classList.add('has-selected');
    if (label) label.textContent = `${selectedExtra}/${extraPages.length} เพจ ✓`;
  } else {
    chip.classList.remove('has-selected');
    if (label) label.textContent = `+ ${extraPages.length} เพจ`;
  }
}

function syncAllChip() {
  const total = document.querySelectorAll('.page-sel-chip[data-page-id]').length;
  const allChip = document.querySelector('.all-chip');
  if (!allChip) return;
  allChip.classList.toggle('active', selectedPageIds.size === total);
}

function updatePageCountLabel() {
  const el = document.getElementById('pageCountLabel');
  if (!el) return;
  let label = `โพสต์ไปยัง ${selectedPageIds.size} เพจ`;
  if (_shareGroupIds.size > 0) label += ` · แชร์ ${_shareGroupIds.size} กลุ่ม`;
  el.textContent = label;
  updateMoreChip();
}

async function removePage(pageId, chipEl) {
  const { isConfirmed } = await Swal.fire({
    title: 'ปิดใช้งานเพจนี้?',
    text: 'เปิดใหม่ได้ที่ปุ่ม +',
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#c62828',
    cancelButtonColor: '#65676b',
    confirmButtonText: 'ปิดใช้งาน',
    cancelButtonText: 'ยกเลิก',
  });
  if (!isConfirmed) return;
  try {
    const r = await fetch(`/pages/${pageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    if (!r.ok) throw new Error();
    chipEl.remove();
    selectedPageIds.delete(pageId);
    if (typeof ALL_PAGES !== 'undefined') {
      const idx = ALL_PAGES.findIndex(p => p.pageId === pageId);
      if (idx !== -1) {
        const [removed] = ALL_PAGES.splice(idx, 1);
        if (typeof DISABLED_PAGES !== 'undefined') DISABLED_PAGES.push(removed);
      }
    }
    syncAllChip();
    updatePageCountLabel();
    _renderSidebarPages();
  } catch { Swal.fire({ icon: 'error', title: 'ไม่สามารถปิดใช้งานเพจได้', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' }); }
}

function _renderSidebarPages() {
  const container = document.getElementById('sidebarPagesList');
  if (!container || typeof ALL_PAGES === 'undefined') return;
  const colors  = ['purple','green','orange','blue','red'];
  const visible = ALL_PAGES.slice(0, 5);
  const extra   = ALL_PAGES.slice(5);

  const pageItem = (p, i) => `
    <div class="sidebar-item">
      <div class="avatar avatar-${colors[i%5]} avatar-xs">${p.pageName.slice(-1)}</div>
      <span style="flex:1">${p.pageName}</span>
      ${(p.groups||[]).length > 0 ? `<span style="background:#e7f3ff;color:#1877f2;border-radius:999px;font-size:.65rem;padding:.05rem .38rem;font-weight:700;flex-shrink:0">${p.groups.length}กลุ่ม</span>` : ''}
    </div>`;

  let html = visible.map((p, i) => pageItem(p, i)).join('');

  if (extra.length > 0) {
    html += `
      <div class="sidebar-item" id="showMoreBtn" onclick="toggleMorePages()" style="color:#65676b">
        <i class="fa-solid fa-chevron-down" id="moreChevron"></i>
        <span>เพิ่มเติม ${extra.length} เพจ</span>
      </div>
      <div id="morePagesList" style="display:none">
        ${extra.map((p, i) => pageItem(p, i + 5)).join('')}
      </div>`;
  }

  container.innerHTML = html;
}

function _buildAddPageHtml() {
  if (!DISABLED_PAGES.length)
    return '<p style="text-align:center;color:#8a8d91;padding:1.2rem 0">เพจทั้งหมดเปิดใช้งานอยู่แล้ว</p>';
  const colors = ['#7b2ff7','#2e7d32','#e65100','#1877f2','#c62828'];
  return `<div style="display:flex;flex-direction:column;gap:.4rem;max-height:320px;overflow-y:auto;padding-right:2px">
    ${DISABLED_PAGES.map((p, i) => `
      <div style="display:flex;align-items:center;gap:.65rem;padding:.5rem .65rem;border-radius:8px;background:#f8f9fa;border:1.5px solid #e4e6ea">
        <div style="width:28px;height:28px;border-radius:50%;background:${colors[i%5]};display:flex;align-items:center;justify-content:center;color:#fff;font-size:.72rem;font-weight:700;flex-shrink:0">${p.pageName.slice(-1)}</div>
        <span style="flex:1;font-weight:600;font-size:.88rem;text-align:left">${p.pageName}</span>
        <button onclick="enablePage('${p.pageId}')"
          style="background:#1877f2;color:#fff;border:none;border-radius:7px;padding:.32rem .75rem;font-size:.78rem;cursor:pointer;font-family:inherit;font-weight:700;flex-shrink:0">
          <i class="fa-solid fa-plus"></i> เพิ่ม
        </button>
      </div>`).join('')}
  </div>`;
}

function openAddPagePopup() {
  if (typeof DISABLED_PAGES === 'undefined') return;
  Swal.fire({
    title: '<i class="fa-solid fa-layer-group" style="color:#1877f2"></i> เพิ่มเพจ',
    html: _buildAddPageHtml(),
    showConfirmButton: false,
    showCloseButton: true,
    width: 420,
  });
}

function _addPageChip(page) {
  const addChip = document.querySelector('.add-page-chip');
  if (!addChip) return;
  const colors = ['purple','green','orange','blue','red'];
  const colorClass = colors[(ALL_PAGES.length - 1) % 5];
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'page-sel-chip active';
  chip.dataset.pageId = page.pageId;
  chip.onclick = function() { togglePage(this); };
  chip.innerHTML = `<div class="avatar avatar-${colorClass}" style="width:16px;height:16px;font-size:.55rem;flex-shrink:0">${page.pageName.slice(-1)}</div>${page.pageName}<span class="chip-remove" onclick="event.stopPropagation();removePage('${page.pageId}',this.closest('.page-sel-chip'))" title="ปิดใช้งานเพจนี้">×</span>`;
  addChip.parentNode.insertBefore(chip, addChip);
  selectedPageIds.add(page.pageId);
  syncAllChip();
  updatePageCountLabel();
}

async function enablePage(pageId) {
  try {
    const r = await fetch(`/pages/${pageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (!r.ok) throw new Error();
    const idx = DISABLED_PAGES.findIndex(p => p.pageId === pageId);
    if (idx !== -1) {
      const [page] = DISABLED_PAGES.splice(idx, 1);
      ALL_PAGES.push(page);
      _addPageChip(page);
      _renderSidebarPages();
    }
    if (DISABLED_PAGES.length === 0) {
      Swal.fire({ icon: 'success', title: 'เพิ่มเพจแล้ว!', timer: 1200, showConfirmButton: false });
    } else {
      const container = Swal.getHtmlContainer();
      if (container) container.innerHTML = _buildAddPageHtml();
    }
  } catch {
    Swal.fire({ icon: 'error', title: 'ไม่สามารถเพิ่มเพจได้', text: 'กรุณาลองใหม่อีกครั้ง', confirmButtonColor: '#1877f2' });
  }
}

/* ── Share-to-groups selector ── */
let _shareGroupIds   = new Set();
let _shareGroupsData = [];   // [{groupId, groupName}]

function toggleShareGroupChip(btn) {
  const id   = btn.dataset.groupId;
  const name = btn.dataset.groupName;
  if (_shareGroupIds.has(id)) {
    _shareGroupIds.delete(id);
    _shareGroupsData = _shareGroupsData.filter(g => g.groupId !== id);
    btn.classList.remove('active');
  } else {
    _shareGroupIds.add(id);
    if (!_shareGroupsData.find(x => x.groupId === id)) _shareGroupsData.push({ groupId: id, groupName: name });
    btn.classList.add('active');
  }
  updatePageCountLabel();
}

/* ── Sidebar show more ── */
function toggleMorePages() {
  const list    = document.getElementById('morePagesList');
  const btn     = document.getElementById('showMoreBtn');
  const chevron = document.getElementById('moreChevron');
  const open    = list.style.display === 'block';
  list.style.display  = open ? 'none' : 'block';
  chevron.className   = open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
  btn.querySelector('span').textContent = open
    ? `เพิ่มเติม ${list.children.length} เพจ`
    : 'ซ่อน';
}

/* ── Tags bar ── */
function updateTagsBar() {
  if (!tagsBar) return;
  const fe = document.getElementById('feelingEmoji')?.value;
  const fl = document.getElementById('feelingLabel')?.value;
  let html = '';
  if (fe) html += `<span class="composer-tag">${fe} รู้สึก${fl}<button onclick="clearFeeling()" type="button"><i class="fa-solid fa-xmark"></i></button></span>`;
  tagsBar.innerHTML = html;
  tagsBar.style.display = html ? 'flex' : 'none';
}

function clearFeeling()  { document.getElementById('feelingEmoji').value = ''; document.getElementById('feelingLabel').value = ''; updateTagsBar(); }

/* ── Feeling picker ── */
const FEELINGS = [
  {e:'😊',l:'มีความสุข'},{e:'😍',l:'ตื่นเต้น'},{e:'🥰',l:'รัก'},{e:'🎉',l:'ฉลอง'},
  {e:'😢',l:'เศร้า'},{e:'😡',l:'โกรธ'},{e:'😴',l:'เหนื่อย'},{e:'😎',l:'เท่มาก'},
  {e:'🤩',l:'ทึ่ง'},{e:'🙏',l:'ขอบคุณ'},{e:'😤',l:'หงุดหงิด'},{e:'🤔',l:'ครุ่นคิด'},
];

function openFeelingPicker() {
  Swal.fire({
    title: '<i class="fa-solid fa-face-smile" style="color:#f7b928"></i> คุณรู้สึกอย่างไร?',
    html: `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px">
      ${FEELINGS.map(f => `
        <button onclick="chooseFeel('${f.e}','${f.l}')"
          style="background:#f0f2f5;border:1px solid #e4e6ea;border-radius:10px;padding:10px 4px;
                 cursor:pointer;font-family:inherit"
          onmouseover="this.style.background='#e7f0fd'" onmouseout="this.style.background='#f0f2f5'">
          <div style="font-size:1.5rem">${f.e}</div>
          <div style="font-size:.72rem;margin-top:3px">${f.l}</div>
        </button>`).join('')}
    </div>`,
    showConfirmButton: false,
    showCloseButton: true,
    width: 400,
  });
}

function chooseFeel(e, l) {
  document.getElementById('feelingEmoji').value = e;
  document.getElementById('feelingLabel').value = l;
  updateTagsBar(); Swal.close();
}

/* ═══════════════════════════════════════════
   Submit
═══════════════════════════════════════════ */
async function submitPost() {
  const msg     = messageEl?.value.trim();
  const schedAt = document.getElementById('scheduledAt')?.value || '';
  const delay   = parseInt(document.getElementById('postDelay')?.value) || 0;

  if (!msg) {
    Swal.fire({ icon: 'warning', title: 'ยังไม่ได้กรอกข้อความ', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' });
    return;
  }
  if (selectedPageIds.size === 0) {
    Swal.fire({ icon: 'warning', title: 'กรุณาเลือกเพจอย่างน้อย 1 เพจ', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' });
    return;
  }
  if (schedAt && new Date(schedAt) <= new Date()) {
    Swal.fire({ icon: 'warning', title: 'กรุณาเลือกเวลาในอนาคต', confirmButtonColor: '#1877f2' });
    return;
  }

  const isScheduling = schedAt && new Date(schedAt) > new Date();
  const delayLabel   = delay > 0 ? ` (หน่วง ${delay}วิ/เพจ)` : '';

  Swal.fire({
    title: isScheduling ? 'กำลังตั้งเวลาโพส...' : 'กำลังส่งโพสต์...',
    html: `<i class="fa-brands fa-facebook" style="font-size:2rem;color:#1877f2"></i>
           <p style="margin-top:.7rem;color:#65676b">${isScheduling ? 'บันทึกตั้งเวลา...' : `กำลังโพสต์ไปยัง ${selectedPageIds.size} เพจ${delayLabel}`}</p>`,
    allowOutsideClick: false, allowEscapeKey: false, showConfirmButton: false,
    didOpen: () => Swal.showLoading(),
  });

  const fd = new FormData();
  fd.append('message',      msg);
  fd.append('feelingEmoji', document.getElementById('feelingEmoji')?.value || '');
  fd.append('feelingLabel', document.getElementById('feelingLabel')?.value || '');
  selectedPageIds.forEach(id => fd.append('selectedPages', id));
  _tplLoadedImages.forEach(name => fd.append('templateImages', name));
  if (_shareGroupsData.length > 0)
    fd.append('shareGroups', JSON.stringify(_shareGroupsData));
  selectedFiles.forEach(f => fd.append('images', f));
  if (schedAt) fd.append('scheduledAt', new Date(schedAt.slice(0,16) + ':00+07:00').toISOString());
  if (delay > 0) fd.append('postDelay', delay);

  try {
    const res = await fetch('/send', { method: 'POST', body: fd });

    let data;
    try { data = await res.json(); }
    catch {
      let errHtml;
      if (res.status === 413) {
        const totalMB = selectedFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
        const hasVideo = selectedFiles.some(f => /\.(mp4|mov|avi|webm)$/i.test(f.name));
        const fileRows = selectedFiles.length
          ? `<ul style="text-align:left;margin:.35rem 0 0;padding-left:1.1rem;list-style:disc;font-size:.85rem">${selectedFiles.map(f => `<li>${f.name} — <b>${(f.size/1024/1024).toFixed(1)} MB</b></li>`).join('')}</ul>`
          : '';
        if (hasVideo) {
          errHtml = `<p>ไม่สามารถอัปโหลดวิดีโอผ่านเว็บได้</p>
                     ${fileRows}
                     <div style="margin-top:.6rem;background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:.5rem .8rem;text-align:left;font-size:.82rem;color:#5d4037">
                       <b>สาเหตุ:</b> เซิร์ฟเวอร์ Vercel จำกัด request ไว้ที่ <b>4.5 MB</b> ต่อครั้ง<br>
                       <b>แนะนำ:</b> ใช้ <b>Desktop Agent</b> โพสวิดีโอโดยตรงจากคอมพิวเตอร์ได้เลย ไม่มีข้อจำกัดขนาด
                     </div>`;
        } else {
          errHtml = `<p>ขนาดไฟล์รวม <b>${totalMB.toFixed(1)} MB</b> เกินขีดจำกัดของเซิร์ฟเวอร์ (4.5 MB/request)</p>
                     ${fileRows}
                     <p style="margin-top:.6rem;font-size:.82rem;color:#65676b;border-top:1px solid #e4e6ea;padding-top:.5rem">
                       📌 อัปโหลดรูปภาพทีละไม่เกิน <b>4 MB/ไฟล์</b> และรวมทั้งหมดไม่เกิน <b>4.5 MB</b> ต่อการส่งโพสต์หนึ่งครั้ง
                     </p>`;
        }
      } else {
        errHtml = `เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (HTTP ${res.status}) กรุณาลองใหม่`;
      }
      Swal.fire({ icon: 'error', title: 'ส่งไม่สำเร็จ', html: errHtml, confirmButtonColor: '#1877f2' });
      return;
    }

    if (data.scheduled) {
      const dt = new Date(data.scheduledAt).toLocaleString('th-TH', { timeZone:'Asia/Bangkok', dateStyle:'short', timeStyle:'short' });
      const r2 = await Swal.fire({
        icon: 'success', title: 'ตั้งเวลาโพสแล้ว!',
        html: `<p style="color:#65676b">จะโพสต์อัตโนมัติวันที่ <strong>${dt}</strong></p>`,
        showCancelButton: true, confirmButtonText: 'ดูประวัติ',
        cancelButtonText: 'โพสต์ต่อ', confirmButtonColor: '#1877f2',
      });
      if (r2.isConfirmed) window.location.href = '/history';
      else { messageEl.value = ''; selectedFiles = []; document.getElementById('imagePreview').style.display='none'; }
    } else if (data.id) {
      window.location.href = `/result/${data.id}`;
    } else {
      Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: data.error || 'ลองใหม่อีกครั้ง', confirmButtonColor: '#1877f2' });
    }
  } catch (err) {
    Swal.fire({ icon: 'error', title: 'ไม่สามารถส่งได้', text: err.message, confirmButtonColor: '#1877f2' });
  }
}

function toggleSchedule() {
  const inp = document.getElementById('scheduledAt');
  const btn = document.getElementById('scheduleToggleBtn');
  const show = inp.style.display === 'none';
  inp.style.display = show ? 'inline-block' : 'none';
  btn.style.background = show ? '#e7f0fd' : '#f0f2f5';
  btn.style.color      = show ? '#1877f2'  : '#65676b';
  if (show && !inp.value) {
    inp.value = _toBkkLocal(new Date());
  }
  if (!show) inp.value = '';
}

function _toBkkLocal(date) {
  // คืนค่า "YYYY-MM-DDTHH:mm" ในเวลาไทย สำหรับ datetime-local input
  return date.toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T').slice(0, 16);
}

/* ═══════════════════════════════════════════
   Result page popup
═══════════════════════════════════════════ */
if (typeof successCount !== 'undefined') {
  Swal.fire({
    icon: failCount === 0 ? 'success' : 'warning',
    title: failCount === 0 ? 'โพสต์สำเร็จทุกเพจ! 🎉' : `สำเร็จ ${successCount} จาก ${total} เพจ`,
    html: failCount === 0
      ? `<span style="color:#2e7d32;font-weight:600">ทุกเพจได้รับโพสต์แล้ว</span>`
      : `<span style="color:#f57f17">ล้มเหลว ${failCount} เพจ</span>`,
    confirmButtonColor: '#1877f2', confirmButtonText: 'รับทราบ',
    timer: 4000, timerProgressBar: true,
  });
}

/* ── History: toggle more badges ── */
function toggleMoreBadges(btn, postId) {
  const group = document.getElementById(`mb-${postId}`);
  const open  = group.style.display !== 'none';
  group.style.display = open ? 'none' : 'inline-flex';
  btn.textContent = open
    ? `+ ${group.querySelectorAll('.mini-page-badge').length} เพจ`
    : 'ซ่อน';
}

/* ── Show more result rows ── */
function toggleResultRows(btn) {
  const hidden = document.querySelectorAll('.result-row-hidden');
  const isOpen = btn.classList.contains('open');
  hidden.forEach(row => row.style.display = isOpen ? 'none' : 'flex');
  btn.classList.toggle('open', !isOpen);
  const count = hidden.length;
  btn.innerHTML = isOpen
    ? `<i class="fa-solid fa-chevron-down"></i> ดูเพิ่มเติม ${count} เพจ`
    : `<i class="fa-solid fa-chevron-up"></i> ซ่อน`;
}

/* viewImage helper (result/history pages) */
function viewImage(src) {
  Swal.fire({ imageUrl: src, imageAlt: 'รูป', showConfirmButton: false, showCloseButton: true, width: 'auto' });
}

/* ═══════════════════════════════════════════
   Template System
═══════════════════════════════════════════ */
let _templates        = [];
let _tplView          = 'card';
let _tplSelected      = null;
let _tplLoadedImages  = [];   // filenames from loaded template (sent as templateImages on submit)
let _tplNewFiles      = [];   // files picked inside create-template Swal

function renderTplImagePreviews() {
  const el = document.getElementById('tplImagePreview');
  if (!el) return;
  if (!_tplLoadedImages.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'grid';
  el.innerHTML = _tplLoadedImages.map((name, i) => {
    const isVid = /\.(mp4|mov|avi|webm)$/i.test(name);
    const thumb = isVid
      ? `<video src="/uploads/${name}" style="width:100%;height:100%;object-fit:cover" muted playsinline></video>`
      : `<img src="/uploads/${name}" alt="" onerror="tplImgBroken('${name}', this)">`;
    return `
    <div class="img-thumb">
      ${thumb}
      <button class="img-thumb-remove" type="button" onclick="removeTplImage(${i})">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>`;
  }).join('');
}

function tplImgBroken(name, img) {
  // Hide the broken thumbnail in UI only — keep filename in _tplLoadedImages so it's still sent
  const thumb = img.closest('.img-thumb');
  if (thumb) thumb.style.display = 'none';
}

function removeTplImage(idx) { _tplLoadedImages.splice(idx, 1); renderTplImagePreviews(); }

async function openTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  await loadTemplates();
}

function closeTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
  _tplSelected = null;
  const footer = document.getElementById('tplFooter');
  if (footer) footer.style.display = 'none';
}

function closeTplOnBg(e) {
  if (e.target.id === 'templateModal') closeTemplateModal();
}

async function loadTemplates() {
  try {
    const res = await fetch('/api/templates');
    _templates = await res.json();
    renderTemplates();
  } catch {
    const body = document.getElementById('tplBody');
    if (body) body.innerHTML = '<p style="text-align:center;color:#8a8d91;padding:2rem">เกิดข้อผิดพลาดในการโหลด</p>';
  }
}

function setTplView(v) {
  _tplView = v;
  const cardBtn = document.getElementById('tplViewCardBtn');
  const listBtn = document.getElementById('tplViewListBtn');
  if (cardBtn) { cardBtn.style.background = v === 'card' ? '#1877f2' : 'transparent'; cardBtn.style.color = v === 'card' ? '#fff' : '#aaa'; }
  if (listBtn) { listBtn.style.background = v === 'list' ? '#1877f2' : 'transparent'; listBtn.style.color = v === 'list' ? '#fff' : '#aaa'; }
  renderTemplates();
}

function renderTemplates() {
  const body   = document.getElementById('tplBody');
  const badge  = document.getElementById('tplCountBadge');
  const footer = document.getElementById('tplFooter');
  if (!body) return;

  const query    = (document.getElementById('tplSearchInput')?.value || '').toLowerCase();
  const filtered = _templates.filter(t => !query || t.message.toLowerCase().includes(query) || (t.name||'').toLowerCase().includes(query));
  if (badge) badge.textContent = _templates.length;

  if (!filtered.length) {
    body.innerHTML = `
      <div style="text-align:center;padding:3rem 0;color:#8a8d91">
        <i class="fa-solid fa-layer-group" style="font-size:2.5rem;display:block;margin-bottom:.75rem;opacity:.25"></i>
        ${_templates.length === 0
          ? 'ยังไม่มีโพสต์บันทึกไว้<br><small style="font-size:.8rem">กด "สร้างโพสต์" หรือ "บันทึก" ในหน้าหลักเพื่อเริ่มต้น</small>'
          : 'ไม่พบโพสต์ที่ค้นหา'}
      </div>`;
    if (footer) footer.style.display = 'none';
    return;
  }

  const total = _templates.length;
  if (_tplView === 'card') {
    body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.65rem">${filtered.map(t => renderTplCard(t, total - _templates.findIndex(x => x.id === t.id))).join('')}</div>`;
  } else {
    body.innerHTML = `<div style="display:flex;flex-direction:column;gap:.35rem">${filtered.map(t => renderTplListRow(t, total - _templates.findIndex(x => x.id === t.id))).join('')}</div>`;
  }

  if (footer) footer.style.display = _tplSelected ? 'block' : 'none';
}

function renderTplCard(t, num) {
  const sel  = _tplSelected === t.id;
  const msg  = t.message.length > 90 ? t.message.slice(0, 90) + '…' : t.message;
  const imgs = (t.images || []);
  const imgHtml = imgs.length ? `
    <div style="display:flex;gap:3px;margin-top:.45rem;flex-wrap:wrap">
      ${imgs.slice(0, 4).map(img => /\.(mp4|mov|avi|webm)$/i.test(img)
        ? `<div style="width:42px;height:42px;background:#1c1e21;border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid fa-film" style="color:#fff;font-size:.8rem"></i></div>`
        : `<img src="/uploads/${img}" style="width:42px;height:42px;object-fit:cover;border-radius:5px;flex-shrink:0" onerror="this.style.display='none'">`).join('')}
      ${imgs.length > 4 ? `<div style="width:42px;height:42px;background:#e4e6eb;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#65676b">+${imgs.length-4}</div>` : ''}
    </div>` : '';

  return `
    <div onclick="selectTpl('${t.id}')"
      style="background:#fff;border:2px solid ${sel ? '#1877f2' : '#e4e6eb'};border-radius:10px;padding:.7rem;cursor:pointer;position:relative;transition:border-color .12s;${sel ? 'box-shadow:0 0 0 3px rgba(24,119,242,.15)' : ''}">
      <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.35rem">
        <div style="width:26px;height:26px;border-radius:50%;background:#e4e6eb;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid fa-file-lines" style="font-size:.62rem;color:#65676b"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.8rem;color:#1c1e21">โพสต์ #${num}</div>
          ${t.name ? `<div style="font-size:.7rem;color:#8a8d91;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name}</div>` : ''}
        </div>
        <div style="display:flex;gap:.15rem;flex-shrink:0" onclick="event.stopPropagation()">
          <button onclick="openEditTpl('${t.id}')" style="background:none;border:none;color:#8a8d91;cursor:pointer;font-size:.72rem;padding:.15rem .25rem" title="แก้ไข"><i class="fa-solid fa-pen"></i></button>
          <button onclick="deleteTpl('${t.id}')" style="background:none;border:none;color:#c62828;cursor:pointer;font-size:.72rem;padding:.15rem .25rem" title="ลบ"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div style="font-size:.82rem;color:#1c1e21;line-height:1.45;min-height:2.2rem">${msg}</div>
      ${imgHtml}
      ${sel ? `<div style="position:absolute;top:.45rem;right:.45rem;color:#1877f2;font-size:1rem"><i class="fa-solid fa-circle-check"></i></div>` : ''}
    </div>`;
}

function renderTplListRow(t, num) {
  const sel = _tplSelected === t.id;
  const msg = t.message.length > 110 ? t.message.slice(0, 110) + '…' : t.message;
  return `
    <div onclick="selectTpl('${t.id}')"
      style="background:#fff;border:2px solid ${sel ? '#1877f2' : '#e4e6eb'};border-radius:8px;padding:.6rem .85rem;cursor:pointer;display:flex;align-items:center;gap:.65rem;transition:border-color .12s">
      ${sel
        ? `<i class="fa-solid fa-circle-check" style="color:#1877f2;flex-shrink:0;font-size:.95rem"></i>`
        : `<i class="fa-regular fa-circle" style="color:#e4e6eb;flex-shrink:0;font-size:.95rem"></i>`}
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.8rem;color:#1c1e21">โพสต์ #${num}${t.name ? ' — ' + t.name : ''}</div>
        <div style="font-size:.79rem;color:#65676b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${msg}</div>
      </div>
      ${(t.images||[]).length ? `<span style="font-size:.7rem;color:#1877f2;background:#e7f3ff;padding:.1rem .4rem;border-radius:4px;flex-shrink:0"><i class="fa-solid fa-${(t.images||[]).some(f => /\.(mp4|mov|avi|webm|gif)$/i.test(f)) ? 'film' : 'image'}"></i> ${t.images.length}</span>` : ''}
      <div style="display:flex;gap:.25rem;flex-shrink:0" onclick="event.stopPropagation()">
        <button onclick="openEditTpl('${t.id}')" style="background:none;border:none;color:#8a8d91;cursor:pointer;font-size:.75rem;padding:.1rem .28rem"><i class="fa-solid fa-pen"></i></button>
        <button onclick="deleteTpl('${t.id}')" style="background:none;border:none;color:#c62828;cursor:pointer;font-size:.75rem;padding:.1rem .28rem"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
}

function selectTpl(id) {
  _tplSelected = _tplSelected === id ? null : id;
  renderTemplates();
}

function useTpl() {
  const t = _templates.find(t => t.id === _tplSelected);
  if (!t) return;
  if (messageEl) { messageEl.value = t.message; messageEl.dispatchEvent(new Event('input')); }
  _tplLoadedImages = [...(t.images || [])];
  renderTplImagePreviews();
  closeTemplateModal();
  Swal.fire({ icon: 'success', title: 'โหลดโพสต์แล้ว', timer: 1300, showConfirmButton: false });
}

/* ── Create new template ── */
async function openCreateTemplate() {
  _tplNewFiles = [];
  const { value } = await Swal.fire({
    title: '<i class="fa-solid fa-plus" style="color:#1877f2"></i> สร้างโพสต์ใหม่',
    html: `
      <div style="text-align:left">
        <label style="font-size:.82rem;color:#65676b;display:block;margin-bottom:.3rem">ข้อความ:</label>
        <textarea id="stMsg" placeholder="คุณกำลังคิดอะไรอยู่?" rows="4"
          style="width:100%;padding:.6rem .75rem;border:1.5px solid #dbe0e6;border-radius:8px;font-family:inherit;font-size:.87rem;resize:vertical;outline:none;box-sizing:border-box"></textarea>
        <label style="font-size:.82rem;color:#65676b;display:block;margin:.55rem 0 .3rem">ชื่อ Template (ไม่บังคับ):</label>
        <input id="stName" type="text" placeholder="เช่น โปรโมชั่น A"
          style="width:100%;padding:.48rem .75rem;border:1.5px solid #dbe0e6;border-radius:8px;font-family:inherit;font-size:.84rem;outline:none;box-sizing:border-box">
        <label style="font-size:.82rem;color:#65676b;display:block;margin:.55rem 0 .3rem">รูปภาพ/วิดีโอ (สูงสุด 10 ไฟล์):</label>
        <div id="stImgPrev" style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.4rem"></div>
        <input type="file" id="stFileInp" multiple accept="image/*,video/mp4,video/quicktime,video/x-msvideo,video/webm" style="display:none">
        <div id="stAddBtn"
          style="border:2px dashed #dbe0e6;border-radius:8px;padding:.85rem;text-align:center;cursor:pointer;color:#8a8d91;font-size:.82rem">
          <i class="fa-solid fa-cloud-arrow-up" style="font-size:1.4rem;display:block;margin-bottom:.3rem"></i>
          คลิกเพื่อเลือกรูปภาพ
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonColor: '#1a1a1a',
    confirmButtonText: '<i class="fa-solid fa-floppy-disk"></i> บันทึกโพสต์',
    cancelButtonText: 'ยกเลิก',
    width: 480,
    focusConfirm: false,
    didOpen: () => {
      const fileInp = document.getElementById('stFileInp');
      const addBtn  = document.getElementById('stAddBtn');
      addBtn.addEventListener('click', () => fileInp.click());
      addBtn.addEventListener('mouseover', () => addBtn.style.borderColor = '#1877f2');
      addBtn.addEventListener('mouseout',  () => addBtn.style.borderColor = '#dbe0e6');
      fileInp.addEventListener('change', function() {
        const incoming = Array.from(this.files);
        this.value = '';
        const valid = _checkFiles(incoming, _tplNewFiles.length, 10);
        valid.forEach(f => _tplNewFiles.push(f));
        _stRender();
      });
    },
    preConfirm: () => {
      const msg = document.getElementById('stMsg')?.value.trim();
      if (!msg) { Swal.showValidationMessage('กรุณากรอกข้อความ'); return false; }
      return { message: msg, name: document.getElementById('stName')?.value.trim() || '' };
    },
  });

  if (!value) { openTemplateModal(); return; }

  try {
    Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    const images = await _uploadImages(_tplNewFiles);
    if (_tplNewFiles.length > 0 && images.length === 0) throw new Error('อัปโหลดรูปไม่สำเร็จ');
    _tplNewFiles = [];
    const data = await _saveTemplate('/api/templates', 'POST', { message: value.message, name: value.name, images });
    if (!data.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');
    await Swal.fire({ icon: 'success', title: 'บันทึกแล้ว!', timer: 1200, showConfirmButton: false });
    openTemplateModal();
  } catch (err) {
    _tplNewFiles = [];
    Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: err.message });
    openTemplateModal();
  }
}

function _stRender() {
  const el = document.getElementById('stImgPrev');
  if (!el) return;
  el.innerHTML = _tplNewFiles.map((f, i) => {
    const isVid = f.type.startsWith('video/');
    const thumb = isVid
      ? `<video src="${URL.createObjectURL(f)}" style="width:54px;height:54px;object-fit:cover;border-radius:6px" muted playsinline></video>`
      : `<img src="${URL.createObjectURL(f)}" style="width:54px;height:54px;object-fit:cover;border-radius:6px">`;
    return `
    <div style="position:relative" id="stn-${i}">
      ${thumb}
      <button data-si="${i}" type="button"
        style="position:absolute;top:-4px;right:-4px;background:#c62828;color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:.55rem;cursor:pointer;padding:0">
        ×
      </button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-si]').forEach(btn => {
    btn.addEventListener('click', () => { _tplNewFiles.splice(+btn.dataset.si, 1); _stRender(); });
  });
}

/* ── Edit template ── */
let _etKeep = [];   // existing filenames to keep
let _etNew  = [];   // new File objects picked in edit dialog

async function openEditTpl(id) {
  const t = _templates.find(t => t.id === id);
  if (!t) return;
  _etKeep = [...(t.images || [])];
  _etNew  = [];

  const { value } = await Swal.fire({
    title: '<i class="fa-solid fa-pen" style="color:#1877f2"></i> แก้ไขโพสต์',
    html: `
      <div style="text-align:left">
        <label style="font-size:.82rem;color:#65676b;display:block;margin-bottom:.3rem">ข้อความ:</label>
        <textarea id="etMsg" rows="4"
          style="width:100%;padding:.6rem .75rem;border:1.5px solid #dbe0e6;border-radius:8px;font-family:inherit;font-size:.87rem;resize:vertical;outline:none;box-sizing:border-box">${t.message}</textarea>
        <label style="font-size:.82rem;color:#65676b;display:block;margin:.55rem 0 .3rem">ชื่อ Template:</label>
        <input id="etName" type="text" value="${t.name||''}"
          style="width:100%;padding:.48rem .75rem;border:1.5px solid #dbe0e6;border-radius:8px;font-family:inherit;font-size:.84rem;outline:none;box-sizing:border-box">
        <label style="font-size:.82rem;color:#65676b;display:block;margin:.55rem 0 .3rem">
          รูปภาพ (สูงสุด 10 รูป):
          ${(t.images||[]).length ? `<span style="margin-left:.4rem;background:#e7f3ff;color:#1877f2;padding:.1rem .5rem;border-radius:4px;font-size:.75rem"><i class="fa-solid fa-image"></i> มีอยู่แล้ว ${t.images.length} รูป</span>` : ''}
        </label>
        <div id="etImgPrev" style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.4rem"></div>
        <input type="file" id="etFileInp" multiple accept="image/*,video/mp4,video/quicktime,video/x-msvideo,video/webm" style="display:none">
        <div id="etAddBtn"
          style="border:2px dashed #dbe0e6;border-radius:8px;padding:.6rem;text-align:center;cursor:pointer;color:#8a8d91;font-size:.8rem">
          <i class="fa-solid fa-cloud-arrow-up" style="font-size:1.1rem;display:block;margin-bottom:.2rem"></i>
          คลิกเพื่อเพิ่มรูปภาพ
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonColor: '#1877f2',
    confirmButtonText: 'บันทึก',
    cancelButtonText: 'ยกเลิก',
    width: 480,
    focusConfirm: false,
    didOpen: () => {
      _etRender();
      const fileInp = document.getElementById('etFileInp');
      const addBtn  = document.getElementById('etAddBtn');
      addBtn.addEventListener('click', () => fileInp.click());
      addBtn.addEventListener('mouseover', () => addBtn.style.borderColor = '#1877f2');
      addBtn.addEventListener('mouseout',  () => addBtn.style.borderColor = '#dbe0e6');
      fileInp.addEventListener('change', function() {
        const incoming = Array.from(this.files);
        this.value = '';
        const valid = _checkFiles(incoming, _etKeep.length + _etNew.length, 10);
        valid.forEach(f => _etNew.push(f));
        _etRender();
      });
    },
    preConfirm: () => {
      const msg = document.getElementById('etMsg')?.value.trim();
      if (!msg) { Swal.showValidationMessage('กรุณากรอกข้อความ'); return false; }
      return { message: msg, name: document.getElementById('etName')?.value.trim() || '' };
    },
  });

  if (!value) { _etKeep = []; _etNew = []; openTemplateModal(); return; }

  try {
    Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });

    const newFilenames = await _uploadImages(_etNew);
    if (_etNew.length > 0 && newFilenames.length === 0) throw new Error('อัปโหลดรูปไม่สำเร็จ');

    const images = [..._etKeep, ...newFilenames];
    _etKeep = []; _etNew = [];

    const data = await _saveTemplate(`/api/templates/${id}`, 'PUT', { message: value.message, name: value.name, images });
    if (!data.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');

    const idx = _templates.findIndex(x => x.id === id);
    if (idx >= 0) _templates[idx] = data.template;
    await Swal.fire({ icon: 'success', title: 'บันทึกแล้ว!', timer: 1200, showConfirmButton: false });
    openTemplateModal();
  } catch (err) {
    _etKeep = []; _etNew = [];
    Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: err.message });
    openTemplateModal();
  }
}

function _etRender() {
  const el = document.getElementById('etImgPrev');
  if (!el) return;
  const keepHtml = _etKeep.map((name, i) => {
    const isVid = /\.(mp4|mov|avi|webm)$/i.test(name);
    const thumb = isVid
      ? `<video src="/uploads/${name}" style="width:54px;height:54px;object-fit:cover;border-radius:6px" muted playsinline></video>`
      : `<img src="/uploads/${name}" style="width:54px;height:54px;object-fit:cover;border-radius:6px" onerror="this.closest('div').style.display='none'">`;
    return `
    <div style="position:relative" id="etk-${i}">
      ${thumb}
      <button data-ki="${i}" type="button"
        style="position:absolute;top:-4px;right:-4px;background:#c62828;color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:.55rem;cursor:pointer;padding:0">
        ×
      </button>
    </div>`;
  }).join('');
  const newHtml = _etNew.map((f, i) => {
    const isVid = f.type.startsWith('video/');
    const thumb = isVid
      ? `<video src="${URL.createObjectURL(f)}" style="width:54px;height:54px;object-fit:cover;border-radius:6px" muted playsinline></video>`
      : `<img src="${URL.createObjectURL(f)}" style="width:54px;height:54px;object-fit:cover;border-radius:6px">`;
    return `
    <div style="position:relative" id="etn-${i}">
      ${thumb}
      <button data-ni="${i}" type="button"
        style="position:absolute;top:-4px;right:-4px;background:#c62828;color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:.55rem;cursor:pointer;padding:0">
        ×
      </button>
    </div>`;
  }).join('');
  el.innerHTML = keepHtml + newHtml;
  // attach remove handlers after render
  el.querySelectorAll('[data-ki]').forEach(btn => {
    btn.addEventListener('click', () => { _etKeep.splice(+btn.dataset.ki, 1); _etRender(); });
  });
  el.querySelectorAll('[data-ni]').forEach(btn => {
    btn.addEventListener('click', () => { _etNew.splice(+btn.dataset.ni, 1); _etRender(); });
  });
}

/* ── Delete template ── */
async function deleteTpl(id) {
  const t   = _templates.find(t => t.id === id);
  const res = await Swal.fire({
    title: 'ลบโพสต์นี้?',
    text:  t ? (t.message.length > 60 ? t.message.slice(0, 60) + '…' : t.message) : '',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#c62828',
    cancelButtonColor: '#65676b',
    confirmButtonText: 'ลบเลย',
    cancelButtonText: 'ยกเลิก',
  });
  if (!res.isConfirmed) return;
  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  if (_tplSelected === id) _tplSelected = null;
  _templates = _templates.filter(x => x.id !== id);
  renderTemplates();
}

/* ── Upload helper: upload File[] → return filename[] from MongoDB ── */
async function _uploadImages(files) {
  if (!files.length) return [];
  const fd = new FormData();
  files.forEach(f => fd.append('images', f));
  const res  = await fetch('/api/upload-images', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่');
  return data.filenames;
}

/* ── Save JSON to template endpoint ── */
async function _saveTemplate(url, method, body) {
  const res  = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ── Save current composer as template ── */
async function saveCurrentAsTemplate() {
  const msg = messageEl?.value.trim();
  if (!msg) {
    Swal.fire({ icon: 'warning', title: 'กรุณากรอกข้อความก่อนบันทึก', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' });
    return;
  }
  const { value: name, isConfirmed } = await Swal.fire({
    title: '<i class="fa-solid fa-floppy-disk" style="color:#1877f2"></i> บันทึก Template',
    input: 'text',
    inputLabel: 'ชื่อ Template (ไม่บังคับ)',
    inputPlaceholder: 'เช่น โปรโมชั่นสินค้า A',
    showCancelButton: true,
    confirmButtonColor: '#1877f2',
    confirmButtonText: 'บันทึก',
    cancelButtonText: 'ยกเลิก',
  });
  if (!isConfirmed) return;

  try {
    Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    const newFilenames = await _uploadImages(selectedFiles);
    if (selectedFiles.length > 0 && newFilenames.length === 0) throw new Error('อัปโหลดรูปไม่สำเร็จ');
    const images = [..._tplLoadedImages, ...newFilenames];
    const data = await _saveTemplate('/api/templates', 'POST', { message: msg, name: name || '', images });
    if (!data.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');
    Swal.fire({ icon: 'success', title: 'บันทึกแล้ว!', timer: 1400, showConfirmButton: false });
  } catch (err) {
    Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: err.message });
  }
}
