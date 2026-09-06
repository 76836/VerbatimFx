/* VerbatimFx appearance, startup gate, device suggestions, recording preflight, AIM toggle. */
(() => {
    const $ = (id) => document.getElementById(id);
    const LS_KEY = 'verbatimfx_appearance_v1';

    function settings() {
        return window.StorageManager?.settings || {};
    }

    function loadLocalAppearance() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            const s = settings();
            if (data.themeColor && !s.themeColor) s.themeColor = data.themeColor;
            if (data.themeColor2 && !s.themeColor2) s.themeColor2 = data.themeColor2;
            if (data.wallpaper && !s.wallpaper) s.wallpaper = data.wallpaper;
            if (typeof data.aimEnabled === 'boolean' && s.aimEnabled == null) s.aimEnabled = data.aimEnabled;
        } catch (_) {}
    }

    function saveLocalAppearance() {
        try {
            const s = settings();
            localStorage.setItem(LS_KEY, JSON.stringify({
                themeColor: s.themeColor || '#7dd3fc',
                themeColor2: s.themeColor2 || null,
                wallpaper: s.wallpaper || null,
                aimEnabled: !!s.aimEnabled
            }));
        } catch (_) {}
    }

    function save() {
        saveLocalAppearance();
        try {
            if (window.StorageManager?.projectHandle) {
                window.StorageManager.saveSettings?.();
            }
        } catch (_) {}
    }

    const brands = [
        ['fender', 'Fender'], ['marshall', 'Marshall'], ['vox', 'VOX'], ['orange', 'Orange'],
        ['mesa', 'Mesa/Boogie'], ['roland', 'Roland'], ['boss', 'BOSS'], ['peavey', 'Peavey'],
        ['line 6', 'Line 6'], ['line6', 'Line 6'], ['blackstar', 'Blackstar'], ['yamaha', 'Yamaha'],
        ['korg', 'Korg'], ['casio', 'Casio'], ['nord', 'Nord'], ['steinway', 'Steinway'],
        ['shure', 'Shure'], ['sennheiser', 'Sennheiser'], ['neumann', 'Neumann'], ['rode', 'RØDE'],
        ['akg', 'AKG'], ['audio-technica', 'Audio-Technica'], ['audio technica', 'Audio-Technica'],
        ['focusrite', 'Focusrite'], ['behringer', 'Behringer'], ['presonus', 'PreSonus'],
        ['motu', 'MOTU'], ['universal audio', 'Universal Audio'], ['apollo', 'Universal Audio'],
        ['scarlett', 'Focusrite'], ['m-audio', 'M-Audio'], ['akai', 'Akai'], ['novation', 'Novation']
    ];

    function suggestName(label) {
        const t = String(label || '').toLowerCase();
        if (!t.trim()) return 'Audio Input';
        const m = brands.find(([n]) => t.includes(n));
        if (m) return m[1];
        if (/mic|microphone|input/.test(t)) return 'Microphone';
        if (/piano|keyboard|keys|synth/.test(t)) return 'Piano / Keyboard';
        if (/guitar|amp|cab|distortion/.test(t)) return 'Guitar Amp';
        if (/drum|percussion|pad/.test(t)) return 'Drums / Percussion';
        if (/midi|controller/.test(t)) return 'MIDI Controller';
        // Still offer a cleaned label-based suggestion
        const cleaned = String(label).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
        return cleaned.slice(0, 40) || 'New Device';
    }

    async function hasPermission(h) {
        try {
            if (h?.queryPermission && await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
            if (h?.requestPermission && await h.requestPermission({ mode: 'readwrite' }) === 'granted') return true;
            return false;
        } catch {
            return false;
        }
    }

    async function verifyProjectAccess() {
        const h = window.StorageManager?.projectHandle;
        if (!h) {
            return {
                ok: false,
                title: 'Project folder required',
                detail: 'Choose a project folder with full read/write access before VerbatimFx can finish starting. Recordings and arrangements are saved there.'
            };
        }
        if (!(await hasPermission(h))) {
            return {
                ok: false,
                title: 'Project access required',
                detail: 'VerbatimFx needs full read/write access to protect recordings and arrangements. Re-select the folder and grant permission.'
            };
        }
        try {
            const n = `.__verbatimfx_access_${Date.now()}.tmp`;
            const f = await h.getFileHandle(n, { create: true });
            const w = await f.createWritable();
            await w.write('VerbatimFx access check');
            await w.close();
            await h.removeEntry(n);
            return { ok: true };
        } catch (e) {
            return {
                ok: false,
                title: 'Project folder is not writable',
                detail: `The project folder failed the write test: ${e.message}`
            };
        }
    }

    async function diskCheck() {
        if (!navigator.storage?.estimate) return { ok: true };
        try {
            const e = await navigator.storage.estimate();
            if (e.quota && (e.quota - (e.usage || 0)) < 16 * 1024 * 1024) {
                return {
                    ok: false,
                    title: 'Storage is almost full',
                    detail: 'Less than 16 MB free. Free device storage before recording, or pick another project location.'
                };
            }
        } catch (_) {}
        return { ok: true };
    }

    async function recordingPreflight() {
        const checks = [await verifyProjectAccess(), await diskCheck()];
        const audio = window.AudioManager?.activeInputs?.size || 0;
        const midi = !!(window.AudioManager?.hasActiveMidiInputs?.());
        if (!audio && !midi) {
            checks.push({
                ok: false,
                title: 'No recording input selected',
                detail: 'Open Devices / Configuration and enable at least one audio or MIDI input before recording.'
            });
        }
        if (window.AudioManager?.audioContext?.state === 'closed') {
            checks.push({
                ok: false,
                title: 'Audio engine is unavailable',
                detail: 'Restart the audio engine from Setup or click to unlock audio hardware, then try again.'
            });
        }
        if (window.AudioManager?.audioContext?.state === 'suspended') {
            checks.push({
                ok: false,
                title: 'Audio engine is suspended',
                detail: 'Click anywhere in the app or use Setup to unlock the audio engine, then try recording again.'
            });
        }
        return checks.filter((x) => !x.ok);
    }

    function showBlocking(m, actions = []) {
        let box = $('preflightDialog');
        if (!box) {
            box = document.createElement('div');
            box.id = 'preflightDialog';
            box.className = 'ice-dialog-backdrop';
            box.innerHTML = '<section class="ice-dialog ice-surface" role="dialog" aria-modal="true"><h2 id="preflightTitle"></h2><p id="preflightBody"></p><div id="preflightActions" class="ice-dialog-actions"></div></section>';
            document.body.appendChild(box);
        }
        $('preflightTitle').textContent = m.title || 'Notice';
        $('preflightBody').textContent = m.detail || '';
        const area = $('preflightActions');
        area.innerHTML = '';
        actions.forEach((a) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn ' + (a.primary ? 'btn-primary' : '');
            b.textContent = a.label;
            b.onclick = a.onclick;
            area.appendChild(b);
        });
        box.classList.add('open');
    }

    function hexToRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return [125, 211, 252];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }

    function applyAppearance() {
        const s = settings();
        const c = s.themeColor || '#7dd3fc';
        const c2 = s.themeColor2 || c;
        const [r, g, b] = hexToRgb(c);
        const root = document.documentElement;
        root.style.setProperty('--ice-accent', c);
        root.style.setProperty('--ice-accent-2', c2);
        root.style.setProperty('--accent', c);
        root.style.setProperty('--accent-2', c2);
        root.style.setProperty('--ice-glow', `rgba(${r},${g},${b},0.18)`);
        root.style.setProperty('--input-border', `rgba(${r},${g},${b},0.4)`);
        root.style.setProperty('--ice-border', `rgba(${Math.min(255, r + 20)},${Math.min(255, g + 20)},${Math.min(255, b + 20)},0.28)`);
        if (s.wallpaper) {
            root.style.setProperty('--verbatimfx-wallpaper', `url("${s.wallpaper}")`);
        } else {
            root.style.removeProperty('--verbatimfx-wallpaper');
        }
    }

    function openSettings() {
        const d = $('appearanceDialog');
        if (!d) return;
        const s = settings();
        if ($('themeColor')) $('themeColor').value = s.themeColor || '#7dd3fc';
        if ($('aimEnabled')) $('aimEnabled').checked = !!s.aimEnabled;
        if ($('wallpaperInput')) $('wallpaperInput').value = '';
        d.classList.add('open');
    }

    function chooseWallpaper(f) {
        if (!f) return;
        if (!/^image\//.test(f.type || '')) {
            showBlocking({
                title: 'Unsupported file',
                detail: 'Please choose an image file (PNG, JPEG, WebP, etc.).'
            }, [{ label: 'Close', primary: true, onclick: () => $('preflightDialog')?.classList.remove('open') }]);
            return;
        }
        if (f.size > 8 * 1024 * 1024) {
            showBlocking({
                title: 'Wallpaper is too large',
                detail: 'Choose an image smaller than 8 MB.'
            }, [{ label: 'Close', primary: true, onclick: () => $('preflightDialog')?.classList.remove('open') }]);
            return;
        }
        const r = new FileReader();
        r.onload = () => {
            settings().wallpaper = r.result;
            save();
            applyAppearance();
        };
        r.readAsDataURL(f);
    }

    function devicePopup(label, id) {
        const s = suggestName(label);
        showBlocking({
            title: 'New equipment detected',
            detail: label
                ? `VerbatimFx detected “${label}”. Suggested name: ${s}.`
                : `A new input device was connected. Suggested name: ${s}.`
        }, [
            {
                label: 'Use Suggested Name',
                primary: true,
                onclick: () => {
                    if (id && window.StorageManager?.setAlias) window.StorageManager.setAlias(id, s);
                    $('preflightDialog')?.classList.remove('open');
                    window.App?.refreshHardware?.();
                }
            },
            {
                label: 'Keep Name',
                onclick: () => $('preflightDialog')?.classList.remove('open')
            }
        ]);
    }

    async function startupGate() {
        const r = await verifyProjectAccess();
        if (r.ok) return true;
        window.VerbatimFxStartup.isBlocked = true;
        showBlocking(r, [{
            label: 'Choose Project Folder',
            primary: true,
            onclick: async () => {
                try {
                    const h = await window.StorageManager.selectProjectFolder();
                    if (h && await startupGate()) {
                        window.VerbatimFxStartup.isBlocked = false;
                        $('preflightDialog')?.classList.remove('open');
                        window.App?.updateProjectUI?.();
                        window.dispatchEvent(new Event('verbatimfx-project-ready'));
                        window.dispatchEvent(new Event('verbatimfx-startup-complete'));
                    }
                } catch (e) {
                    showBlocking({
                        title: 'Project selection failed',
                        detail: e.message || String(e)
                    }, [{ label: 'Try Again', primary: true, onclick: () => startupGate() }]);
                }
            }
        }]);
        return false;
    }

    function bind() {
        loadLocalAppearance();
        applyAppearance();

        const help = [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.includes('Help'));
        if (help && !$('menuSettings')) {
            const i = document.createElement('div');
            i.className = 'dropdown-item';
            i.id = 'menuSettings';
            i.textContent = 'Settings';
            help.querySelector('.dropdown')?.appendChild(i);
            i.onclick = openSettings;
        }

        $('themeColor')?.addEventListener('input', (e) => {
            settings().themeColor = e.target.value;
            save();
            applyAppearance();
        });
        $('wallpaperInput')?.addEventListener('change', (e) => chooseWallpaper(e.target.files?.[0]));
        $('clearWallpaper')?.addEventListener('click', () => {
            delete settings().wallpaper;
            save();
            applyAppearance();
        });
        $('aimEnabled')?.addEventListener('change', async (e) => {
            settings().aimEnabled = e.target.checked;
            save();
            if (e.target.checked) window.AIMHandTracking?.start?.();
            else window.AIMHandTracking?.stop?.();
        });

        const known = new Set();
        async function scan() {
            if (!navigator.mediaDevices?.enumerateDevices) return;
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                for (const d of devices) {
                    if (!d.deviceId) continue;
                    // Only audio inputs and (when labeled) new devices after first pass
                    if (d.kind && d.kind !== 'audioinput') continue;
                    if (known.size && !known.has(d.deviceId)) {
                        devicePopup(d.label || 'Audio input', d.deviceId);
                    }
                    known.add(d.deviceId);
                }
            } catch (_) {}
        }
        window.addEventListener('devicechange', () => {
            window.App?.refreshHardware?.();
            scan();
        });
        window.addEventListener('midi-hardware-change', (e) => {
            devicePopup(e.detail?.name || 'MIDI device', e.detail?.id);
        });
        scan();

        if (settings().aimEnabled) window.AIMHandTracking?.start?.();

        const rec = $('masterRecord');
        if (rec) {
            rec.onclick = async () => {
                const bad = await recordingPreflight();
                if (bad.length) {
                    showBlocking(bad[0], [
                        {
                            label: 'Open Setup',
                            primary: true,
                            onclick: () => {
                                $('preflightDialog')?.classList.remove('open');
                                $('menuSetup')?.click();
                            }
                        },
                        {
                            label: 'Open Devices',
                            onclick: () => {
                                $('preflightDialog')?.classList.remove('open');
                                // Prefer devices tab if present
                                const devTab = [...document.querySelectorAll('.tab, .dropdown-item, button')].find((el) =>
                                    /device/i.test(el.textContent || '')
                                );
                                devTab?.click?.();
                            }
                        },
                        {
                            label: 'Try Again',
                            onclick: () => {
                                $('preflightDialog')?.classList.remove('open');
                                rec.click();
                            }
                        }
                    ]);
                    return;
                }
                try {
                    window.AudioManager.startMasterRecord();
                    rec.classList.add('recording');
                    rec.disabled = true;
                    if ($('masterStop')) $('masterStop').disabled = false;
                    window.App?.status?.('Recording...');
                } catch (e) {
                    window.App?.showError?.('Recording Error', e);
                }
            };
        }

        startupGate().then((ok) => {
            if (ok) window.dispatchEvent(new Event('verbatimfx-startup-complete'));
        });
    }

    window.VerbatimFxStartup = {
        startupGate,
        verifyProjectAccess,
        recordingPreflight,
        applyAppearance,
        isBlocked: false
    };
    window.VerbatimFxSuggestName = suggestName;
    window.addEventListener('load', bind, { once: true });
})();
