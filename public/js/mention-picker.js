/* @ mention picker — typing "@" in a message box lists Page names; picking one
   inserts "@ชื่อเพจ". Page posts: the server turns it into a real tag
   (facebookService.applyPageMentions). Group posts: the Agent picks it from
   Facebook's own mention list while typing (facebookBot._typeWithMentions). */
function attachMentionPicker(el, getNames) {
  if (!el) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:9999;display:none;min-width:240px;max-width:360px;max-height:240px;overflow:auto;background:#fff;border:1px solid #dbe0e6;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:4px';
  document.body.appendChild(box);
  let items = [], active = 0, atPos = -1;

  const close = () => { box.style.display = 'none'; items = []; atPos = -1; };
  const pick = i => {
    const name = items[i]; if (!name) return;
    const caret = el.selectionStart;
    const ins = `@${name} `;
    el.value = el.value.slice(0, atPos) + ins + el.value.slice(caret);
    el.selectionStart = el.selectionEnd = atPos + ins.length;
    close();
    el.dispatchEvent(new Event('input'));
    el.focus();
  };
  const render = () => {
    box.innerHTML = '';
    items.forEach((name, i) => {
      const row = document.createElement('div');
      row.textContent = name;
      row.style.cssText = `padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;${i === active ? 'background:#e7f0ff;color:#1a56db' : ''}`;
      row.addEventListener('mousedown', e => { e.preventDefault(); pick(i); });
      box.appendChild(row);
    });
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top  = `${Math.min(r.bottom + 4, window.innerHeight - 250)}px`;
    box.style.display = 'block';
  };
  const update = () => {
    const names = [...new Set((getNames() || []).filter(Boolean))];
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/(?:^|\s)@([^@\n]{0,40})$/);
    if (!m || !names.length) return close();
    const q = m[1].toLowerCase();
    items = names.filter(n => n.toLowerCase().includes(q)).slice(0, 8);
    if (!items.length) return close();
    atPos = before.length - m[1].length - 1;
    active = Math.min(active, items.length - 1);
    render();
  };

  el.addEventListener('input', () => { active = 0; update(); });
  el.addEventListener('click', update);
  el.addEventListener('blur', () => setTimeout(close, 150));
  el.addEventListener('keydown', e => {
    if (box.style.display === 'none') return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape')    { e.preventDefault(); close(); }
  });
}
