// Shared by every signed-in page.

// Group-post notifications (public/js/group-notify.js). The queue page loads
// it directly, earlier.
(function () {
    if (window.PosterFeed || document.querySelector('script[src^="/js/group-notify.js"]')) return;
    var s = document.createElement('script');
    s.src = '/js/group-notify.js';
    s.defer = true;
    document.head.appendChild(s);
})();

// Toggles the user-name dropdown in the navbar (see .navbar-user in
// style.css) — one listener handles every page since the widget's markup
// and class names are identical everywhere it appears.
(function () {
    document.addEventListener('click', function (e) {
        const trigger = e.target.closest('.navbar-user');
        document.querySelectorAll('.navbar-user.open').forEach(el => {
            if (el !== trigger) el.classList.remove('open');
        });
        if (trigger) trigger.classList.toggle('open');
    });
})();

// Shown inside SmartBoss (an iframe): SmartBoss already has its own header,
// and its window is narrow, where the left menu here is hidden — so drop our
// brand bar and give the group-posting pages a tab strip instead.
(function () {
    var embedded = false;
    try { embedded = window.top !== window.self; } catch (e) { embedded = true; }
    if (!embedded) return;
    document.documentElement.classList.add('mp-embedded');

    var TABS = [
        ['/job-queue', 'สร้างโพส / คิว', 'fa-pen-to-square'],
        ['/group-history', 'ประวัติ', 'fa-clock-rotate-left'],
        ['/group-overview', 'ภาพรวม', 'fa-chart-line'],
        ['/groups', 'กลุ่ม', 'fa-users-rectangle'],
    ];
    var css = [
        // SmartBoss's own header and toolbar sit above us (the bell is there too,
        // see group-notify.js) — our top bar would only be a second, empty one.
        'html.mp-embedded .navbar{display:none}',
        'html.mp-embedded .page-wrap{margin-top:0;padding-top:.75rem}',
        'html.mp-embedded .sidebar,html.mp-embedded .right-panel{top:.75rem}',
        '.mp-embed-tabs{grid-column:1/-1;display:none;gap:.35rem;overflow-x:auto;padding:.1rem 0 .2rem;scrollbar-width:none}',
        '.mp-embed-tabs::-webkit-scrollbar{display:none}',
        '.mp-embed-tabs a{flex-shrink:0;display:inline-flex;align-items:center;gap:.4rem;padding:.42rem .85rem;border-radius:999px;background:#fff;color:#1c1e21;font-size:.84rem;font-weight:600;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.08)}',
        '.mp-embed-tabs a i{color:#1877f2;font-size:.8rem}',
        '.mp-embed-tabs a.on{background:#1877f2;color:#fff}.mp-embed-tabs a.on i{color:#fff}',
        '.mp-embed-tabs a:focus-visible{outline:2px solid #1877f2;outline-offset:2px}',
        '@media (max-width:960px){html.mp-embedded .mp-embed-tabs{display:flex}}',
    ].join('\n');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    function addTabs() {
        var wrap = document.querySelector('.page-wrap');
        if (!wrap || document.querySelector('.mp-embed-tabs')) return;
        var nav = document.createElement('nav');
        nav.className = 'mp-embed-tabs';
        nav.setAttribute('aria-label', 'เมนูโพส & แชร์ลงกลุ่ม');
        TABS.forEach(function (t) {
            var a = document.createElement('a');
            a.href = t[0];
            if (location.pathname === t[0] || (t[0] !== '/' && location.pathname.indexOf(t[0] + '/') === 0)) {
                a.className = 'on';
                a.setAttribute('aria-current', 'page');
            }
            var i = document.createElement('i');
            i.className = 'fa-solid ' + t[2];
            a.appendChild(i);
            a.appendChild(document.createTextNode(t[1]));
            nav.appendChild(a);
        });
        wrap.insertBefore(nav, wrap.firstChild);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTabs); else addTabs();
})();
