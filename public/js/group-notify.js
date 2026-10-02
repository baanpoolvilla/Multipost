// Group-post notifications, on every page of the web.
//
// Nobody watches the posting machine's screen, so everything it would have
// told you shows up here instead: your job started / finished / failed, groups
// skipped because the wrong Page was showing, Facebook asking to approve a
// login, the posting machine going offline. One status poll feeds both this
// and the live banner on the queue page (window.PosterFeed).
(function () {
    if (window.PosterFeed) return;

    var LS_SEEN = 'mp_notify_last_seen_v1';
    var LS_LOG  = 'mp_notify_log_v1';
    var subs = [];
    var data = null, inflight = null, busy = true, fails = 0, lastOk = 0;
    var prevJobs = null, prevPoster = null;
    var shownKeys = {};

    function lsGet(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
    function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

    // ── Polling ───────────────────────────────────────────────────
    function fetchOnce() {
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, 10000);
        return fetch('/api/agent/poster-status', { cache: 'no-store', signal: ctl.signal })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (d) { clearTimeout(timer); return d; });
    }

    function refresh() {
        if (inflight) return inflight;
        inflight = fetchOnce().then(function (d) {
            var ok = !!(d && d.ok);
            if (ok) {
                fails = 0; lastOk = Date.now();
                try { detect(d); } catch (e) {}
                data = d;
                busy = !!((d.current || []).length || (d.queue && d.queue.waiting) ||
                          (d.poster && (d.poster.pagesRefreshPending || d.poster.authWaiting)));
            } else {
                fails++;
            }
            subs.forEach(function (fn) { try { fn(ok ? d : null, { fails: fails, lastOk: lastOk }); } catch (e) {} });
            inflight = null;
            return ok ? d : null;
        });
        return inflight;
    }

    function myActiveJobs() {
        if (!data || !data.me) return false;
        return (data.jobs || []).some(function (j) { return j.ownerId === data.me.id && (j.status === 'pending' || j.status === 'running'); });
    }

    // 5s while something is posting/waiting, 20s when idle. In a background
    // tab: every 30s only while one of MY jobs is still in the queue (so its
    // result can be announced), otherwise not at all.
    (function loop() {
        var hidden = document.hidden;
        var delay = hidden ? 30000 : (busy ? 5000 : 20000);
        setTimeout(function () {
            var p = (!document.hidden || myActiveJobs()) ? refresh() : Promise.resolve();
            p.then(loop, loop);
        }, delay);
    })();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

    // ── Turning status changes into notifications ─────────────────
    var TERMINAL = { success: 1, failed: 1, expired: 1, cancelled: 1 };

    function jobOutcome(j, mine) {
        var who = mine ? 'งานของคุณ' : 'งานของ ' + j.owner;
        var name = '"' + j.label + '"';
        if (j.status === 'expired')   return { type: 'warn',  title: who + 'หมดเวลา ไม่ได้โพส', body: name + ' — กด "โพสเลย" ในคิวโพสกลุ่มเพื่อโพสใหม่' };
        if (j.status === 'cancelled') return { type: 'warn',  title: who + 'ถูกยกเลิก', body: name };
        if (j.status === 'failed')    return { type: 'error', title: who + 'โพสไม่สำเร็จ', body: name + (j.error ? ' — ' + j.error : '') };
        if (j.failed > 0) {
            return { type: 'warn', title: who + 'โพสเสร็จ ' + j.ok + '/' + j.total + ' กลุ่ม',
                     body: name + ' — ไม่สำเร็จ ' + j.failed + ' กลุ่ม' + (j.wrongPage ? ' (ข้าม ' + j.wrongPage + ' กลุ่มเพราะผู้โพสไม่ตรงกับเพจที่เลือก)' : '') + (j.error ? ' · ' + j.error : '') };
        }
        return { type: 'ok', title: who + 'โพสเสร็จแล้ว ' + j.ok + '/' + j.total + ' กลุ่ม', body: name + (j.postAsPage ? ' · ในนาม ' + j.postAsPage : '') };
    }

    function detect(d) {
        var me = d.me || {};
        var isAdmin = me.role === 'admin';
        var jobs = d.jobs || [];
        var map = {};
        jobs.forEach(function (j) { map[j.id] = j; });

        if (!prevJobs) {
            // First look after opening the page: report what finished while it was closed.
            var seen = lsGet(LS_SEEN, null);
            if (seen) {
                jobs.forEach(function (j) {
                    if (j.ownerId !== me.id || !TERMINAL[j.status] || !j.updatedAt || j.updatedAt <= seen) return;
                    var o = jobOutcome(j, true);
                    notify({ key: 'job:' + j.id + ':' + j.status, type: o.type, title: o.title, body: o.body + ' (ระหว่างที่ไม่ได้เปิดหน้านี้)', href: '/group-result/' + j.id, quiet: true });
                });
            }
        } else {
            jobs.forEach(function (j) {
                var before = prevJobs[j.id];
                var mine = j.ownerId && j.ownerId === me.id;
                var was = before ? before.status : null;
                if (was === j.status) return;
                if (j.status === 'running' && mine && was === 'pending') {
                    notify({ key: 'job:' + j.id + ':running', type: 'info', title: 'เริ่มโพสงานของคุณแล้ว', body: '"' + j.label + '" · ' + j.total + ' กลุ่ม', quiet: true });
                }
                if (TERMINAL[j.status] && (was === 'pending' || was === 'running')) {
                    var problem = j.status !== 'success' || j.failed > 0;
                    // Everyone hears about their own jobs; admins also about anyone's problems.
                    if (!mine && !(isAdmin && problem)) return;
                    var o = jobOutcome(j, mine);
                    notify({ key: 'job:' + j.id + ':' + j.status, type: o.type, title: o.title, body: o.body, href: '/group-result/' + j.id });
                }
            });
        }
        prevJobs = map;
        if (d.serverTime) lsSet(LS_SEEN, d.serverTime);

        // The posting machine itself — everyone is told.
        var p = d.poster;
        if (p && prevPoster) {
            if (prevPoster.online && !p.online)             notify({ type: 'error', title: 'เครื่องโพสหลักออฟไลน์', body: 'งานจะค้างในคิวจนกว่าเครื่องจะกลับมา กรุณาแจ้งผู้ดูแลระบบ', href: '/job-queue' });
            if (!prevPoster.online && p.online)             notify({ type: 'ok',    title: 'เครื่องโพสหลักกลับมาออนไลน์แล้ว', body: 'งานในคิวจะโพสต่อ', quiet: true });
            if (p.online && !prevPoster.authWaiting && p.authWaiting) notify({ type: 'error', title: 'Facebook ขอยืนยันตัวตน', body: 'การโพสหยุดรออยู่ กรุณาแจ้งผู้ดูแลให้กดอนุมัติการเข้าสู่ระบบบนมือถือ (ภายใน 10 นาที)', href: '/job-queue' });
            if (p.online && prevPoster.authWaiting && !p.authWaiting) notify({ type: 'ok', title: 'ยืนยันตัวตน Facebook แล้ว', body: 'เครื่องโพสหลักโพสต่อ', quiet: true });
            if (p.online && prevPoster.fbReady && !p.fbReady)   notify({ type: 'error', title: 'Facebook ของเครื่องโพสหลักหลุดการเข้าสู่ระบบ', body: 'งานจะค้างในคิว กรุณาแจ้งผู้ดูแลให้เข้าสู่ระบบ Facebook ใหม่ที่เครื่องโพสหลัก', href: '/job-queue' });
            if (p.online && prevPoster.running && !p.running)   notify({ type: 'warn',  title: 'เครื่องโพสหลักหยุดโพสอัตโนมัติ', body: 'งานจะค้างในคิวจนกว่าจะเปิดโพสอัตโนมัติอีกครั้ง', href: '/job-queue' });
        }
        if (p) prevPoster = { online: !!p.online, authWaiting: !!p.authWaiting, fbReady: !!p.fbReady, running: !!p.running };
    }

    // ── Showing them ──────────────────────────────────────────────
    var ICON = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', error: 'fa-circle-xmark', info: 'fa-circle-info' };

    function notify(n) {
        if (n.key) { if (shownKeys[n.key]) return; shownKeys[n.key] = 1; }
        var log = lsGet(LS_LOG, []);
        if (n.key && log.some(function (x) { return x.key === n.key; })) return; // already announced in another tab / earlier visit
        var entry = { key: n.key || null, type: n.type, title: n.title, body: n.body || '', href: n.href || null, at: new Date().toISOString(), read: false };
        log.unshift(entry);
        lsSet(LS_LOG, log.slice(0, 40));
        renderBell();
        showToast(entry);
        // On-screen system notification for things worth interrupting for,
        // or anything that happens while this tab is in the background.
        if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || n.type === 'error') && !n.quiet) {
            try {
                var sys = new Notification(n.title, { body: n.body || '', tag: n.key || undefined });
                sys.onclick = function () { window.focus(); if (n.href) location.href = n.href; sys.close(); };
            } catch (e) {}
        }
    }

    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

    function stack() {
        var s = document.getElementById('mpToastStack');
        if (!s) { s = el('div'); s.id = 'mpToastStack'; s.setAttribute('aria-live', 'polite'); document.body.appendChild(s); }
        return s;
    }

    function showToast(n) {
        var t = el('div', 'mp-toast mp-' + n.type);
        t.setAttribute('role', n.type === 'error' ? 'alert' : 'status');
        var ic = el('i', 'fa-solid ' + (ICON[n.type] || ICON.info));
        var txt = el('div', 'mp-toast-txt');
        txt.appendChild(el('div', 'mp-toast-title', n.title));
        if (n.body) txt.appendChild(el('div', 'mp-toast-body', n.body));
        if (n.href) { var a = el('a', 'mp-toast-link', 'ดูรายละเอียด'); a.href = n.href; txt.appendChild(a); }
        var x = el('button', 'mp-toast-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'ปิดการแจ้งเตือน');
        x.addEventListener('click', function () { t.remove(); });
        t.appendChild(ic); t.appendChild(txt); t.appendChild(x);
        stack().appendChild(t);
        // Problems stay until closed; good news and info leave on their own.
        if (n.type === 'ok' || n.type === 'info') setTimeout(function () { t.remove(); }, 9000);
        var all = stack().children;
        while (all.length > 5) all[0].remove();
    }

    function renderBell() {
        var host = document.querySelector('.navbar-right');
        if (!host) return;
        var btn = document.getElementById('mpBell');
        if (!btn) {
            btn = el('button', 'mp-bell'); btn.id = 'mpBell'; btn.type = 'button';
            btn.setAttribute('aria-label', 'การแจ้งเตือนงานโพสกลุ่ม'); btn.title = 'การแจ้งเตือนงานโพสกลุ่ม';
            btn.appendChild(el('i', 'fa-solid fa-bell'));
            var badge = el('span', 'mp-bell-badge'); badge.id = 'mpBellBadge'; btn.appendChild(badge);
            btn.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
            host.insertBefore(btn, host.firstChild);
            document.addEventListener('click', function (e) {
                var panel = document.getElementById('mpBellPanel');
                if (panel && !panel.contains(e.target)) panel.remove();
            });
        }
        var unread = lsGet(LS_LOG, []).filter(function (x) { return !x.read; }).length;
        var b = document.getElementById('mpBellBadge');
        b.textContent = unread > 9 ? '9+' : String(unread);
        b.style.display = unread ? '' : 'none';
    }

    function togglePanel() {
        var old = document.getElementById('mpBellPanel');
        if (old) { old.remove(); return; }
        var log = lsGet(LS_LOG, []);
        var panel = el('div', 'mp-bell-panel'); panel.id = 'mpBellPanel';
        var head = el('div', 'mp-bell-head');
        head.appendChild(el('b', null, 'การแจ้งเตือน'));
        if (log.length) {
            var clear = el('button', 'mp-bell-clear', 'ล้างทั้งหมด'); clear.type = 'button';
            clear.addEventListener('click', function () { lsSet(LS_LOG, []); panel.remove(); renderBell(); });
            head.appendChild(clear);
        }
        panel.appendChild(head);

        var framed = false;
        try { framed = window.top !== window.self; } catch (e) { framed = true; }
        if (framed) {
            // Inside SmartBoss: browsers don't allow desktop notifications from a
            // framed site, and SmartBoss already rings for your own jobs.
            panel.appendChild(el('div', 'mp-bell-note', 'งานของคุณ (เริ่มโพส / โพสเสร็จ / โพสไม่ได้) แจ้งในกระดิ่งของ SmartBoss ด้วย'));
        } else if ('Notification' in window && Notification.permission === 'default') {
            var ask = el('button', 'mp-bell-ask'); ask.type = 'button';
            ask.appendChild(el('i', 'fa-solid fa-desktop'));
            ask.appendChild(document.createTextNode(' เปิดแจ้งเตือนบนเครื่อง (เด้งแม้เปิดแท็บอื่นอยู่)'));
            ask.addEventListener('click', function () { Notification.requestPermission().then(function () { panel.remove(); }); });
            panel.appendChild(ask);
        } else if ('Notification' in window && Notification.permission === 'denied') {
            panel.appendChild(el('div', 'mp-bell-note', 'เบราว์เซอร์นี้ปิดการแจ้งเตือนบนเครื่องไว้ — เปิดได้ที่การตั้งค่าไซต์ของเบราว์เซอร์'));
        }

        if (!log.length) panel.appendChild(el('div', 'mp-bell-empty', 'ยังไม่มีการแจ้งเตือน'));
        log.forEach(function (n) {
            var row = el(n.href ? 'a' : 'div', 'mp-bell-row mp-' + n.type);
            if (n.href) row.href = n.href;
            row.appendChild(el('i', 'fa-solid ' + (ICON[n.type] || ICON.info)));
            var txt = el('div', 'mp-toast-txt');
            txt.appendChild(el('div', 'mp-toast-title', n.title));
            if (n.body) txt.appendChild(el('div', 'mp-toast-body', n.body));
            txt.appendChild(el('div', 'mp-bell-time', new Date(n.at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })));
            row.appendChild(txt);
            panel.appendChild(row);
        });
        document.body.appendChild(panel);
        lsSet(LS_LOG, log.map(function (n) { n.read = true; return n; }));
        renderBell();
    }

    var css = [
        '#mpToastStack{position:fixed;right:16px;top:66px;z-index:10000;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 32px))}',
        '.mp-toast{display:flex;gap:10px;align-items:flex-start;background:#fff;border-radius:12px;padding:12px 12px 12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.18);border-left:5px solid #1877f2;font-family:inherit;animation:mpIn .25s ease}',
        '.mp-toast>i{font-size:1.1rem;margin-top:2px;color:#1877f2}',
        '.mp-toast.mp-ok{border-left-color:#2e7d32}.mp-toast.mp-ok>i{color:#2e7d32}',
        '.mp-toast.mp-warn{border-left-color:#e08600}.mp-toast.mp-warn>i{color:#e08600}',
        '.mp-toast.mp-error{border-left-color:#c62828}.mp-toast.mp-error>i{color:#c62828}',
        '.mp-toast-txt{flex:1;min-width:0}',
        '.mp-toast-title{font-weight:700;font-size:.88rem;color:#1c1e21;overflow-wrap:anywhere}',
        '.mp-toast-body{font-size:.8rem;color:#65676b;margin-top:2px;line-height:1.45;overflow-wrap:anywhere}',
        '.mp-toast-link{display:inline-block;margin-top:4px;font-size:.78rem;font-weight:600;color:#1877f2;text-decoration:none}',
        '.mp-toast-link:hover{text-decoration:underline}',
        '.mp-toast-x{border:none;background:none;color:#8a8d91;cursor:pointer;font-size:.8rem;padding:2px 4px;border-radius:6px}',
        '.mp-toast-x:hover{background:#f0f2f5;color:#1c1e21}',
        '.mp-bell{position:relative;border:none;background:#e4e6ea;width:36px;height:36px;border-radius:50%;cursor:pointer;color:#1c1e21;display:inline-flex;align-items:center;justify-content:center;font-size:.95rem}',
        '.mp-bell:hover{background:#d8dadf}',
        '.mp-bell:focus-visible,.mp-toast-x:focus-visible,.mp-bell-ask:focus-visible,.mp-bell-clear:focus-visible{outline:2px solid #1877f2;outline-offset:2px}',
        '.mp-bell-badge{position:absolute;top:-3px;right:-3px;background:#e41e3f;color:#fff;font-size:.62rem;font-weight:700;border-radius:999px;min-width:17px;height:17px;line-height:17px;padding:0 4px;text-align:center}',
        '.mp-bell-panel{position:fixed;top:60px;right:16px;z-index:10001;width:min(380px,calc(100vw - 32px));max-height:70vh;overflow-y:auto;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:inherit}',
        '.mp-bell-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #e4e6ea;font-size:.92rem;position:sticky;top:0;background:#fff}',
        '.mp-bell-clear{border:none;background:none;color:#1877f2;font-size:.78rem;cursor:pointer;font-family:inherit}',
        '.mp-bell-ask{display:block;width:calc(100% - 20px);margin:10px;padding:8px 10px;border:1px solid #b3d4f9;background:#f0f6ff;color:#0b3d91;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer;font-family:inherit;text-align:left}',
        '.mp-bell-note,.mp-bell-empty{padding:12px 14px;font-size:.8rem;color:#65676b}',
        '.mp-bell-row{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid #f0f2f5;text-decoration:none}',
        'a.mp-bell-row:hover{background:#f7f8fa}',
        '.mp-bell-row>i{margin-top:3px;color:#1877f2}.mp-bell-row.mp-ok>i{color:#2e7d32}.mp-bell-row.mp-warn>i{color:#e08600}.mp-bell-row.mp-error>i{color:#c62828}',
        '.mp-bell-time{font-size:.7rem;color:#8a8d91;margin-top:3px}',
        '@keyframes mpIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
        '@media (prefers-reduced-motion:reduce){.mp-toast{animation:none}}',
    ].join('\n');
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    window.PosterFeed = {
        subscribe: function (fn) { subs.push(fn); if (data) { try { fn(data, { fails: fails, lastOk: lastOk }); } catch (e) {} } },
        refresh: refresh,
        get: function () { return data; },
    };

    function start() { renderBell(); refresh(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
