// Turns the raw frames from record.mjs into one clip per scene: public/clips/scene2.mp4 ... scene7.mp4
// (constant 30 fps, H.264), with the waits cut out, plus public/clips/manifest.json (each clip's length,
// its zoom moments in clip time, and the PayPal popup clip for scene 6).
// Runs at the end of npm run record; run it alone (npm run clips) to re-cut without recording again.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run, runRaw } from "./lib/ff.mjs";

const RAW = fileURLToPath(new URL("../out/raw/", import.meta.url));
const CLIPS = fileURLToPath(new URL("../public/clips/", import.meta.url));
const FPS = 30;

// The scene's time range minus the cut-outs, as a list of [a, b, speed] pieces in recording time.
// A sped-up stretch (marks.fast: a page loading, the login being typed) plays `speed` times faster.
function keptPieces([start, end], skips, fasts = [], atLeast = []) {
  let pieces = [[start, end, 1]];
  for (const [a, b] of skips) {
    pieces = pieces.flatMap(([s, e, v]) => (b <= s || a >= e ? [[s, e, v]] : [[s, Math.max(s, a), v], [Math.min(e, b), e, v]]));
  }
  for (const [a, b, speed] of fasts) {
    pieces = pieces.flatMap(([s, e, v]) => (b <= s || a >= e ? [[s, e, v]]
      : [[s, Math.max(s, a), v], [Math.max(s, a), Math.min(e, b), speed], [Math.min(e, b), e, v]]));
  }
  for (const [a, b, min] of atLeast) { // a whole stretch at least this fast, keeping any faster parts inside it
    pieces = pieces.flatMap(([s, e, v]) => (b <= s || a >= e ? [[s, e, v]]
      : [[s, Math.max(s, a), v], [Math.max(s, a), Math.min(e, b), Math.max(v, min)], [Math.min(e, b), e, v]]));
  }
  return pieces.filter(([s, e]) => e - s > 0.02);
}

// Recording time -> clip time (the cut-outs removed, the fast stretches shortened).
const toClipTime = (pieces, t) => {
  let acc = 0;
  for (const [s, e, v] of pieces) {
    if (t < s) return acc;
    if (t <= e) return acc + (t - s) / v;
    acc += (e - s) / v;
  }
  return acc;
};

// Writes an ffconcat list (each frame shown until the next one arrives) and encodes it.
function encode(frames, pieces, out, { label }) {
  const entries = [];
  for (const [a, b, speed = 1] of pieces) {
    let i = frames.findLastIndex((f) => f.t <= a);
    if (i < 0) i = 0;
    for (; i < frames.length && frames[i].t < b; i++) {
      const from = Math.max(frames[i].t, a);
      const to = Math.min(frames[i + 1]?.t ?? b, b);
      if (to > from) entries.push({ file: frames[i].file, dur: (to - from) / speed });
    }
  }
  if (!entries.length) throw new Error(`${label}: no frames in this range`);
  const list = ["ffconcat version 1.0"];
  for (const { file, dur } of entries) list.push(`file '${file.replace(/\\/g, "/")}'`, `duration ${dur.toFixed(4)}`);
  list.push(`file '${entries.at(-1).file.replace(/\\/g, "/")}'`);
  const listFile = `${out}.txt`;
  writeFileSync(listFile, list.join("\n"));
  run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "16",
    "-movflags", "+faststart", "-an", out]);
  rmSync(listFile);
  return entries.reduce((sum, e) => sum + e.dur, 0);
}

