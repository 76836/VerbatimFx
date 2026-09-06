(() => {
    const splash = document.getElementById('appSplash');
    if (!splash) return;

    let dismissed = false;
    const statusEl = splash.querySelector('.splash-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    const dismiss = (reason) => {
        if (dismissed) return;
        dismissed = true;
        setStatus(reason === 'ready' || reason === 'startup' ? 'Ready' : 'Starting…');
        splash.classList.add('loaded');
        setTimeout(() => { try { splash.remove(); } catch (_) {} }, 550);
    };

    setStatus('Loading modules…');

    window.addEventListener('verbatimfx-ready', () => {
        setStatus('Checking project access…');
        // If settings-ui is not present, dismiss on ready; otherwise wait briefly for gate
        const hasGate = typeof window.VerbatimFxStartup !== 'undefined'
            || document.querySelector('script[src*="settings-ui"]');
        if (!hasGate) dismiss('ready');
        // else wait for startup-complete (or timeout below)
    }, { once: true });

    window.addEventListener('verbatimfx-startup-complete', () => dismiss('startup'), { once: true });

    window.addEventListener('error', () => {
        setStatus('Recovering…');
        setTimeout(() => dismiss('error'), 600);
    }, { once: true });

    // Safety: never leave the user stuck
    setTimeout(() => {
        if (!dismissed) {
            setStatus('Almost ready…');
            dismiss('timeout');
        }
    }, 10000);
})();
