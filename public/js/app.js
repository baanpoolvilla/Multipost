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

/* ── Image upload ── */
function triggerImage() { fileInput?.click(); }

if (fileInput) {
  fileInput.addEventListener('change', function () {
    Array.from(this.files).forEach(file => {
      if (!selectedFiles.some(f => f.name === file.name && f.size === file.size))
        selectedFiles.push(file);
    });
    this.value = '';
    renderPreviews();
  });
}

function renderPreviews() {
  if (!imagePreview) return;
  if (!selectedFiles.length) { imagePreview.style.display = 'none'; imagePreview.innerHTML = ''; return; }
  imagePreview.style.display = 'grid';
  imagePreview.innerHTML = selectedFiles.map((f, i) => `
    <div class="img-thumb">
      <img src="${URL.createObjectURL(f)}" alt="">
      <button class="img-thumb-remove" type="button" onclick="removeImage(${i})">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>`).join('');
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
  const chips = [...document.querySelectorAll('.page-sel-chip:not(.all-chip)')];
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
  const total = document.querySelectorAll('.page-sel-chip:not(.all-chip)').length;
  const allChip = document.querySelector('.all-chip');
  if (!allChip) return;
  allChip.classList.toggle('active', selectedPageIds.size === total);
}

function updatePageCountLabel() {
  const el = document.getElementById('pageCountLabel');
  if (el) el.textContent = `โพสต์ไปยัง ${selectedPageIds.size} เพจ`;
  updateMoreChip();
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
  const lv = document.getElementById('locationVal')?.value;
  let html = '';
  if (fe) html += `<span class="composer-tag">${fe} รู้สึก${fl}<button onclick="clearFeeling()" type="button"><i class="fa-solid fa-xmark"></i></button></span>`;
  if (lv) html += `<span class="composer-tag"><i class="fa-solid fa-location-dot" style="color:#f5533d"></i> ${lv}<button onclick="clearLocation()" type="button"><i class="fa-solid fa-xmark"></i></button></span>`;
  tagsBar.innerHTML = html;
  tagsBar.style.display = html ? 'flex' : 'none';
}

function clearFeeling()  { document.getElementById('feelingEmoji').value = ''; document.getElementById('feelingLabel').value = ''; updateTagsBar(); }
function clearLocation() { document.getElementById('locationVal').value  = ''; updateTagsBar(); }

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
   Map / Check-in  (Leaflet + Nominatim OSM)
═══════════════════════════════════════════ */
let leafletMap = null, leafletMarker = null, pendingLocation = null;
let searchTimer = null;

function openMapModal() {
  document.getElementById('mapModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Init Leaflet after modal is visible
  setTimeout(() => {
    if (!leafletMap) {
      leafletMap = L.map('leafletMap').setView([13.75, 100.52], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      }).addTo(leafletMap);

      leafletMap.on('click', (e) => {
        const { lat, lng } = e.latlng;
        placeMarker(lat, lng);
        reverseGeocode(lat, lng);
      });
    } else {
      leafletMap.invalidateSize();
    }
  }, 150);
}

function closeMapModal() {
  document.getElementById('mapModal').style.display = 'none';
  document.body.style.overflow = '';
  document.getElementById('mapResults').innerHTML = '';
  document.getElementById('mapSearchInput').value = '';
}

function closeMapOnBg(e) {
  if (e.target.id === 'mapModal') closeMapModal();
}

function placeMarker(lat, lng) {
  if (leafletMarker) leafletMarker.remove();
  leafletMarker = L.marker([lat, lng]).addTo(leafletMap);
  leafletMap.setView([lat, lng], Math.max(leafletMap.getZoom(), 14));
}

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=th`, { headers: {'Accept-Language': 'th'} });
    const data = await res.json();
    const name = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setPendingLocation(name, lat, lng);
  } catch {
    setPendingLocation(`${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng);
  }
}

function setPendingLocation(name, lat, lng) {
  pendingLocation = { name, lat, lng };
  const label = document.getElementById('selectedLocLabel');
  label.innerHTML = `<i class="fa-solid fa-location-dot" style="color:#f5533d"></i><span title="${name}">${name}</span>`;
  document.getElementById('confirmLocBtn').disabled = false;
}

/* Nominatim search with 500ms debounce */
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchLocation, 500);
}

