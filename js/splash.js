(() => {
    const splash = document.getElementById('appSplash');
    if (!splash) return;

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        splash.classList.add('loaded');
        setTimeout(() => splash.remove(), 550);
    };

    // Wait for the app's startup path, but never leave the user stuck on the splash.
    window.addEventListener('verbatimfx-ready', dismiss, { once: true });
    window.addEventListener('error', () => setTimeout(dismiss, 900), { once: true });
    setTimeout(dismiss, 4500);
})();
