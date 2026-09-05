/*
 * stability.js - Defensive storage and export safeguards.
 * Keeps the existing recording/timeline implementation intact while adding
 * verification, backups, recovery of failed writes, and strict export checks.
 */
(() => {
    const originalSaveFile = window.StorageManager.saveFile.bind(window.StorageManager);
    const originalSaveArrangement = window.StorageManager.saveArrangement.bind(window.StorageManager);
    const originalLoadArrangement = window.StorageManager.loadArrangement.bind(window.StorageManager);

    window.VerbatimFxRecovery = window.VerbatimFxRecovery || { pendingFiles: [] };

    async function verifiedSaveFile(name, blob) {
        if (!window.StorageManager.projectHandle) {
            throw new Error('No project folder is open. The file was not saved.');
        }
        if (!(blob instanceof Blob) || blob.size === 0) {
            throw new Error(`Refusing to save empty/invalid file: ${name}`);
        }

        try {
            await originalSaveFile(name, blob);
            const handle = await window.StorageManager.projectHandle.getFileHandle(name);
            const saved = await handle.getFile();
            if (saved.size !== blob.size) {
                throw new Error(`Save verification failed for ${name}: expected ${blob.size} bytes, found ${saved.size}.`);
            }
            return true;
        } catch (error) {
            window.VerbatimFxRecovery.pendingFiles = window.VerbatimFxRecovery.pendingFiles.filter(f => f.name !== name);
            window.VerbatimFxRecovery.pendingFiles.push({ name, blob, failedAt: Date.now(), error: error.message });
            throw error;
        }
    }

    window.StorageManager.saveFile = verifiedSaveFile;

    window.StorageManager.saveArrangement = async function (data) {
        if (!this.projectHandle) throw new Error('No project folder is open. Arrangement was not saved.');
        const json = JSON.stringify(data, null, 2);
        JSON.parse(json); // Validate serialization before touching the existing project file.
        const blob = new Blob([json], { type: 'application/json' });

        // Preserve the last known-good arrangement before replacing it.
        try {
            const existingHandle = await this.projectHandle.getFileHandle('arrangement.vfx');
            const existing = await existingHandle.getFile();
            await originalSaveFile('arrangement.vfx.bak', existing);
        } catch (error) {
            // A missing arrangement is normal. Any other backup failure blocks overwrite.
            if (error && error.name !== 'NotFoundError') throw new Error(`Could not protect the existing arrangement: ${error.message}`);
        }

        await verifiedSaveFile('arrangement.vfx', blob);
        return true;
    };

    window.StorageManager.loadArrangement = async function () {
        if (!this.projectHandle) return null;
        try {
            const handle = await this.projectHandle.getFileHandle('arrangement.vfx');
            const file = await handle.getFile();
            const data = JSON.parse(await file.text());
            if (!data || !Array.isArray(data.arrangement)) throw new Error('Invalid arrangement format.');
            return data;
        } catch (primaryError) {
            // Automatic recovery from the last known-good backup.
            try {
                const backupHandle = await this.projectHandle.getFileHandle('arrangement.vfx.bak');
                const backupFile = await backupHandle.getFile();
                const backup = JSON.parse(await backupFile.text());
                if (!backup || !Array.isArray(backup.arrangement)) throw new Error('Backup is invalid.');
                console.warn('VerbatimFx recovered arrangement.vfx from arrangement.vfx.bak');
                return backup;
            } catch (backupError) {
                console.warn('No usable arrangement or backup found.', primaryError, backupError);
                return null;
            }
        }
    };

    function validateArrangement(arrangement, assets) {
        if (!Array.isArray(arrangement)) throw new Error('Arrangement data is invalid.');
        const assetNames = new Set(assets.map(a => a.name));
        const missing = [];

        arrangement.forEach((clip, index) => {
            if (!clip || typeof clip !== 'object') throw new Error(`Invalid clip at index ${index}.`);
            if (!assetNames.has(clip.assetName)) missing.push(clip.assetName);
            if (!Number.isFinite(clip.startTime) || clip.startTime < 0) throw new Error(`Invalid start time on clip ${index}.`);
            if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error(`Invalid duration on clip ${index}.`);
            if (!Number.isFinite(clip.offset) || clip.offset < 0) throw new Error(`Invalid offset on clip ${index}.`);
            if (clip.originalDuration != null && clip.offset > clip.originalDuration) throw new Error(`Invalid offset on clip ${index}.`);
        });

        if (missing.length) {
            const unique = [...new Set(missing)];
            throw new Error(`Export stopped: ${unique.length} referenced asset${unique.length === 1 ? '' : 's'} are missing: ${unique.join(', ')}`);
        }
    }

    window.Timeline.exportMixdown = async function () {
        const arrangement = this.arrangement || [];
        if (!arrangement.length) throw new Error('Nothing to export: the timeline is empty.');

        const assets = await window.StorageManager.getAssets();
        validateArrangement(arrangement, assets);

        const activeClips = arrangement.filter(c => !(this.trackStates[c.trackId] && this.trackStates[c.trackId].muted));
        if (!activeClips.length) throw new Error('Nothing to export: all tracks are muted.');

        const duration = activeClips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Export duration is invalid.');

        // Keep the render size inside Web Audio's valid integer range.
        const sampleRate = 44100;
        const frameCount = Math.ceil(duration * sampleRate);
        if (frameCount < 1 || frameCount > 0x7fffffff) throw new Error('Export is too large for the browser audio engine.');

        const offlineCtx = new OfflineAudioContext(2, frameCount, sampleRate);
        let offlineSynth = null;
        if (activeClips.some(c => c.type === 'midi')) {
            offlineSynth = new window.MidiSynth(offlineCtx);
            if (window.midiSynth && window.midiSynth.soundFont) offlineSynth.soundFont = window.midiSynth.soundFont;
            offlineSynth.masterGain.connect(offlineCtx.destination);
        }

        for (const clip of activeClips) {
            const trackState = this.trackStates[clip.trackId] || { volume: 0.8, muted: false };
            const asset = assets.find(a => a.name === clip.assetName);
            if (!asset) throw new Error(`Asset disappeared during export: ${clip.assetName}`);

            if (!clip.type || clip.type === 'audio') {
                const file = await asset.getFile();
                const bytes = await file.arrayBuffer();
                let audioBuffer;
                try {
                    audioBuffer = await offlineCtx.decodeAudioData(bytes.slice(0));
                } catch (error) {
                    throw new Error(`Could not decode ${clip.assetName}: ${error.message}`);
                }
                if (clip.offset >= audioBuffer.duration) throw new Error(`Clip offset exceeds source duration: ${clip.assetName}`);
                const maxDuration = Math.min(clip.duration, audioBuffer.duration - clip.offset, duration - clip.startTime);
                if (maxDuration <= 0) continue;

                const source = offlineCtx.createBufferSource();
                source.buffer = audioBuffer;
                const gain = offlineCtx.createGain();
                gain.gain.value = Number.isFinite(trackState.volume) ? Math.max(0, Math.min(1, trackState.volume)) : 0.8;
                source.connect(gain).connect(offlineCtx.destination);
                source.start(clip.startTime, clip.offset, maxDuration);
            } else if (clip.type === 'midi' && offlineSynth) {
                const clipEnd = clip.offset + clip.duration;
                (clip.midiData || []).forEach(event => {
                    if (!Number.isFinite(event.time) || event.time < clip.offset || event.time >= clipEnd) return;
                    const time = clip.startTime + (event.time - clip.offset);
                    if (time < 0 || time >= duration) return;
                    if (event.type === 'noteOn') offlineSynth.noteOn(event.note, Math.floor((event.velocity || 0) * trackState.volume), time);
                    else if (event.type === 'noteOff') offlineSynth.noteOff(event.note, time);
                });
            }
        }

        if (window.App && App.status) App.status('Rendering WAV export...');
        const rendered = await offlineCtx.startRendering();
        const blob = encodeVerifiedWAV(rendered);
        validateWAV(blob, rendered);

        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = `mixdown_${Date.now()}.wav`;
            a.click();
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        if (window.App && App.status) App.status(`Export complete: ${formatBytes(blob.size)} WAV`);
        return blob;
    };

    function encodeVerifiedWAV(audio) {
        const channels = audio.numberOfChannels;
        const frames = audio.length;
        const bytesPerSample = 2;
        const dataSize = frames * channels * bytesPerSample;
        const out = new ArrayBuffer(44 + dataSize);
        const view = new DataView(out);
        let p = 0;
        const u16 = v => { view.setUint16(p, v, true); p += 2; };
        const u32 = v => { view.setUint32(p, v, true); p += 4; };
        const text = s => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };

        text('RIFF'); u32(36 + dataSize); text('WAVE');
        text('fmt '); u32(16); u16(1); u16(channels); u32(audio.sampleRate);
        u32(audio.sampleRate * channels * bytesPerSample); u16(channels * bytesPerSample); u16(16);
        text('data'); u32(dataSize);

        const data = [];
        for (let c = 0; c < channels; c++) data.push(audio.getChannelData(c));
        for (let i = 0; i < frames; i++) {
            for (let c = 0; c < channels; c++) {
                const sample = Math.max(-1, Math.min(1, data[c][i] || 0));
                const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
                view.setInt16(p, pcm, true); p += 2;
            }
        }
        return new Blob([out], { type: 'audio/wav' });
    }

    async function validateWAV(blob, audio) {
        if (blob.size !== 44 + audio.length * audio.numberOfChannels * 2) throw new Error('WAV size validation failed.');
        const header = new DataView(await blob.slice(0, 44).arrayBuffer());
        const read = (offset, length) => String.fromCharCode(...new Uint8Array(header.buffer.slice(offset, offset + length)));
        if (read(0, 4) !== 'RIFF' || read(8, 4) !== 'WAVE' || read(12, 4) !== 'fmt ' || read(36, 4) !== 'data') throw new Error('WAV header validation failed.');
        if (header.getUint32(40, true) !== blob.size - 44) throw new Error('WAV data chunk size validation failed.');
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    window.VerbatimFxStability = { validateArrangement, validateWAV };
})();
