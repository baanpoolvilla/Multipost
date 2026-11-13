// Redirects to /login whenever any fetch() call gets a 401 from the server
// (session expired / logged out elsewhere) — without this, pages calling
// fetch(...).then(res => res.json()) would just fail silently or show a
// confusing parse error instead of prompting the user to log in again.
(function () {
    const _fetch = window.fetch;
    window.fetch = function (...args) {
        return _fetch.apply(this, args).then(res => {
            if (res.status === 401) {
                window.location.href = '/login';
                return new Promise(() => {}); // never resolve — we're navigating away
            }
            return res;
        });
    };
})();

// Restore last page after an external reload. When this app is embedded in
// another shell (e.g. SmartBoss desktop app), the host can reload/remount the
// frame when its window regains focus — that reopens the start URL ("/") and
// the user loses the page they were on. A load that did NOT come from in-app
// navigation (referrer isn't our own origin) is treated as such a reload, and
// we jump back to the page last viewed in this tab (if recent).
(function () {
    const KEY = 'mp_last_path';
    const MAX_AGE_MS = 6 * 60 * 60 * 1000;
    const here = location.pathname + location.search + location.hash;
    try {
        let fromSelf = false;
        try { fromSelf = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch {}
        const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
        if (!fromSelf && saved && saved.path && saved.path !== here
            && Date.now() - saved.t < MAX_AGE_MS && !/^\/(login|logout)\b/.test(saved.path)) {
            location.replace(saved.path);
            return;
        }
        const save = () => {
            try { sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname + location.search + location.hash, t: Date.now() })); } catch {}
        };
        save();
        window.addEventListener('pagehide', save);
        window.addEventListener('hashchange', save);
    } catch {}
})();
