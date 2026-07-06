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
