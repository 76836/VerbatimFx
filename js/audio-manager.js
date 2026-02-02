/**
 * audio-manager.js - Multi-track recording and playback engine
 */

const AudioManager = {
    audioContext: null,
    activeInputs: new Map(), // deviceId -> { stream, source, recorder, chunks, alias, analyser, monitorGain }
    midiAccess: null,
    midiListeners: new Map(), // deviceId -> Set<callback>
    activeMidiInputs: new Map(), // deviceId -> { name, recorder: MidiRecorder }
    midiEnabled: new Map(), // deviceId -> boolean
    midiPassthrough: false,
    midiLevels: new Map(), // deviceId -> currentLevel (0-1)
    levelBuffers: new Map(), // deviceId -> Uint8Array

    async init() {
        // Ensure clean state
        if (this.audioContext && this.audioContext.state !== 'closed') {
            await this.audioContext.close();
        }

        // Re-create context
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Non-blocking resume attempt
        this.audioContext.resume().catch(e => {
            console.warn("AudioContext resume failed (gesture required)", e);
        });

        if (navigator.requestMIDIAccess) {
            try {
                this.midiAccess = await navigator.requestMIDIAccess();
                this.midiAccess.onstatechange = (e) => this.onMidiStateChange(e);

                // Initialize existing inputs
                this.midiAccess.inputs.forEach(input => {
                    this.setupMidiInput(input);
                });
            } catch (e) {
                console.warn("MIDI Access failed", e);
            }
        }
    },

    setupMidiInput(input) {
        input.onmidimessage = (e) => {
            // Dispatch to listeners
            if (this.midiListeners.has(input.id)) {
                this.midiListeners.get(input.id).forEach(cb => cb(e.data));
            }

            // Dispatch to active recorder if recording
            if (this.activeMidiInputs.has(input.id)) {
                const state = this.activeMidiInputs.get(input.id);
                if (state.recorder && state.recorder.isRecording) {
                    state.recorder.recordEvent(e.data);
                }
            }

            // Track levels
            const [status, note, velocity] = e.data;
            if ((status & 0xf0) === 0x90 && velocity > 0) {
                this.midiLevels.set(input.id, velocity / 127);
            }
        };
    },

    listenMidi(deviceId, callback) {
        if (!this.midiAccess) return;

        if (!this.midiListeners.has(deviceId)) {
            this.midiListeners.set(deviceId, new Set());
        }
        this.midiListeners.get(deviceId).add(callback);
    },

    stopListeningMidi(deviceId, callback) {
        if (this.midiListeners.has(deviceId)) {
            this.midiListeners.get(deviceId).delete(callback);
        }
    },

    setMidiEnabled(deviceId, enabled) {
        this.midiEnabled.set(deviceId, enabled);
    },

    isMidiEnabled(deviceId) {
        if (!this.midiEnabled.has(deviceId)) return true; // Default enabled
        return this.midiEnabled.get(deviceId);
    },

    hasActiveMidiInputs() {
        if (!this.midiAccess) return false;
        // Check if any connected input is enabled
        return Array.from(this.midiAccess.inputs.values()).some(input => this.isMidiEnabled(input.id));
    },

    async unlock() {
        if (!this.audioContext) await this.init();
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        return this.audioContext.state === 'running';
    },

    async requestPermissions() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            return true;
        } catch (e) {
            return false;
        }
    },

    async startMonitoring(deviceId, alias) {
        if (this.activeInputs.has(deviceId)) {
            return this.activeInputs.get(deviceId);
        }

        Logger.log(`Requesting access to device: ${deviceId.slice(0, 8)}...`);

        let stream;
        try {
            // First try with strict, modern constraints
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: deviceId },
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false
                }
            });
        } catch (e) {
            console.warn("Strict constraints failed, falling back to permissive mode.", e);
            try {
                // Fallback: Just the deviceId, let browser handle the rest
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { deviceId: deviceId }
                });
            } catch (e2) {
                Logger.log(`Hardware Access Denied: ${e2.message}`, 'error');
                throw e2;
            }
        }

        if (!stream || stream.getAudioTracks().length === 0) {
            throw new Error("No audio tracks found in stream.");
        }

        try {
            // Ensure context is ready
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const source = this.audioContext.createMediaStreamSource(stream);
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 256;

            // CRITICAL: Silent routing to destination ensures processing in all browsers
            const monitorGain = this.audioContext.createGain();
            monitorGain.gain.value = 0.0001; // Extremely low, but not zero, simplifies some browser optimizations

            source.connect(analyser);
            analyser.connect(monitorGain);
            monitorGain.connect(this.audioContext.destination);

            this.activeInputs.set(deviceId, {
                stream,
                source,
                recorder: null,
                chunks: [],
                alias: alias || deviceId.slice(0, 8),
                analyser: analyser,
                monitorGain: monitorGain
            });

            // Pre-allocate buffer for levels
            this.levelBuffers.set(deviceId, new Uint8Array(analyser.frequencyBinCount));

            Logger.log(`Monitoring active for ${alias || deviceId.slice(0, 8)}`);
            return this.activeInputs.get(deviceId);
        } catch (e) {
            Logger.log("Web Audio Setup Failed: " + e.message, 'error');
            stream.getTracks().forEach(t => t.stop());
            throw e;
        }
    },

    getLevels(deviceId) {
        const input = this.activeInputs.get(deviceId);
        if (!input) return 0;

        const data = this.levelBuffers.get(deviceId);
        input.analyser.getByteFrequencyData(data);

        let max = 0;
        for (let i = 0; i < data.length; i++) {
            if (data[i] > max) max = data[i];
        }

        // Return 0-1 peak value
        return max / 255;
    },

    getMidiLevel(deviceId) {
        let level = this.midiLevels.get(deviceId) || 0;
        // Decay
        if (level > 0) {
            level *= 0.9;
            if (level < 0.01) level = 0;
            this.midiLevels.set(deviceId, level);
        }
        return level;
    },

    // Playback engine functions
    async createTrackSource(blob, volume = 1, muted = false) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;

        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = muted ? 0 : volume;

        source.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        return { source, gainNode, duration: audioBuffer.duration };
    },

    stopMonitoring(deviceId) {
        const input = this.activeInputs.get(deviceId);
        if (input) {
            input.stream.getTracks().forEach(t => t.stop());
            this.activeInputs.delete(deviceId);
        }
    },

    startMasterRecord() {
        // Audio Recording
        this.activeInputs.forEach((input, id) => {
            input.chunks = [];
            // ... (existing audio code omitted for brevity in thought, but included in tool)
            // Wait, I must include the existing code or use a smaller chunk if I can match it exactly.
            // The user wants me to update startMasterRecord.
            try {
                input.recorder = new MediaRecorder(input.stream, {
                    mimeType: 'audio/webm;codecs=opus',
                    audioBitsPerSecond: 128000
                });
            } catch (e1) {
                console.warn("High quality recording not supported, falling back.");
                try {
                    input.recorder = new MediaRecorder(input.stream);
                } catch (e2) {
                    console.error("Recording failed to initialize", e2);
                    return;
                }
            }

            input.recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) input.chunks.push(e.data);
            };
            input.recorder.onstop = async () => {
                const blob = new Blob(input.chunks, { type: 'audio/webm' });
                const name = `${input.alias.replace(/\s+/g, '_')}_${Date.now()}.webm`;
                await window.StorageManager.saveFile(name, blob);
                window.dispatchEvent(new CustomEvent('asset-saved', { detail: { name } }));
            };
            input.recorder.start(100);
        });

        // MIDI Recording
        if (this.midiAccess) {
            this.midiAccess.inputs.forEach(input => {
                // Check if we are "monitoring" this midi device? 
                // For now, let's record ALL connected/listening MIDI devices or add a toggle?
                // The UI in main.js "midiInputs.forEach" draws them unconditionally. 
                // Let's assume we record all MIDI inputs for now, or we should track "active" ones.
                // The plan said "update startMasterRecord to initialize a MidiRecorder if MIDI inputs are active".
                // I'll add logic to track active MIDI inputs in `activeMidiInputs`.

                // Only record if enabled
                if (!this.isMidiEnabled(input.id)) return;

                if (!this.activeMidiInputs.has(input.id)) {
                    this.activeMidiInputs.set(input.id, {
                        name: input.name,
                        recorder: new window.MidiRecorder()
                    });
                }
                const state = this.activeMidiInputs.get(input.id);
                if (!state.recorder) state.recorder = new window.MidiRecorder();
                state.recorder.start();
            });
        }
    },

    async getWaveformData(blob, samples = 100) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        const rawData = audioBuffer.getChannelData(0);
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
            let blockStart = blockSize * i;
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum = sum + Math.abs(rawData[blockStart + j]);
            }
            filteredData.push(sum / blockSize);
        }
        return { filteredData, duration: audioBuffer.duration };
    },

    async renderMidiToWav(midiFileHandle, soundFontName) {
        // Read MIDI Data
        const text = await (await midiFileHandle.getFile()).text();
        const data = JSON.parse(text); // { duration, events }

        const duration = data.duration;
        if (duration <= 0) throw new Error("MIDI file has no duration.");

        // Setup Offline Context
        // Add a little tail for release
        const renderDuration = duration + 2.0;
        const offlineCtx = new OfflineAudioContext(2, renderDuration * 44100, 44100);

        // Setup Synth
        const offlineSynth = new window.MidiSynth(offlineCtx);
        offlineSynth.masterGain.connect(offlineCtx.destination);

        // Load SoundFont
        if (soundFontName) {
            const buffer = await window.StorageManager.loadSoundFont(soundFontName);
            if (buffer) await offlineSynth.loadSoundFont(buffer);
        }

        // Schedule Events
        const clipStart = 0;
        data.events.forEach(event => {
            const absTime = clipStart + event.time;
            if (event.type === 'noteOn') {
                offlineSynth.noteOn(event.note, event.velocity, absTime);
            } else if (event.type === 'noteOff') {
                offlineSynth.noteOff(event.note, absTime);
            }
        });

        // Render
        const renderedBuffer = await offlineCtx.startRendering();

        // Encode to WAV Blob
        return this.encodeWAV(renderedBuffer);
    },

    encodeWAV(buffer) {
        const numOfChan = buffer.numberOfChannels;
        const length = buffer.length * numOfChan * 2 + 44;
        const bufferArr = new ArrayBuffer(length);
        const view = new DataView(bufferArr);
        const channels = [];
        let i;
        let sample;
        let offset = 0;
        let pos = 0;

        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

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
        setUint16(16);                                 // 16-bit
        setUint32(0x61746164);                         // "data" - chunk
        setUint32(length - pos - 4);                   // chunk length

        for (i = 0; i < buffer.numberOfChannels; i++)
            channels.push(buffer.getChannelData(i));

        while (pos < buffer.length) {
            for (i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][pos]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
                view.setInt16(44 + offset, sample, true);
                offset += 2;
            }
            pos++;
        }

        return new Blob([bufferArr], { type: 'audio/wav' });
    },

    stopMasterRecord() {
        // Audio Stop
        this.activeInputs.forEach(input => {
            if (input.recorder && input.recorder.state !== 'inactive') {
                input.recorder.stop();
            }
        });

        // MIDI Stop
        this.activeMidiInputs.forEach(async (state, id) => {
            if (state.recorder && state.recorder.isRecording) {
                const data = state.recorder.stop();
                if (data.events.length > 0) {
                    const name = `${state.name.replace(/\s+/g, '_')}_${Date.now()}.midi.json`;
                    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
                    await window.StorageManager.saveFile(name, blob);
                    window.dispatchEvent(new CustomEvent('asset-saved', { detail: { name } }));
                }
            }
        });
    },

    onMidiStateChange(e) {
        window.dispatchEvent(new CustomEvent('midi-hardware-change', { detail: e.port }));
    },

    async dispose() {
        this.activeInputs.forEach((input, id) => {
            this.stopMonitoring(id);
        });
        if (this.audioContext && this.audioContext.state !== 'closed') {
            await this.audioContext.close();
        }
        this.audioContext = null;
    }
};

window.AudioManager = AudioManager;