async function searchLocation() {
  const q = document.getElementById('mapSearchInput').value.trim();
  const resultsEl = document.getElementById('mapResults');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=th`);
    const data = await res.json();
    if (!data.length) { resultsEl.innerHTML = '<div class="map-result-item" style="color:#8a8d91">ไม่พบสถานที่</div>'; return; }
    resultsEl.innerHTML = data.map(r => `
      <div class="map-result-item" onclick="selectSearchResult(${r.lat},${r.lon},\`${r.display_name.replace(/`/g,"'")}\`)">
        <i class="fa-solid fa-location-dot"></i>
        <span>${r.display_name}</span>
      </div>`).join('');
  } catch { resultsEl.innerHTML = '<div class="map-result-item" style="color:#8a8d91">เกิดข้อผิดพลาด</div>'; }
}

function selectSearchResult(lat, lon, name) {
  document.getElementById('mapResults').innerHTML = '';
  document.getElementById('mapSearchInput').value = '';
  placeMarker(parseFloat(lat), parseFloat(lon));
  setPendingLocation(name, parseFloat(lat), parseFloat(lon));
}

/* ── ตำแหน่งปัจจุบัน ── */
function goToMyLocation() {
  if (!navigator.geolocation) {
    Swal.fire({ icon: 'error', title: 'เบราว์เซอร์ไม่รองรับ GPS', confirmButtonColor: '#1877f2' });
    return;
  }
  const btn = document.getElementById('myLocBtn');
  btn.classList.add('loading');
  btn.querySelector('span').textContent = 'กำลังหา...';

  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      const { latitude: lat, longitude: lng } = coords;
      placeMarker(lat, lng);
      await reverseGeocode(lat, lng);
      btn.classList.remove('loading');
      btn.querySelector('span').textContent = 'ของฉัน';
    },
    (err) => {
      btn.classList.remove('loading');
      btn.querySelector('span').textContent = 'ของฉัน';
      const msg = err.code === 1
        ? 'กรุณาอนุญาตให้เข้าถึงตำแหน่งในเบราว์เซอร์'
        : 'ไม่สามารถระบุตำแหน่งได้';
      Swal.fire({ icon: 'warning', title: 'ไม่พบตำแหน่ง', text: msg, confirmButtonColor: '#1877f2' });
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function confirmMapLocation() {
  if (!pendingLocation) return;
  // Trim to first meaningful part (city/district)
  const parts = pendingLocation.name.split(',');
  const shortName = parts.slice(0, 2).join(',').trim();
  document.getElementById('locationVal').value = shortName;
  updateTagsBar();
  closeMapModal();
  pendingLocation = null;
}

/* ═══════════════════════════════════════════
   Submit
═══════════════════════════════════════════ */
async function submitPost() {
  const msg = messageEl?.value.trim();
  if (!msg) {
    Swal.fire({ icon: 'warning', title: 'ยังไม่ได้กรอกข้อความ', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' });
    return;
  }
  if (selectedPageIds.size === 0) {
    Swal.fire({ icon: 'warning', title: 'กรุณาเลือกเพจอย่างน้อย 1 เพจ', confirmButtonColor: '#1877f2', confirmButtonText: 'ตกลง' });
    return;
  }

  Swal.fire({
    title: 'กำลังส่งโพสต์...',
    html: `<i class="fa-brands fa-facebook" style="font-size:2rem;color:#1877f2"></i>
           <p style="margin-top:.7rem;color:#65676b">กำลังโพสต์ไปยัง ${selectedPageIds.size} เพจ</p>`,
    allowOutsideClick: false, allowEscapeKey: false, showConfirmButton: false,
    didOpen: () => Swal.showLoading(),
  });

  const fd = new FormData();
  fd.append('message',      msg);
  fd.append('feelingEmoji', document.getElementById('feelingEmoji')?.value || '');
  fd.append('feelingLabel', document.getElementById('feelingLabel')?.value || '');
  fd.append('location',     document.getElementById('locationVal')?.value  || '');
  selectedPageIds.forEach(id => fd.append('selectedPages', id));
  selectedFiles.forEach(f => fd.append('images', f));

  try {
    const res  = await fetch('/send', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.id) window.location.href = `/result/${data.id}`;
    else Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: data.error || 'ลองใหม่อีกครั้ง' });
  } catch (err) {
    Swal.fire({ icon: 'error', title: 'ไม่สามารถส่งได้', text: err.message });
  }
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
