(() => {
    const splash = document.getElementById('appSplash');
    if (!splash) return;

    let dismissed = false;
    const statusEl = splash.querySelector('.splash-status');

    const setStatus = (msg) => {
        if (statusEl) statusEl.textContent = msg;
    };

    const dismiss = (reason) => {
        if (dismissed) return;
        dismissed = true;
        setStatus(reason === 'ready' ? 'Ready' : 'Starting…');
        splash.classList.add('loaded');
        // Remove after fade so it cannot block the UI
        setTimeout(() => {
            try { splash.remove(); } catch (_) {}
        }, 550);
    };

    setStatus('Loading modules…');

    // Primary path: app finished binding UI
    window.addEventListener('verbatimfx-ready', () => dismiss('ready'), { once: true });

    // If a startup error occurs, still clear the splash so the user can recover
    window.addEventListener('error', () => {
        setStatus('Recovering…');
        setTimeout(() => dismiss('error'), 600);
    }, { once: true });

    // Safety only: never leave the user stuck if ready never fires
    setTimeout(() => {
        if (!dismissed) {
            setStatus('Almost ready…');
            dismiss('timeout');
        }
    }, 8000);
})();
