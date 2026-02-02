/**
 * visualizers.js - Multi-track waveform and MIDI feedback
 */

const Visualizers = {
    colors: ['#0078d4', '#4caf50', '#d32f2f', '#ff9800', '#9c27b0', '#00bcd4'],
    animationIds: new Map(),
    midiState: new Map(), // canvas -> { notes: [{note, velocity, time, color}], lastTime: 0 }

    drawWaveform(canvas, analyser, colorIndex) {
        const ctx = canvas.getContext('2d');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const color = this.colors[colorIndex % this.colors.length];

        const render = () => {
            const id = requestAnimationFrame(render);
            this.animationIds.set(canvas, id);

            analyser.getByteTimeDomainData(dataArray);
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.lineWidth = 2;
            ctx.strokeStyle = color;
            ctx.beginPath();

            const sliceWidth = canvas.width * 1.0 / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * canvas.height / 2;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                x += sliceWidth;
            }

            ctx.lineTo(canvas.width, canvas.height / 2);
            ctx.stroke();

            // Add a glow
            ctx.globalAlpha = 0.3;
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        };
        render();
    },

    stopVisualizer(canvas) {
        const id = this.animationIds.get(canvas);
        if (id) cancelAnimationFrame(id);
    },

    drawMidiActivity(canvas, midiData) {
        if (!this.midiState.has(canvas)) {
            this.midiState.set(canvas, { notes: [], lastTime: performance.now() });

            // Start animation loop for this canvas if not exists
            const loop = () => {
                if (!canvas.isConnected) { // Stop if removed
                    this.midiState.delete(canvas);
                    return;
                }
                const state = this.midiState.get(canvas);
                if (!state) return;

                const now = performance.now();
                const dt = (now - state.lastTime) / 1000;
                state.lastTime = now;

                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#111';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Draw falling notes
                // We'll make them move RIGHT 
                const speed = 100; // px per second

                // Remove old notes
                state.notes = state.notes.filter(n => n.x < canvas.width);

                state.notes.forEach(n => {
                    n.x += speed * dt;
                    ctx.fillStyle = n.color;
                    // Map note 0-127 to height
                    const h = canvas.height / 128;
                    const y = canvas.height - (n.note * h);
                    ctx.fillRect(n.x, y, n.length, Math.max(2, h));
                });

                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        }

        const state = this.midiState.get(canvas);
        const [status, note, velocity] = midiData;

        // Note On
        if ((status & 0xf0) === 0x90 && velocity > 0) {
            state.notes.push({
                note: note,
                velocity: velocity,
                x: 0,
                color: `hsl(${note * 3}, 70%, 50%)`,
                length: 10 + (velocity / 5) // Visual length based on velocity
            });
        }
    }
};

window.Visualizers = Visualizers;
