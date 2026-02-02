/**
 * midi-recorder.js - Captures real-time MIDI events
 */

class MidiRecorder {
    constructor() {
        this.startTime = 0;
        this.events = []; // { type, note, velocity, time, channel }
        this.isRecording = false;
    }

    start() {
        this.startTime = performance.now();
        this.events = [];
        this.isRecording = true;
    }

    stop() {
        this.isRecording = false;
        return this.toJSON();
    }

    // Capture an incoming MIDI event
    recordEvent(data) {
        if (!this.isRecording) return;

        const [status, data1, data2] = data;
        const command = status & 0xF0;
        const channel = status & 0x0F;
        const time = (performance.now() - this.startTime) / 1000; // Seconds

        // Standardize Note On/Off
        // Note On with vel 0 is often sent as Note Off
        if (command === 0x90 && data2 > 0) {
            this.events.push({
                type: 'noteOn',
                note: data1,
                velocity: data2,
                channel: channel,
                time: time
            });
        } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
            this.events.push({
                type: 'noteOff',
                note: data1,
                velocity: 0,
                channel: channel,
                time: time
            });
        }
        // Add support for other events (CC, PitchBend) later if needed
    }

    toJSON() {
        return {
            duration: this.events.length > 0 ? this.events[this.events.length - 1].time : 0,
            events: this.events
        };
    }
}

window.MidiRecorder = MidiRecorder;
