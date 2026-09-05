/*
 * stability.js - Defensive storage and export safeguards.
 * Loaded after the existing modules so the established UI/recording flow remains intact.
 */
(() => {
    const storage = window.StorageManager;
    const timeline = window.Timeline;
    if (!storage || !timeline) return;

    let arrangementWrite = Promise.resolve();
    window.VerbatimFxRecovery = window.VerbatimFxRecovery || { pendingFiles: [] };

    async function writeFileDirect(name, blob) {
        if (!storage.projectHandle) throw new Error('No project folder is open. The file was not saved.');
        if (!(blob instanceof Blob) || blob.size === 0) throw new Error(`Refusing to save empty/invalid file: ${name}`);
        const handle = await storage.projectHandle.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(blob);
            await writable.close();
        } catch (error) {
            try { await writable.abort(); } catch (_) {}
            throw error;
        }
        const saved = await handle.getFile();
        if (saved.size !== blob.size) throw new Error(`Save verification failed for ${name}: expected ${blob.size} bytes, found ${saved.size}.`);
        return true;
    }

    storage.saveFile = async function (name, blob) {
        try {
            return await writeFileDirect(name, blob);
        } catch (error) {
            window.VerbatimFxRecovery.pendingFiles = window.VerbatimFxRecovery.pendingFiles.filter(f => f.name !== name);
            window.VerbatimFxRecovery.pendingFiles.push({ name, blob, failedAt: Date.now(), error: error.message });
            throw error;
        }
    };

    // Serialize arrangement writes so rapid timeline edits can never finish out of order.
    storage.saveArrangement = function (data) {
        let snapshot;
        try {
            snapshot = JSON.parse(JSON.stringify(data));
        } catch (error) {
            return Promise.reject(new Error(`Arrangement could not be serialized: ${error.message}`));
        }
        arrangementWrite = arrangementWrite.then(async () => {
            if (!storage.projectHandle) throw new Error('No project folder is open. Arrangement was not saved.');
            const json = JSON.stringify(snapshot, null, 2);
            const blob = new Blob([json], { type: 'application/json' });

            // Keep a verified last-known-good copy before replacing the live arrangement.
            try {
                const oldHandle = await storage.projectHandle.getFileHandle('arrangement.vfx');
                const oldFile = await oldHandle.getFile();
                await writeFileDirect('arrangement.vfx.bak', oldFile);
            } catch (error) {
                if (error && error.name !== 'NotFoundError') throw new Error(`Could not protect the existing arrangement: ${error.message}`);
            }

            await writeFileDirect('arrangement.vfx', blob);
            return true;
        });
        return arrangementWrite.catch(error => {
            console.error('Arrangement save failed:', error);
            throw error;
        });
    };

    storage.loadArrangement = async function () {
        if (!storage.projectHandle) return null;
        try {
            const handle = await storage.projectHandle.getFileHandle('arrangement.vfx');
            const data = JSON.parse(await (await handle.getFile()).text());
            if (!data || !Array.isArray(data.arrangement)) throw new Error('Invalid arrangement format.');
            return data;
        } catch (primaryError) {
            try {
                const handle = await storage.projectHandle.getFileHandle('arrangement.vfx.bak');
                const data = JSON.parse(await (await handle.getFile()).text());
                if (!data || !Array.isArray(data.arrangement)) throw new Error('Backup is invalid.');
                console.warn('VerbatimFx recovered arrangement from arrangement.vfx.bak');
                return data;
            } catch (backupError) {
                console.warn('No usable arrangement or backup found.', primaryError, backupError);
                return null;
            }
        }
    };

    function validateArrangement(arrangement, assets) {
        if (!Array.isArray(arrangement)) throw new Error('Arrangement data is invalid.');
        const names = new Set(assets.map(a => a.name));
        const missing = [];
        arrangement.forEach((clip, index) => {
            if (!clip || typeof clip !== 'object') throw new Error(`Invalid clip at index ${index}.`);
            if (!names.has(clip.assetName)) missing.push(clip.assetName);
            if (!Number.isFinite(clip.startTime) || clip.startTime < 0) throw new Error(`Invalid start time on clip ${index}.`);
            if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error(`Invalid duration on clip ${index}.`);
            if (!Number.isFinite(clip.offset) || clip.offset < 0) throw new Error(`Invalid offset on clip ${index}.`);
            if (clip.originalDuration != null && clip.offset > clip.originalDuration) throw new Error(`Invalid offset on clip ${index}.`);
        });
        if (missing.length) throw new Error(`Export stopped: missing asset${missing.length === 1 ? '' : 's'}: ${[...new Set(missing)].join(', ')}`);
    }

    timeline.exportMixdown = async function () {
        const arrangement = this.arrangement || [];
        if (!arrangement.length) throw new Error('Nothing to export: the timeline is empty.');
        const assets = await storage.getAssets();
        validateArrangement(arrangement, assets);
        const active = arrangement.filter(c => !(this.trackStates[c.trackId] && this.trackStates[c.trackId].muted));
        if (!active.length) throw new Error('Nothing to export: all tracks are muted.');

        const duration = active.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Export duration is invalid.');
        const sampleRate = 44100;
        const frames = Math.ceil(duration * sampleRate);
        if (frames < 1 || frames > 0x7fffffff) throw new Error('Export is too large for the browser audio engine.');

        const offlineCtx = new OfflineAudioContext(2, frames, sampleRate);
        let synth = null;
        if (active.some(c => c.type === 'midi')) {
            synth = new window.MidiSynth(offlineCtx);
            if (window.midiSynth && window.midiSynth.soundFont) synth.soundFont = window.midiSynth.soundFont;
            synth.masterGain.connect(offlineCtx.destination);
        }

        for (const clip of active) {
            const state = this.trackStates[clip.trackId] || { volume: 0.8, muted: false };
            const asset = assets.find(a => a.name === clip.assetName);
            if (!asset) throw new Error(`Asset disappeared during export: ${clip.assetName}`);

            if (!clip.type || clip.type === 'audio') {
                const file = await asset.getFile();
                let audioBuffer;
                try { audioBuffer = await offlineCtx.decodeAudioData((await file.arrayBuffer()).slice(0)); }
                catch (error) { throw new Error(`Could not decode ${clip.assetName}: ${error.message}`); }
                if (clip.offset >= audioBuffer.duration) throw new Error(`Clip offset exceeds source duration: ${clip.assetName}`);
                const maxDuration = Math.min(clip.duration, audioBuffer.duration - clip.offset, duration - clip.startTime);
                if (maxDuration <= 0) continue;
                const source = offlineCtx.createBufferSource();
                const gain = offlineCtx.createGain();
                source.buffer = audioBuffer;
                gain.gain.value = Number.isFinite(state.volume) ? Math.max(0, Math.min(1, state.volume)) : 0.8;
                source.connect(gain).connect(offlineCtx.destination);
                source.start(clip.startTime, clip.offset, maxDuration);
            } else if (clip.type === 'midi' && synth) {
                const end = clip.offset + clip.duration;
                (clip.midiData || []).forEach(event => {
                    if (!Number.isFinite(event.time) || event.time < clip.offset || event.time >= end) return;
                    const t = clip.startTime + event.time - clip.offset;
                    if (t < 0 || t >= duration) return;
                    if (event.type === 'noteOn') synth.noteOn(event.note, Math.floor((event.velocity || 0) * state.volume), t);
                    else if (event.type === 'noteOff') synth.noteOff(event.note, t);
                });
            }
        }

        if (window.App && App.status) App.status('Rendering WAV export...');
        const rendered = await offlineCtx.startRendering();
        const blob = encodeWAV(rendered);
        await validateWAV(blob, rendered);

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

    function encodeWAV(audio) {
        const channels = audio.numberOfChannels, frames = audio.length, bytes = frames * channels * 2;
        const out = new ArrayBuffer(44 + bytes), view = new DataView(out);
        let p = 0;
        const u16 = v => { view.setUint16(p, v, true); p += 2; };
        const u32 = v => { view.setUint32(p, v, true); p += 4; };
        const text = s => { for (const ch of s) view.setUint8(p++, ch.charCodeAt(0)); };
        text('RIFF'); u32(36 + bytes); text('WAVE'); text('fmt '); u32(16); u16(1); u16(channels); u32(audio.sampleRate); u32(audio.sampleRate * channels * 2); u16(channels * 2); u16(16); text('data'); u32(bytes);
        const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
        for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
            const sample = Math.max(-1, Math.min(1, data[c][i] || 0));
            view.setInt16(p, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true); p += 2;
        }
        return new Blob([out], { type: 'audio/wav' });
    }

    async function validateWAV(blob, audio) {
        const expected = 44 + audio.length * audio.numberOfChannels * 2;
        if (blob.size !== expected) throw new Error(`WAV size validation failed: ${blob.size} != ${expected}.`);
        const bytes = new Uint8Array(await blob.slice(0, 44).arrayBuffer());
        const text = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data') throw new Error('WAV header validation failed.');
        if (view.getUint32(40, true) !== blob.size - 44) throw new Error('WAV data chunk size validation failed.');
    }

    const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    window.VerbatimFxStability = { validateArrangement, validateWAV };
})();
