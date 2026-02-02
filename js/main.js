/**
 * main.js - Application entry point and UI Glue
 */

const Logger = {
    log(msg, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${msg}`);
        const status = document.getElementById('statusLeft');
        if (status) status.innerText = `Status: ${msg}`;

        // Also log to a verbose area if we had one, for now console is key
        if (type === 'error') alert("Error: " + msg);
    }
};

const ModuleManager = {
    modules: {},
    failedModules: new Set(),
    ignoredErrors: new Set(),

    register(name, module) {
        this.modules[name] = module;
    },

    isKilled(name) {
        return this.failedModules.has(name);
    },

    async restart(name) {
        try {
            this.failedModules.delete(name);
            Logger.log(`Restarting module: ${name}...`);
            const module = this.modules[name];
            if (!module) throw new Error(`Module ${name} not found`);

            if (module.dispose) await module.dispose();
            if (module.init) await module.init();

            Logger.log(`${name} restarted successfully.`);

            // Special handling for UI updates after restart
            if (name === 'AudioManager') {
                App.refreshHardware();
            }
            return true;
        } catch (e) {
            Logger.log(`Failed to restart ${name}: ${e.message}`, 'error');
            await App.showError(`Failed to restart ${name}`, e, name);
            return false;
        }
    },

    kill(name) {
        this.failedModules.add(name);
        const module = this.modules[name];
        if (module && module.dispose) module.dispose();
        Logger.log(`Module ${name} has been KILLED.`, 'error');
    }
};

const App = {
    async init() {
        // Global Error Handler
        window.onerror = async (msg, source, lineno, colno, error) => {
            await this.showError('Global Error', error || new Error(msg));
        };
        window.onunhandledrejection = async (e) => {
            await this.showError('Unhandled Promise', e.reason);
        };

        try {
            Logger.log("Initializing UI...");
            this.bindEvents(); // MUST BE FIRST - Make UI interactive

            // Register Modules
            ModuleManager.register('AudioManager', window.AudioManager);
            ModuleManager.register('Timeline', window.Timeline);
            ModuleManager.register('StorageManager', window.StorageManager);

            Logger.log("Initializing Timeline...");
            window.Timeline.init();

            Logger.log("VerbatimFx is Ready.");

            // We do NOT await AudioManager.init here if it blocks.
            // But we must wait for it to create the context before making the Synth.
            window.AudioManager.init().then(() => {
                // Initialize Synth
                if (!window.midiSynth) {
                    window.midiSynth = new window.MidiSynth(window.AudioManager.audioContext);
                } else if (window.AudioManager.audioContext !== window.midiSynth.ctx) {
                    // Re-init context if changed
                    window.midiSynth.ctx = window.AudioManager.audioContext;
                    window.midiSynth.masterGain = window.midiSynth.ctx.createGain(); // Recreate gain
                    window.midiSynth.masterGain.gain.value = 0.5;
                    window.midiSynth.masterGain.connect(window.midiSynth.ctx.destination);
                }
            }).catch(e => {
                Logger.log("Audio Init Warning: " + e.message);
                this.showUnlockOverlay();
            });

            // Delay hardware refresh slightly to allow init to proceed
            setTimeout(() => this.refreshHardware(), 100);

        } catch (e) {
            Logger.log("Startup Critical Failure: " + e.message, 'error');
            this.showError("Startup Failed", e);
        }
    },

    showUnlockOverlay() {
        if (document.getElementById('unlockOverlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'unlockOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.8); z-index: 2000;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            backdrop-filter: blur(5px);
        `;
        overlay.innerHTML = `
            <h2 style="color:white;">Hardware Engine Blocked</h2>
            <p style="color:#aaa;">Browser requires a click to enable audio hardware.</p>
            <button id="btnUnlock" class="btn btn-primary" style="padding: 15px 30px; font-size: 18px;">Start VerbatimFx Engine</button>
        `;
        document.body.appendChild(overlay);
        document.getElementById('btnUnlock').onclick = async () => {
            await window.AudioManager.unlock();
            overlay.remove();
            Logger.log("Engine Started Successfully.");
            this.refreshHardware();
        };
    },

    async showError(title, error, moduleName = 'General') {
        const errorKey = `${moduleName}:${error.message}`;
        if (ModuleManager.ignoredErrors.has(errorKey)) return;
        if (ModuleManager.isKilled(moduleName)) return;

        return new Promise((resolve) => {
            let popup = document.getElementById('errorPopup');
            if (!popup) {
                popup = document.createElement('div');
                popup.id = 'errorPopup';
                popup.style.cssText = `
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: #222; color: white; padding: 20px; border-radius: 8px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.8); z-index: 5000; min-width: 350px;
                    border: 2px solid #f44336; font-family: sans-serif;
                `;
                document.body.appendChild(popup);
            }

            const msg = error.message || error.toString();
            const stack = error.stack ? `<pre style="font-size:10px; opacity:0.6; overflow:auto; max-height:100px; background:#111; padding:10px; margin:10px 0;">${error.stack}</pre>` : '';

            popup.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:15px;">
                    <div style="width:12px; height:12px; background:#f44336; border-radius:50%;"></div>
                    <h3 style="margin:0; color:#f44336; letter-spacing:1px;">${title.toUpperCase()}</h3>
                </div>
                <p style="font-size:14px; line-height:1.4;">${msg}</p>
                ${stack}
                <div style="margin-top:20px; display:flex; gap:8px; flex-wrap:wrap;">
                    <button id="err-ignore" style="padding:8px 12px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer;">Ignore</button>
                    <button id="err-restart" style="padding:8px 12px; background:var(--accent); color:white; border:none; border-radius:4px; cursor:pointer;">Restart ${moduleName}</button>
                    <button id="err-kill" style="padding:8px 12px; background:#b71c1c; color:white; border:none; border-radius:4px; cursor:pointer;">Kill Module</button>
                </div>
            `;

            document.getElementById('err-ignore').onclick = () => {
                ModuleManager.ignoredErrors.add(errorKey);
                popup.remove();
                resolve('ignored');
            };

            document.getElementById('err-restart').onclick = async () => {
                popup.remove();
                await ModuleManager.restart(moduleName);
                resolve('restarted');
            };

            document.getElementById('err-kill').onclick = () => {
                ModuleManager.kill(moduleName);
                popup.remove();
                resolve('killed');
            };
        });
    },

    bindEvents() {
        // Add manual module restart menu
        const debugMenu = document.createElement('li');
        debugMenu.innerHTML = 'Debug';
        debugMenu.onclick = () => {
            this.showError("Module Manager", { message: "Manual Restart Control", stack: "Select a module to restart below." });
        };
        // document.querySelector('.menu-bar ul').appendChild(debugMenu); // Optional: add to menu


        // Tab Switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');

                if (tab.dataset.panel === 'devices') this.refreshHardware();
            };
        });

        // Project Folder
        document.getElementById('menuOpen').onclick = async () => {
            try {
                const handle = await window.StorageManager.selectProjectFolder();
                if (handle) {
                    this.updateProjectUI();
                    const arrangement = await window.StorageManager.loadArrangement();
                    window.Timeline.loadArrangement(arrangement);
                    this.refreshSidebar();
                }
            } catch (e) { Logger.log("Project Load Error: " + e.message, 'error'); }
        };

        document.getElementById('menuSaveTimeline').onclick = async () => {
            try {
                const data = window.Timeline.getArrangementData();
                await window.StorageManager.saveArrangement(data);
                this.status("Project arrangement saved.");
            } catch (e) { Logger.log("Save Error: " + e.message, 'error'); }
        };

        // Master Record
        const btnRec = document.getElementById('masterRecord');
        const btnStop = document.getElementById('masterStop');

        btnRec.onclick = () => {
            if (window.AudioManager.activeInputs.size === 0 && !window.AudioManager.hasActiveMidiInputs()) {
                alert("Please select at least one audio or MIDI input device.");
                return;
            }
            try {
                window.AudioManager.startMasterRecord();
                btnRec.classList.add('recording');
                btnRec.disabled = true;
                btnStop.disabled = false;
                this.status("Recording...");
            } catch (e) { this.showError("Recording Error", e); }
        };

        btnStop.onclick = () => {
            try {
                window.AudioManager.stopMasterRecord();
                btnRec.classList.remove('recording');
                btnRec.disabled = false;
                btnStop.disabled = true;
                this.status("Recording stopped and saved.");
                setTimeout(() => this.refreshSidebar(), 500);
            } catch (e) { this.showError("Stop Recording Error", e); }
        };

        // Timeline Controls
        document.getElementById('timelinePlay').onclick = () => window.Timeline.playArrangement();
        document.getElementById('timelineStop').onclick = () => window.Timeline.stopArrangement();
        document.getElementById('timelineExport').onclick = async () => {
            this.status("Exporting mixdown (WAV)...");
            // Placeholder for real mixdown logic
            // alert("Mixdown feature: This would render the timeline to a single file. For now, please save clips individually.");
            await window.Timeline.exportMixdown();
        };

        // Hardware Perms
        document.getElementById('menuRequestPermissions').onclick = async () => {
            try {
                const granted = await window.AudioManager.requestPermissions();
                if (granted) {
                    this.refreshHardware();
                    this.status("Hardware permissions granted.");
                }
            } catch (e) { this.showError("Permissions Error", e); }
        };

        document.getElementById('menuRefreshHardware').onclick = () => this.refreshHardware();

        // Listeners
        window.addEventListener('asset-saved', (e) => {
            this.status(`Track saved: ${e.detail.name}`);
            this.refreshSidebar(); // Auto refresh sidebar !
        });

        window.addEventListener('midi-hardware-change', (e) => {
            this.status(`Hardware change: ${e.detail.name} ${e.detail.state}`);
            this.refreshHardware();
        });
    },

    async refreshHardware() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        let midiInputs = [];
        if (window.AudioManager.midiAccess) {
            midiInputs = Array.from(window.AudioManager.midiAccess.inputs.values());
        }

        const grid = document.getElementById('deviceGrid');
        grid.innerHTML = '';

        // Audio Devices
        audioInputs.forEach((d, i) => {
            const alias = window.StorageManager.getAlias(d.deviceId);
            const isInternal = d.label.toLowerCase().includes('integrated') || d.label.toLowerCase().includes('realtek');
            const displayLabel = isInternal ? `integrated mic (${d.label || 'Default'})` : `external device ${i + 1} (${d.label || 'Device'})`;

            // Check if already active to persist UI state
            const isActive = window.AudioManager.activeInputs.has(d.deviceId);

            const card = document.createElement('div');
            card.className = 'device-card';
            if (isActive) card.style.borderColor = '#0f0'; // Visual cue

            card.innerHTML = `
                <div class="device-row">
                    <input type="checkbox" class="device-enable" data-id="${d.deviceId}" ${isActive ? 'checked' : ''}>
                    <div class="device-name">${displayLabel}</div>
                    <input type="text" class="alias-input" placeholder="Give it an alias..." value="${alias}">
                </div>
            `;

            const check = card.querySelector('.device-enable');
            const aliasInput = card.querySelector('.alias-input');

            aliasInput.onchange = () => {
                window.StorageManager.setAlias(d.deviceId, aliasInput.value);
                Logger.log(`Alias updated for ${d.label}`);
            };

            check.onchange = async () => {
                try {
                    if (check.checked) {
                        const input = await window.AudioManager.startMonitoring(d.deviceId, aliasInput.value);
                        if (input) {
                            this.addMonitorTrack(d.deviceId, input);
                            card.style.borderColor = '#0f0';
                        }
                    } else {
                        window.AudioManager.stopMonitoring(d.deviceId);
                        this.removeMonitorTrack(d.deviceId);
                        card.style.borderColor = '#020';
                    }
                } catch (e) {
                    Logger.log("Hardware toggle failed: " + e.message, 'error');
                    check.checked = !check.checked; // Revert UI
                }
            };

            grid.appendChild(card);
        });

        // MIDI Devices
        midiInputs.forEach(d => {
            // Check if enabled (default true)
            const enabled = window.AudioManager.isMidiEnabled(d.id);

            const card = document.createElement('div');
            card.className = 'device-card';
            if (enabled) card.style.borderColor = '#0f0';

            card.innerHTML = `
                <div class="device-row">
                    <input type="checkbox" class="midi-enable" data-id="${d.id}" ${enabled ? 'checked' : ''}>
                    <div style="color:var(--accent); font-weight:bold;">MIDI</div>
                    <div class="device-name">${d.name}</div>
                </div>
                <div class="midi-monitor">
                    <canvas class="midi-canvas" id="midi-${d.id}" style="width:100%; height:100%;"></canvas>
                </div>
            `;
            grid.appendChild(card);

            // Toggle Handler
            card.querySelector('.midi-enable').onchange = (e) => {
                window.AudioManager.setMidiEnabled(d.id, e.target.checked);

                // Update Settings
                if (!window.StorageManager.settings.midiEnabled) window.StorageManager.settings.midiEnabled = {};
                window.StorageManager.settings.midiEnabled[d.id] = e.target.checked;
                window.StorageManager.saveSettings();

                card.style.borderColor = e.target.checked ? '#0f0' : '#444';

                // Add/Remove Monitor
                if (e.target.checked) this.addMidiMonitorTrack(d);
                else this.removeMonitorTrack(d.id);
            };

            // Restore State from Settings
            if (window.StorageManager.settings.midiEnabled && window.StorageManager.settings.midiEnabled[d.id] !== undefined) {
                const state = window.StorageManager.settings.midiEnabled[d.id];
                window.AudioManager.setMidiEnabled(d.id, state);
                card.querySelector('.midi-enable').checked = state;
                if (state) {
                    card.style.borderColor = '#0f0';
                    // Defer monitor add slightly to ensure container readiness
                    setTimeout(() => this.addMidiMonitorTrack(d), 100);
                }
            } else {
                // Default ON if not set? Or use current logic.
                // Current logic defaults to TRUE in AudioManager.isMidiEnabled
                this.addMidiMonitorTrack(d);
            }

            const canvas = card.querySelector('.midi-canvas');

            // Wire up listeners
            // 1. Visualizer (Always active if device exists)
            window.AudioManager.listenMidi(d.id, (data) => {
                if (window.Visualizers) window.Visualizers.drawMidiActivity(canvas, data);
            });

            // 2. Synth (Live Playback via Passthrough)
            window.AudioManager.listenMidi(d.id, (data) => {
                if (!window.midiSynth) return;
                // Only play if Passthrough is ON and Device is ENABLED
                if (!window.AudioManager.midiPassthrough) return;
                if (!window.AudioManager.isMidiEnabled(d.id)) return;

                const [status, note, velocity] = data;
                const cmd = status & 0xF0;
                if (cmd === 0x90 && velocity > 0) {
                    window.midiSynth.noteOn(note, velocity);
                } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
                    window.midiSynth.noteOff(note);
                }
            });
        });

        // Append SoundFont Selector to Device Grid (Global)
        this.renderSoundFontSelector(grid);
    },

    async renderSoundFontSelector(container) {
        const assets = await window.StorageManager.getAssets();
        const soundfonts = assets.filter(a => a.name.endsWith('.sf2'));

        const wrapper = document.createElement('div');
        wrapper.className = 'device-card';
        wrapper.style.borderColor = 'var(--accent)';
        wrapper.innerHTML = `
            <div class="device-row">
                <div style="color:var(--accent); font-weight:bold;">SYNTH</div>
                <div class="device-name">SoundFont & MIDI Settings</div>
            </div>
            <div style="margin-top: 10px;">
                <label style="display:block; margin-bottom:5px; font-size:12px; color:#aaa;">Active SoundFont:</label>
                <select id="globalSoundFontSelect" style="width: 100%; padding: 5px; background: #333; color: white; border: 1px solid #555;">
                    <option value="">(Default: Basic Waveform)</option>
                    ${soundfonts.map(sf => `<option value="${sf.name}" ${window.StorageManager.settings.soundFont === sf.name ? 'selected' : ''}>${sf.name}</option>`).join('')}
                </select>
            </div>
            <div style="margin-top: 10px; display:flex; align-items:center; gap:10px;">
                 <input type="checkbox" id="midiPassthroughToggle" ${window.StorageManager.settings.midiPassthrough ? 'checked' : ''}>
                 <label for="midiPassthroughToggle" style="font-size:13px; cursor:pointer;">MIDI Audio Passthrough</label>
            </div>
        `;

        container.insertBefore(wrapper, container.firstChild);

        // Passthrough Toggle Logic
        wrapper.querySelector('#midiPassthroughToggle').onchange = (e) => {
            window.AudioManager.midiPassthrough = e.target.checked;
            window.StorageManager.settings.midiPassthrough = e.target.checked;
            window.StorageManager.saveSettings();
            Logger.log(`MIDI Passthrough: ${e.target.checked ? 'ON' : 'OFF'}`);
        };

        const select = wrapper.querySelector('#globalSoundFontSelect');

        // Restore SoundFont State
        if (window.StorageManager.settings.soundFont && window.midiSynth && !window.midiSynth.soundFont) {
            const name = window.StorageManager.settings.soundFont;
            const asset = soundfonts.find(s => s.name === name);
            if (asset) {
                // Trigger load
                window.StorageManager.loadSoundFont(name).then(buffer => {
                    if (buffer) window.midiSynth.loadSoundFont(buffer);
                });
            }
        }
        // Restore Passthrough State
        window.AudioManager.midiPassthrough = window.StorageManager.settings.midiPassthrough;


        select.onchange = async () => {
            if (!window.midiSynth) return;

            const name = select.value;
            window.StorageManager.settings.soundFont = name;
            window.StorageManager.saveSettings();

            if (name) {
                Logger.log(`Loading SoundFont: ${name}...`);
                const buffer = await window.StorageManager.loadSoundFont(name);
                if (buffer) {
                    await window.midiSynth.loadSoundFont(buffer);
                    Logger.log(`SoundFont loaded.`);
                }
            } else {
                window.midiSynth.soundFont = null;
                Logger.log("Switched to Basic Waveform Synth");
            }
        };
    },

    addMonitorTrack(id, input) {
        // ... (existing audio code)
        const container = document.getElementById('monitorTracks');
        // Clear placeholder if present
        if (container.innerText.includes('Select hardware')) container.innerHTML = '';
        if (document.getElementById(`monitor-${id}`)) return; // No duplicates

        const track = document.createElement('div');
        track.className = 'monitor-track';
        track.id = `monitor-${id}`;
        track.innerHTML = `
            <div class="track-label">${input.alias}</div>
            <div class="level-meter-bg">
                <div class="level-meter-fill" id="meter-${id}"></div>
            </div>
        `;
        container.appendChild(track);

        // Start level meter polling
        const updateMeter = () => {
            if (!document.getElementById(`monitor-${id}`)) return;
            const level = window.AudioManager.getLevels(id);
            const fill = document.getElementById(`meter-${id}`);
            if (fill) fill.style.width = (level * 100) + '%';
            requestAnimationFrame(updateMeter);
        };
        updateMeter();
    },

    addMidiMonitorTrack(device) {
        const container = document.getElementById('monitorTracks');
        if (container.innerText.includes('Select hardware')) container.innerHTML = '';
        if (document.getElementById(`monitor-${device.id}`)) return;

        const track = document.createElement('div');
        track.className = 'monitor-track';
        track.id = `monitor-${device.id}`;
        track.innerHTML = `
            <div class="track-label" style="color:var(--accent);">${device.name} (MIDI)</div>
            <div class="level-meter-bg">
                <div class="level-meter-fill" id="meter-${device.id}" style="background:var(--accent);"></div>
            </div>
        `;
        container.appendChild(track);

        // For MIDI levels, we need a way to get 'activity'
        // We can hook into the existing listener or create a simplified level meter in AudioManager
        // Since we don't have getMidiLevels, let's just make it visually react heavily to noteOn
        const updateMeter = () => {
            if (!document.getElementById(`monitor-${device.id}`)) return;
            // Hacky: check if notes are falling in visualizer state? 
            // Better: AudioManager.getMidiLevel(id)
            const level = window.AudioManager.getMidiLevel ? window.AudioManager.getMidiLevel(device.id) : 0;
            const fill = document.getElementById(`meter-${device.id}`);
            if (fill) fill.style.width = (level * 100) + '%';
            requestAnimationFrame(updateMeter);
        };
        updateMeter();
    },

    removeMonitorTrack(id) {
        const track = document.getElementById(`monitor-${id}`);
        if (track) {
            window.Visualizers.stopVisualizer(track.querySelector('canvas'));
            track.remove();
        }
    },

    async refreshSidebar() {
        try {
            const assets = await window.StorageManager.getAssets();
            const list = document.getElementById('assetSidebar');
            list.innerHTML = '';

            if (assets.length === 0) {
                list.innerHTML = '<div style="padding: 20px; text-align: center; color: #aaa; font-size: 11px;">No assets found in folder.</div>';
                return;
            }

            assets.forEach(file => {
                const item = document.createElement('div');
                item.className = 'asset-item';
                item.innerText = file.name;
                item.draggable = true;
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', file.name);
                });
                list.appendChild(item);
            });
        } catch (e) {
            Logger.log("Failed to refresh sidebar: " + e.message, 'error');
        }
    },

    updateProjectUI() {
        const display = document.getElementById('projectInfoDisplay');
        if (window.StorageManager.projectHandle) {
            display.innerText = `Project: ${window.StorageManager.projectHandle.name}`;
        }
    },

    status(msg) {
        Logger.log(msg);
    }
};

window.onload = () => App.init();
