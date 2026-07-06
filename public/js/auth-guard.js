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
