/**
 * BLAKCIDE — Shared Sidebar Utilities
 * Handles: day/night theme toggle persistence
 * Mobile sidebar toggle is handled per-page (chat: app.js, journal: journal.js, others: inline)
 */
(function () {
    // ── 1. Apply saved theme immediately (before paint) ──────────
    const saved = localStorage.getItem('blakcide-theme');
    if (saved === 'light') {
        document.documentElement.classList.add('light-mode');
    }

    // ── 2. Wire everything up after DOM is ready ─────────────────
    function init() {
        wireThemeToggles();
    }

    // ── Theme toggle ─────────────────────────────────────────────
    function wireThemeToggles() {
        document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
            refreshThemeIcon(btn);
            btn.addEventListener('click', () => {
                const isLight = document.documentElement.classList.toggle('light-mode');
                localStorage.setItem('blakcide-theme', isLight ? 'light' : 'dark');
                document.querySelectorAll('.theme-toggle-btn').forEach(refreshThemeIcon);
            });
        });
    }

    function refreshThemeIcon(btn) {
        const isLight = document.documentElement.classList.contains('light-mode');
        const icon = btn.querySelector('ion-icon');
        const label = btn.querySelector('span');
        if (icon) icon.setAttribute('name', isLight ? 'moon-outline' : 'sunny-outline');
        if (label) label.textContent = isLight ? 'Dark mode' : 'Light mode';
    }

    // Expose for re-wiring after dynamic DOM changes
    window.blakcideSidebarCommon = { refreshThemeIcon, wireThemeToggles };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
