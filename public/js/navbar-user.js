// Toggles the user-name dropdown in the navbar (see .navbar-user in
// style.css) — one listener handles every page since the widget's markup
// and class names are identical everywhere it appears.
// Group-post notifications on every signed-in page (this file is the one
// script they all share). The queue page loads it directly, earlier.
(function () {
    if (window.PosterFeed || document.querySelector('script[src^="/js/group-notify.js"]')) return;
    var s = document.createElement('script');
    s.src = '/js/group-notify.js';
    s.defer = true;
    document.head.appendChild(s);
})();

(function () {
    document.addEventListener('click', function (e) {
        const trigger = e.target.closest('.navbar-user');
        document.querySelectorAll('.navbar-user.open').forEach(el => {
            if (el !== trigger) el.classList.remove('open');
        });
        if (trigger) trigger.classList.toggle('open');
    });
})();
