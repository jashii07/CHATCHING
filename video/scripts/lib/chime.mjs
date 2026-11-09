// The app's cha-ching as a sound file, for the edit: the screen recording (Chrome's screencast) has pictures only.
// Same recipe as chaChing() in public/app.js (8 Nov polish), worked out sample by sample instead of by Web Audio:
// two small bells, E6 then B6 0.09 s later; each is the main tone plus two quieter overtones that fade faster;
// every level starts at 0.0001, rises to its peak in 5 ms and falls back to 0.0001 (Web Audio's exponential ramps).
// Our own tone, so no copyright. Only the overall level is set for the video (`peak`), not the shape.
import { writeFileSync } from "node:fs";

const RATE = 48_000;
const PARTIALS = [[1, 1, 0.5], [2.76, 0.25, 0.18], [5.4, 0.08, 0.08]]; // [frequency ratio, level, fade seconds]
const NOTES = [[0, 1318.5], [0.09, 1975.5]]; // [start, Hz]
const START = 0.02; // chaChing() starts 20 ms after "now"

// Web Audio's exponentialRampToValueAtTime from v0 at t0 to v1 at t1.
const ramp = (t, t0, v0, t1, v1) => v0 * (v1 / v0) ** ((t - t0) / (t1 - t0));

function level(t, at, peak, fade) {
  if (t < at) return 0;
  if (t < at + 0.005) return ramp(t, at, 0.0001, at + 0.005, peak);
  if (t < at + fade) return ramp(t, at + 0.005, peak, at + fade, 0.0001);
  return t < at + fade + 0.05 ? 0.0001 : 0; // the oscillator stops 50 ms after the fade
}

// Writes a mono 16-bit WAV; `peak` is the loudest sample (0..1). Returns its length in seconds.
export function writeChime(file, { peak = 0.3 } = {}) {
  const seconds = START + 0.09 + 0.55 + 0.05;
  const n = Math.ceil(seconds * RATE);
  const samples = new Float64Array(n);
  for (const [offset, freq] of NOTES) {
    const at = START + offset;
    for (const [ratio, peakLevel, fade] of PARTIALS) {
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const g = level(t, at, peakLevel, fade);
        if (g) samples[i] += g * Math.sin(2 * Math.PI * freq * ratio * (t - at));
      }
    }
  }
  const max = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round((samples[i] / max) * peak * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
  return n / RATE;
}
