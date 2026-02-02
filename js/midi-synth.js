/**
 * midi-synth.js - Polyphonic Synthesizer & SoundFont Player
 */

class MidiSynth {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
        this.masterGain.gain.value = 0.5;

        this.voices = new Map(); // note -> { source, gain }
        this.soundFont = null; // { samples: [{ buffer, pitch, name, loopStart, loopEnd }] }
    }

    async loadSoundFont(arrayBuffer) {
        console.log("Parsing SoundFont (Simple Method)...");
        try {
            this.soundFont = this.parseSimpleSF2(arrayBuffer);
            console.log(`SoundFont loaded. Found ${this.soundFont.samples.length} samples.`);
        } catch (e) {
            console.error("SF2 Parse Failed", e);
            this.soundFont = null;
        }
    }

    // A lightweight parser that extracts samples from the 'sdta' chunk 
    // and metadata from the 'shdr' sub-chunk.
    parseSimpleSF2(buffer) {
        const view = new DataView(buffer);
        let offset = 0;

        function readString(len) {
            let s = '';
            for (let i = 0; i < len; i++) {
                if (offset + i >= buffer.byteLength) break;
                const c = view.getUint8(offset + i);
                if (c !== 0) s += String.fromCharCode(c);
            }
            offset += len;
            return s;
        }
        function readDw() {
            if (offset + 4 > buffer.byteLength) { offset = buffer.byteLength; return 0; }
            const v = view.getUint32(offset, true); offset += 4; return v;
        }
        function readW() {
            if (offset + 2 > buffer.byteLength) { offset = buffer.byteLength; return 0; }
            const v = view.getInt16(offset, true); offset += 2; return v;
        }
        function readWu() {
            if (offset + 2 > buffer.byteLength) { offset = buffer.byteLength; return 0; }
            const v = view.getUint16(offset, true); offset += 2; return v;
        }

        if (readString(4) !== 'RIFF') throw new Error("Not a RIFF file");
        readDw(); // size
        if (readString(4) !== 'sfbk') throw new Error("Not a SoundFont bank");

        let sdtaStart = -1;
        let shdrOffset = -1;
        let shdrSize = 0;

        // Walk chunks to find sdta and shdr
        let limit = 2000; // Increased limit
        while (offset + 8 < buffer.byteLength && limit-- > 0) {
            const id = readString(4);
            const size = readDw();
            const nextChunk = offset + size;

            if (id === 'LIST') {
                const listType = readString(4);
                if (listType === 'sdta') {
                    // Inside sdta LIST is 'smpl'
                    while (offset + 8 < nextChunk) {
                        const sid = readString(4);
                        const ssize = readDw();
                        if (sid === 'smpl') {
                            sdtaStart = offset;
                            break;
                        }
                        offset += ssize;
                    }
                }
                else if (listType === 'pdta') {
                    while (offset + 8 < nextChunk) {
                        const sid = readString(4);
                        const ssize = readDw();
                        if (sid === 'shdr') {
                            shdrOffset = offset;
                            shdrSize = ssize;
                        }
                        offset += ssize;
                    }
                }
            }
            offset = nextChunk;
        }

        if (sdtaStart === -1 || shdrOffset === -1) {
            throw new Error(`Missing required chunks (sdta:${sdtaStart !== -1}, shdr:${shdrOffset !== -1})`);
        }

        const samples = [];
        offset = shdrOffset;
        const count = Math.floor(shdrSize / 46);

        for (let i = 0; i < count - 1; i++) {
            const name = readString(20);
            const start = readDw();
            const end = readDw();
            const loopStart = readDw();
            const loopEnd = readDw();
            const sampleRate = readDw();
            const originalPitch = view.getUint8(offset); offset++;
            const pitchCorrection = view.getInt8(offset); offset++;
            const sampleLink = readWu();
            const sampleType = readWu();

            // Support Mono (1), Right (2), Left (4) and ROM counterparts
            const baseType = sampleType & 0x7FFF;
            if (baseType !== 1 && baseType !== 2 && baseType !== 4) continue;

            const len = end - start;
            // Increased limit to 10M samples (~226s at 44.1k)
            if (len <= 0 || len > 10000000) continue;

            const audioBuf = this.ctx.createBuffer(1, len, sampleRate);
            const channel = audioBuf.getChannelData(0);
            const absPos = sdtaStart + start * 2;

            if (absPos + len * 2 > buffer.byteLength) continue;

            for (let s = 0; s < len; s++) {
                const val = view.getInt16(absPos + s * 2, true);
                channel[s] = val / 32768.0;
            }

            samples.push({
                buffer: audioBuf,
                pitch: originalPitch,
                name: name
            });
        }

        return { samples };
    }

    noteOn(note, velocity, time = 0) {
        if (velocity === 0) {
            this.noteOff(note, time);
            return;
        }

        const t = time || this.ctx.currentTime;
        this.noteOff(note, t); // Kill prev

        // 1. Try SoundFont
        if (this.soundFont && this.soundFont.samples.length > 0) {
            // Find closest sample
            let best = null;
            let minDist = 999;

            for (const s of this.soundFont.samples) {
                const dist = Math.abs(s.pitch - note);
                if (dist < minDist) {
                    minDist = dist;
                    best = s;
                }
            }

            if (best) {
                const source = this.ctx.createBufferSource();
                source.buffer = best.buffer;

                // Pitch shift
                // detune = (note - best.pitch) * 100 cents
                source.detune.value = (note - best.pitch) * 100;

                const gain = this.ctx.createGain();
                gain.gain.value = velocity / 127;

                source.connect(gain);
                gain.connect(this.masterGain);
                source.start(t);

                this.voices.set(note, { source, gain });
                return;
            }
        }

        // 2. Fallback Oscillator
        const freq = 440 * Math.pow(2, (note - 69) / 12);
        const gainValue = velocity / 127;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.frequency.value = freq;
        osc.type = 'sawtooth';

        // Envelope
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(gainValue * 0.5, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(gainValue * 0.3, t + 0.2);
        gain.gain.setTargetAtTime(0, t + 0.5, 0.5); // Slow decay if held

        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.start(t);

        this.voices.set(note, { source: osc, gain: gain });
    }

    noteOff(note, time) {
        if (this.voices.has(note)) {
            const voice = this.voices.get(note);
            const t = time || this.ctx.currentTime;

            // Release envelope
            // For SF2 samples, usually we fade out.
            voice.gain.gain.cancelScheduledValues(t);
            voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
            voice.gain.gain.linearRampToValueAtTime(0, t + 0.1);

            voice.source.stop(t + 0.1);
            this.voices.delete(note);
        }
    }

    allNotesOff() {
        this.voices.forEach(v => {
            try {
                v.gain.gain.value = 0;
                v.source.stop();
            } catch (e) { }
        });
        this.voices.clear();
    }
}

window.MidiSynth = MidiSynth;