// While PayPal's login popup is open, Chrome can draw its own pale yellow strip "Debugger paused in another tab,
// click to switch to that tab." at the top middle of the PayPal invoice tab underneath (a side effect of the
// recording's browser control, not part of PayPal or ChatChing). It sits on PayPal's even, dimmed backdrop, so
// the edit covers it with that backdrop's colour, sampled just left of the strip.
// -> [{ from, to, box, color }] in clip seconds.
const STRIP = { x: 790, y: 20, width: 340, height: 30 };
function debuggerStrip(clip) {
  const { x, y, width, height } = STRIP;
  const raw = runRaw("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", clip, "-vf", `crop=${width}:${height}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const px = width * height;
  const frames = raw.length / 3 / px;
  const hits = [];
  for (let f = 0; f < frames; f++) {
    let pale = 0;
    for (let p = 0; p < px; p++) {
      const i = (f * px + p) * 3;
      if (raw[i] > 225 && raw[i + 1] > 225 && raw[i] - raw[i + 2] > 25) pale++;
    }
    if (pale > px * 0.2) hits.push(f);
  }
  const runs = [];
  for (const f of hits) {
    const last = runs.at(-1);
    if (last && f - last.to <= 2) last.to = f;
    else runs.push({ from: f, to: f });
  }
  return runs.map(({ from, to }) => {
    const i = ((Math.round((from + to) / 2) * px) + Math.round(height / 2) * width + 2) * 3; // left edge, middle row
    // Exactly the frames with the strip: a frame earlier or later the backdrop is lighter or darker, and the cover
    // would show as a grey box.
    return { from: from / FPS, to: (to + 1) / FPS, box: STRIP, color: `rgb(${raw[i]}, ${raw[i + 1]}, ${raw[i + 2]})` };
  });
}

export async function buildClips() {
  const recording = JSON.parse(readFileSync(`${RAW}recording.json`, "utf8"));
  const { marks, streams } = recording;
  rmSync(CLIPS, { recursive: true, force: true });
  mkdirSync(CLIPS, { recursive: true });
  const scenes = {};
  const fasts = marks.fast ?? [];
  const atLeast = marks.fastAtLeast ?? [];
  for (const sc of marks.scenes) {
    const pieces = keptPieces([sc.start, sc.end], marks.skips, fasts, atLeast);
    const file = `clips/scene${sc.n}.mp4`;
    const duration = encode(streams.main.frames, pieces, `${CLIPS}scene${sc.n}.mp4`, { label: `scene ${sc.n}` });
    const zooms = marks.zooms.filter((z) => z.scene === sc.n).map((z) => ({ at: +toClipTime(pieces, z.t).toFixed(3), hold: z.hold, box: z.box, ...(z.scale ? { scale: z.scale } : {}) }));
    const entry = { file, duration: +duration.toFixed(3), zooms };
    // A cue for something seen (onScreen) moves to the first frame Chrome sent after it: the page changes a
    // moment before the picture of it arrives, and the sound should land with the picture.
    const seenAt = (c) => (c.onScreen ? streams.main.frames.find((f) => f.t > c.t)?.t ?? c.t : c.t);
    const cues = (marks.cues ?? []).filter((c) => c.scene === sc.n);
    if (cues.length) entry.cues = Object.fromEntries(cues.map((c) => [c.name, +toClipTime(pieces, seenAt(c)).toFixed(3)]));
    const masks = debuggerStrip(`${CLIPS}scene${sc.n}.mp4`);
    if (masks.length) {
      entry.masks = masks;
      console.log(`  scene ${sc.n}: Chrome's "Debugger paused" strip covered at ${masks.map((m) => `${m.from.toFixed(1)}-${m.to.toFixed(1)} s`).join(", ")}`);
    }
    const popup = marks.popups.find((p) => p.scene === sc.n);
    if (popup && streams.popup) {
      const popPieces = keptPieces([Math.max(popup.start, sc.start), Math.min(popup.end, sc.end)], marks.skips, fasts, atLeast);
      const popFile = `clips/scene${sc.n}-popup.mp4`;
      const popDuration = encode(streams.popup.frames, popPieces, `${CLIPS}scene${sc.n}-popup.mp4`, { label: `scene ${sc.n} popup` });
      entry.popup = { file: popFile, from: +toClipTime(pieces, popPieces[0][0]).toFixed(3), duration: +popDuration.toFixed(3), size: streams.popup.size };
    }
    scenes[sc.n] = entry;
    console.log(`scene ${sc.n}: ${duration.toFixed(1)} s (${(sc.end - sc.start).toFixed(1)} s recorded)${entry.popup ? `, popup ${entry.popup.duration.toFixed(1)} s` : ""}`);
  }
  const manifest = { base: recording.base, version: recording.version, recordedAt: recording.recordedAt, fps: FPS, scenes };
  // Scene 8's lead-in: the paid buyer's order page on a phone (a still from record.mjs).
  if (marks.leadIn && existsSync(`${RAW}${marks.leadIn.file}`)) {
    copyFileSync(`${RAW}${marks.leadIn.file}`, `${CLIPS}scene8-lead.png`);
    manifest.leadIn = { file: "clips/scene8-lead.png", buyer: marks.leadIn.buyer, paidBy: marks.leadIn.paidBy };
    console.log(`scene 8 lead-in: ${marks.leadIn.buyer}'s order page (paid by ${marks.leadIn.paidBy})`);
  }
  writeFileSync(`${CLIPS}manifest.json`, JSON.stringify(manifest, null, 2));
  console.log("Clips in public/clips/ (manifest.json lists them).");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(`${RAW}recording.json`)) throw new Error("No recording yet: run npm run record first.");
  await buildClips();
}
