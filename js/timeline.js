/**
 * timeline.js - Arrangement and clip management logic
 */

const Timeline = {
    arrangement: [], // { id, assetName, trackId, startTime, duration, offset }
    trackStates: {}, // trackId -> { volume, muted }
    playingSources: [],
    pixelsPerSecond: 50,
    isPlaylistPlaying: false,
    playheadPosition: 0,
    playStartTime: 0,
    playheadInterval: null,

    init() {
        const tracksArea = document.getElementById('timelineTracksArea');
        if (!tracksArea) return;

        // Idempotent UI setup
        tracksArea.innerHTML = '';
        const playhead = document.createElement('div');
        playhead.className = 'playhead';
        playhead.id = 'timelinePlayhead';
        tracksArea.appendChild(playhead);

        tracksArea.addEventListener('dragover', (e) => e.preventDefault());
        tracksArea.addEventListener('dragover', (e) => e.preventDefault());

        // Remove old listener if exists (heuristic: we can't easily remove anonymous, but we can set ondrop property or use named function)
        // Better: assigned a named handler so we can remove it? Or just rely on element clearing.
        // Wait: init() clears innerHTML, but 'tracksArea' is an existing element in DOM from index.html usually.
        // If tracksArea is cleared, children are gone. But the listener is on tracksArea itself.
        // We really should check if we already added listeners.
        if (!this.listenersAttached) {
            tracksArea.addEventListener('drop', (e) => this.handleDrop(e));
            this.listenersAttached = true;
        }

        // Playhead Dragger / Seeking
        const ruler = document.getElementById('timelineRuler');
        if (ruler) {
            const handleSeek = (e) => {
                const rect = ruler.getBoundingClientRect();
                // The scrolling parent is the one with overflow-x: auto
                // Using offsetX is much safer for click coordinate within element
                let offsetX = e.offsetX;

                // If e is synthetic or missing offsetX (e.g. mousemove sometimes), allow fallback
                if (offsetX === undefined) {
                    const scrollParent = ruler.parentElement;
                    offsetX = Math.max(0, e.clientX - rect.left + scrollParent.scrollLeft);
                }

                const newPos = offsetX / this.pixelsPerSecond;

                // If playing, we need to restart the audio at the new position
                if (this.isPlaylistPlaying) {
                    this.stopArrangement(true); // Stop but don't overwrite position with elapsed time
                    this.playheadPosition = newPos;
                    this.playArrangement();
                } else {
                    this.playheadPosition = newPos;
                    const ph = document.getElementById('timelinePlayhead');
                    if (ph) ph.style.left = offsetX + 'px';
                    const status = document.getElementById('playbackStatus');
                    if (status) status.innerText = this.formatTime(this.playheadPosition);
                }
            };

            // Cleanup old listeners to prevent stacking
            ruler.onmousedown = null;

            ruler.onmousedown = (e) => {
                handleSeek(e);
                const onMouseMove = (me) => handleSeek(me);
                const onMouseUp = () => {
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                    this.autosave(); // Save current playhead position
                };
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            };
        }

        const sidebar = document.getElementById('timelineSidebar');
        if (sidebar) sidebar.innerHTML = '<div class="timeline-ruler" style="height:30px; background:#ddd; border-bottom:1px solid #999;"></div>';

        // Initialize 8 default tracks
        for (let i = 0; i < 8; i++) {
            if (!this.trackStates[i]) this.trackStates[i] = { volume: 0.8, muted: false };
            this.createTrackUI(i);
        }

        // Re-render clips if any
        this.arrangement.forEach(c => this.renderClip(c));
    },

    dispose() {
        this.stopArrangement();
        clearInterval(this.playheadInterval);
        const tracksArea = document.getElementById('timelineTracksArea');
        if (tracksArea) tracksArea.innerHTML = '';
        const sidebar = document.getElementById('timelineSidebar');
        if (sidebar) sidebar.innerHTML = '';
    },

    createTrackUI(trackId) {
        const sidebar = document.getElementById('timelineSidebar');
        const area = document.getElementById('timelineTracksArea');

        const block = document.createElement('div');
        block.className = 'track-control-block';
        block.innerHTML = `
            <div class="track-control-row" style="font-weight:bold; color:var(--accent);">TRACK ${trackId + 1}</div>
            <div class="track-control-row">
                <input type="checkbox" id="mute-${trackId}" ${!this.trackStates[trackId].muted ? 'checked' : ''}>
                <label>Enabled</label>
            </div>
            <div class="track-control-row">
                <input type="range" class="volume-slider" id="vol-${trackId}" min="0" max="1" step="0.1" value="${this.trackStates[trackId].volume}">
            </div>
        `;

        block.querySelector(`#mute-${trackId}`).onchange = (e) => {
            this.trackStates[trackId].muted = !e.target.checked;
            this.autosave();
        };
        block.querySelector(`#vol-${trackId}`).oninput = (e) => {
            this.trackStates[trackId].volume = parseFloat(e.target.value);
            this.autosave();
        };

        sidebar.appendChild(block);

        const trackArea = document.createElement('div');
        trackArea.className = 'timeline-track';
        trackArea.dataset.trackId = trackId;
        area.appendChild(trackArea);
    },

    handleDrop(e) {
        e.preventDefault();
        const assetName = e.dataTransfer.getData('text/plain');
        if (!assetName) return;

        const track = e.target.closest('.timeline-track');
        if (!track) return;

        const trackId = parseInt(track.dataset.trackId);
        const rect = track.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const startTime = (offsetX + document.getElementById('timelineContainer').scrollLeft) / this.pixelsPerSecond;

        this.addClip(assetName, trackId, startTime);
    },

    async addClip(assetName, trackId, startTime) {
        const assets = await window.StorageManager.getAssets();
        const asset = assets.find(a => a.name === assetName);
        if (!asset) return;
        const file = await asset.getFile();

        // Branch for MIDI vs Audio
        let clipData = {
            id: Date.now(),
            assetName,
            trackId,
            startTime,
            offset: 0,
            duration: 0,
            originalDuration: 0,
            waveformData: null,
            midiData: null
        };

        if (assetName.endsWith('.midi.json')) {
            const text = await file.text();
            const data = JSON.parse(text); // { duration, events }
            clipData.duration = data.duration;
            clipData.originalDuration = data.duration;
            clipData.midiData = data.events;
            clipData.type = 'midi';
        } else {
            const { filteredData, duration } = await window.AudioManager.getWaveformData(file);
            clipData.duration = duration;
            clipData.originalDuration = duration;
            clipData.waveformData = filteredData;
            clipData.type = 'audio';
        }

        // MIDI BAKE LOGIC
        if (assetName.endsWith('.midi.json')) {
            // Show loading
            if (window.App && window.App.status) window.App.status("Rendering MIDI to Audio...");

            try {
                // Determine sf
                const sfName = document.getElementById('globalSoundFontSelect') ? document.getElementById('globalSoundFontSelect').value : null;

                // Render
                const wavBlob = await window.AudioManager.renderMidiToWav(asset, sfName);
                const wavName = assetName.replace('.midi.json', `_Rendered_${Date.now()}.wav`);

                // Save new asset
                await window.StorageManager.saveFile(wavName, wavBlob);
                window.dispatchEvent(new CustomEvent('asset-saved', { detail: { name: wavName } }));

                // Recursively add the NEW audio clip instead of this MIDI clip
                // We return here to stop adding the MIDI clip
                setTimeout(() => this.addClip(wavName, trackId, startTime), 100);
                if (window.App && window.App.status) window.App.status("MIDI Rendered & Added.");
                return;
            } catch (e) {
                console.error("MIDI Bake Failed", e);
                alert("Failed to render MIDI: " + e.message);
                return;
            }
        }

        this.arrangement.push(clipData);
        this.renderClip(clipData);
        this.autosave();
    },

    renderClip(clip) {
        const track = document.querySelector(`.timeline-track[data-track-id="${clip.trackId}"]`);
        const el = document.createElement('div');
        el.className = 'clip';
        el.id = `clip-${clip.id}`;

        const canvas = document.createElement('canvas');
        canvas.className = 'clip-waveform';
        el.appendChild(canvas);

        const label = document.createElement('div');
        label.className = 'clip-label';
        label.innerText = clip.assetName;
        el.appendChild(label);

        const resizerL = document.createElement('div');
        resizerL.className = 'resizer resizer-l';
        el.appendChild(resizerL);

        const resizerR = document.createElement('div');
        resizerR.className = 'resizer resizer-r';
        el.appendChild(resizerR);

        this.updateClipStyle(el, clip);

        if (clip.type === 'midi') {
            this.drawClipMidi(canvas, clip);
        } else {
            this.drawClipWaveform(canvas, clip);
        }

        el.addEventListener('mousedown', (e) => this.handleClipInteraction(e, clip, el));
        el.oncontextmenu = (e) => {
            e.preventDefault();
            this.showClipContextMenu(e, clip, el);
        };

        track.appendChild(el);
    },

    showClipContextMenu(e, clip, el) {
        // Simple custom context menu
        const existing = document.getElementById('clipContextMenu');
        if (existing) existing.remove();

        const menu = document.createElement('div');
        menu.id = 'clipContextMenu';
        menu.style.cssText = `
            position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
            background: #222; border: 1px solid #444; padding: 5px 0;
            z-index: 1000; box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            min-width: 120px;
        `;

        const createItem = (text, onClick) => {
            const item = document.createElement('div');
            item.innerText = text;
            item.style.cssText = 'padding: 8px 15px; cursor: pointer; color: #eee; font-size: 12px;';
            item.onmouseover = () => item.style.background = '#444';
            item.onmouseout = () => item.style.background = 'transparent';
            item.onclick = () => { onClick(); menu.remove(); };
            menu.appendChild(item);
        };

        createItem('Rename', async () => {
            const newName = prompt("Rename clip (this renames the file):", clip.assetName);
            if (newName && newName !== clip.assetName) {
                // Perform deep rename
                const success = await window.StorageManager.renameAsset(clip.assetName, newName);
                if (success) {
                    // Update ALL clips with this name
                    this.arrangement.forEach(c => {
                        if (c.assetName === clip.assetName) c.assetName = newName;
                    });

                    // Update DOM
                    // Re-render everything is simplest to ensure consistency, 
                    // or just update labels. Let's re-render to be safe or update specific elements.
                    document.querySelectorAll(`.clip-label`).forEach(l => {
                        if (l.innerText === clip.assetName) l.innerText = newName; // This checks old name logic, tricky if already updated above.
                    });

                    // Actually, since we updated `this.arrangement`, we should refresh the view or labels.
                    // But `el` matches THIS clip.
                    this.init(); // Heavy handed but correct

                    this.autosave();
                    // Dispatch event to refresh sidebar
                    window.dispatchEvent(new CustomEvent('asset-saved', { detail: { name: newName } }));
                }
            }
        });

        createItem('Delete', () => {
            // Removed confirmation as requested
            this.arrangement = this.arrangement.filter(c => c.id !== clip.id);
            el.remove();
            this.autosave();
        });

        document.body.appendChild(menu);

        // click away to close
        const close = () => {
            menu.remove();
            window.removeEventListener('click', close);
        };
        setTimeout(() => window.addEventListener('click', close), 10);
    },

    updateClipStyle(el, clip) {
        el.style.left = (clip.startTime * this.pixelsPerSecond) + 'px';
        el.style.width = (clip.duration * this.pixelsPerSecond) + 'px';
    },

    drawClipWaveform(canvas, clip) {
        const ctx = canvas.getContext('2d');
        canvas.width = clip.duration * this.pixelsPerSecond;
        canvas.height = 70;

        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        const data = clip.waveformData;
        const step = data.length / (clip.originalDuration * this.pixelsPerSecond);
        const viewOffset = clip.offset * this.pixelsPerSecond * (data.length / (clip.originalDuration * this.pixelsPerSecond));

        ctx.beginPath();
        for (let i = 0; i < canvas.width; i++) {
            const dataIdx = Math.floor(viewOffset + i * step);
            const val = data[dataIdx] || 0;
            const h = val * canvas.height * 2;
            ctx.fillRect(i, (canvas.height - h) / 2, 1, h);
        }
    },

    drawClipMidi(canvas, clip) {
        const ctx = canvas.getContext('2d');
        canvas.width = clip.duration * this.pixelsPerSecond;
        canvas.height = 70;

        // Background grid
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = 'rgba(0, 120, 214, 0.8)';
        const visibleStart = clip.offset;
        const visibleEnd = clip.offset + clip.duration;

        clip.midiData.forEach(event => {
            if (event.time >= visibleStart && event.time < visibleEnd) {
                if (event.type === 'noteOn') {
                    // Simple representation: note 0-127 mapped to height.
                    // Piano roll usually shows specific range. Let's assume C2-C6 (36-84) roughly.
                    const y = canvas.height - ((event.note - 36) / (84 - 36)) * canvas.height;
                    const x = (event.time - visibleStart) * this.pixelsPerSecond;
                    // Mock duration for visualization since recorder doesn't pair NoteOffs yet in the 'events' list efficiently for drawing
                    // We'll just draw a small block or try to find the noteOff?
                    // For now: fixed width block
                    ctx.fillRect(x, y, 10, 4);
                }
            }
        });
    },

    handleClipInteraction(e, clip, el) {
        const startX = e.clientX;
        const initialLeft = clip.startTime * this.pixelsPerSecond;
        const initialWidth = clip.duration * this.pixelsPerSecond;
        const initialOffset = clip.offset;
        const isResizerL = e.target.classList.contains('resizer-l');
        const isResizerR = e.target.classList.contains('resizer-r');

        const onMove = (me) => {
            const deltaX = me.clientX - startX;
            const deltaTime = deltaX / this.pixelsPerSecond;

            if (isResizerL) {
                const moveTime = Math.min(deltaTime, clip.duration - 0.1);
                const finalMove = Math.max(-initialOffset, moveTime); // Ensure offset doesn't go negative
                clip.startTime = (initialLeft / this.pixelsPerSecond) + finalMove;
                clip.offset = initialOffset + finalMove;
                clip.duration = (initialWidth / this.pixelsPerSecond) - finalMove;
            } else if (isResizerR) {
                clip.duration = Math.max(0.1, (initialWidth / this.pixelsPerSecond) + deltaTime);
                clip.duration = Math.min(clip.duration, clip.originalDuration - clip.offset);
            } else {
                clip.startTime = Math.max(0, (initialLeft / this.pixelsPerSecond) + deltaTime);
            }

            this.updateClipStyle(el, clip);
            if (clip.type === 'midi') this.drawClipMidi(el.querySelector('canvas'), clip);
            else this.drawClipWaveform(el.querySelector('canvas'), clip);
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.autosave();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    },

    getArrangementData() {
        return this.arrangement;
    },

    autosave() {
        if (window.StorageManager && window.StorageManager.projectHandle) {
            window.StorageManager.saveArrangement({
                arrangement: this.arrangement,
                trackStates: this.trackStates,
                playheadPosition: this.playheadPosition
            });
        }
    },

    loadArrangement(data) {
        if (!data) return;
        this.arrangement = data.arrangement || [];
        this.trackStates = data.trackStates || this.trackStates;

        // Restore playhead position if it was saved
        if (data.playheadPosition !== undefined) {
            this.playheadPosition = data.playheadPosition;
        }

        this.init();

        // Ensure playhead UI matches restored position
        const ph = document.getElementById('timelinePlayhead');
        if (ph) ph.style.left = (this.playheadPosition * this.pixelsPerSecond) + 'px';
        const status = document.getElementById('playbackStatus');
        if (status) status.innerText = this.formatTime(this.playheadPosition);
    },

    async playArrangement() {
        if (this.isPlaylistPlaying) this.stopArrangement();
        this.isPlaylistPlaying = true;

        // Use playhead position as start time if available
        const currentPos = this.playheadPosition || 0;
        this.playStartTime = window.AudioManager.audioContext.currentTime - currentPos;

        const assets = await window.StorageManager.getAssets();

        for (const clip of this.arrangement) {
            const trackState = this.trackStates[clip.trackId];
            if (trackState && trackState.muted) continue;

            const asset = assets.find(a => a.name === clip.assetName);
            if (!asset) continue;

            // Don't restart clips that ended before the playhead
            if (clip.startTime + clip.duration < currentPos) continue;

            // Calculate start and offset
            let when = this.playStartTime + clip.startTime;
            let offset = clip.offset;
            let duration = clip.duration;

            if (when < window.AudioManager.audioContext.currentTime) {
                const diff = window.AudioManager.audioContext.currentTime - when;
                offset += diff;
                duration -= diff;
                when = window.AudioManager.audioContext.currentTime;
            }

            if (duration <= 0) continue;

            // AUDIO PLAYBACK
            if (!clip.type || clip.type === 'audio') {
                const file = await asset.getFile();
                const { source, gainNode } = await window.AudioManager.createTrackSource(
                    file,
                    trackState ? trackState.volume : 0.8,
                    trackState ? trackState.muted : false
                );
                source.start(when, offset, duration);
                this.playingSources.push(source);
            }
            // MIDI PLAYBACK
            else if (clip.type === 'midi' && clip.midiData) {
                // Schedule MIDI events
                const startTimeInClip = offset;
                const endTimeInClip = offset + duration;

                clip.midiData.forEach(event => {
                    if (event.time >= startTimeInClip && event.time < endTimeInClip) {
                        const playTime = when + (event.time - startTimeInClip);
                        if (event.type === 'noteOn') {
                            window.midiSynth.noteOn(event.note, event.velocity, playTime);
                        } else if (event.type === 'noteOff') {
                            window.midiSynth.noteOff(event.note, playTime);
                        }
                    }
                });
            }
        }

        this.startPlayheadInterval();
    },

    startPlayheadInterval() {
        if (this.playheadInterval) clearInterval(this.playheadInterval);
        this.playheadInterval = setInterval(async () => {
            if (ModuleManager.isKilled('Timeline')) {
                this.stopArrangement();
                return;
            }

            let ph = document.getElementById('timelinePlayhead');
            let status = document.getElementById('playbackStatus');

            // If it's missing, try to re-init UI once if we're playing
            if (!ph || !status) {
                if (this.isPlaylistPlaying) {
                    console.warn("Timeline UI lost during playback. Attempting recovery...");
                    this.init(); // Re-creates ph
                    ph = document.getElementById('timelinePlayhead');
                    status = document.getElementById('playbackStatus');
                    if (!ph || !status) {
                        clearInterval(this.playheadInterval);
                        this.playheadInterval = null;
                        this.stopArrangement();
                        await App.showError("Timeline Playback UI Error", new Error("UI elements missing and recovery failed."), 'Timeline');
                        return;
                    }
                } else {
                    return;
                }
            }

            try {
                const elapsed = window.AudioManager.audioContext.currentTime - this.playStartTime;
                ph.style.left = (elapsed * this.pixelsPerSecond) + 'px';
                status.innerText = this.formatTime(elapsed);
            } catch (e) {
                clearInterval(this.playheadInterval);
                this.playheadInterval = null;
                await App.showError("Timeline Playback Loop Error", e, 'Timeline');
            }
        }, 30);
    },

    stopArrangement(preventPositionOverwrite = false) {
        const wasPlaying = this.isPlaylistPlaying;
        this.isPlaylistPlaying = false;

        this.playingSources.forEach(s => {
            try { s.stop(); } catch (e) { }
        });
        this.playingSources = [];

        // Stop all MIDI notes
        if (window.midiSynth) window.midiSynth.allNotesOff();

        if (this.playheadInterval) {
            clearInterval(this.playheadInterval);
            this.playheadInterval = null;
        }

        // Only update playheadPosition from the clock if we were actually playing
        // and we aren't currently in a seek/restart flow.
        if (wasPlaying && !preventPositionOverwrite) {
            const elapsed = window.AudioManager.audioContext.currentTime - this.playStartTime;
            this.playheadPosition = Math.max(0, elapsed);
        }
    },

    async exportMixdown() {
        // Offline Export Logic
        const duration = this.arrangement.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
        if (duration === 0) return alert("Nothing to export!");

        const offlineCtx = new OfflineAudioContext(2, duration * 44100, 44100);
        const assets = await window.StorageManager.getAssets();

        // Setup Offline Synth if needed
        let offlineSynth = null;
        if (this.arrangement.some(c => c.type === 'midi')) {
            offlineSynth = new window.MidiSynth(offlineCtx);
            offlineSynth.soundFont = window.midiSynth ? window.midiSynth.soundFont : null; // Share loaded SF
            // Important: Connect offlineSynth to offlineCtx destination
            offlineSynth.masterGain.connect(offlineCtx.destination);
        }

        for (const clip of this.arrangement) {
            const trackState = this.trackStates[clip.trackId];
            if (trackState.muted) continue;

            const asset = assets.find(a => a.name === clip.assetName);
            if (!asset) continue;

            // AUDIO RENDER
            if (!clip.type || clip.type === 'audio') {
                const file = await asset.getFile();
                const arrayBuffer = await file.arrayBuffer();
                const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

                const source = offlineCtx.createBufferSource();
                source.buffer = audioBuffer;

                const gain = offlineCtx.createGain();
                gain.gain.value = trackState.volume;

                source.connect(gain);
                gain.connect(offlineCtx.destination);

                source.start(clip.startTime, clip.offset, clip.duration);
            }
            // MIDI RENDER
            else if (clip.type === 'midi' && offlineSynth) {
                // Determine start in offline time
                const clipStart = clip.startTime;

                // Set volume for this track? Synth doesn't have per-note volume gain easily accessible per track 
                // unless we change MasterGain or handle voices manually. 
                // For simplicity, we assume global synth volume for now, 
                // or we could modulate velocity by track volume.
                const trackVol = trackState.volume;

                clip.midiData.forEach(event => {
                    const eventTime = event.time; // time within clip
                    if (eventTime >= clip.offset && eventTime < clip.offset + clip.duration) {
                        const absTime = clipStart + (eventTime - clip.offset);
                        if (event.type === 'noteOn') {
                            offlineSynth.noteOn(event.note, Math.floor(event.velocity * trackVol), absTime);
                        } else if (event.type === 'noteOff') {
                            offlineSynth.noteOff(event.note, absTime);
                        }
                    }
                });
            }
        }

        const renderedBuffer = await offlineCtx.startRendering();
        this.downloadWAV(renderedBuffer);
    },

    downloadWAV(buffer) {
        // Simple WAV encoder
        const numOfChan = buffer.numberOfChannels;
        const length = buffer.length * numOfChan * 2 + 44;
        const bufferArr = new ArrayBuffer(length);
        const view = new DataView(bufferArr);
        const channels = [];
        let i;
        let sample;
        let offset = 0;
        let pos = 0;

        // write WAVE header
        setUint32(0x46464952);                         // "RIFF"
        setUint32(length - 8);                         // file length - 8
        setUint32(0x45564157);                         // "WAVE"

        setUint32(0x20746d66);                         // "fmt " chunk
        setUint32(16);                                 // length = 16
        setUint16(1);                                  // PCM (uncompressed)
        setUint16(numOfChan);
        setUint32(buffer.sampleRate);
        setUint32(buffer.sampleRate * 2 * numOfChan);  // avg. bytes/sec
        setUint16(numOfChan * 2);                      // block-align
        setUint16(16);                                 // 16-bit (hardcoded in this encoder)

        setUint32(0x61746164);                         // "data" - chunk
        setUint32(length - pos - 4);                   // chunk length

        // write interleaved data
        for (i = 0; i < buffer.numberOfChannels; i++)
            channels.push(buffer.getChannelData(i));

        while (pos < buffer.length) {
            for (i = 0; i < numOfChan; i++) {             // interleave channels
                sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
                view.setInt16(44 + offset, sample, true);          // write 16-bit sample
                offset += 2;
            }
            pos++;
        }

        // Helper functions
        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

        const blob = new Blob([bufferArr], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mixdown_${Date.now()}.wav`;
        a.click();
    },

    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = (seconds % 60).toFixed(1);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(4, '0')}`;
    }
};

window.Timeline = Timeline;
