// Turns the raw frames from record.mjs into one clip per scene: public/clips/scene2.mp4 ... scene7.mp4
// (constant 30 fps, H.264), with the waits cut out, plus public/clips/manifest.json (each clip's length,
// its zoom moments in clip time, and the PayPal popup clip for scene 6).
// Runs at the end of npm run record; run it alone (npm run clips) to re-cut without recording again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./lib/ff.mjs";

const RAW = fileURLToPath(new URL("../out/raw/", import.meta.url));
const CLIPS = fileURLToPath(new URL("../public/clips/", import.meta.url));
const FPS = 30;

// The scene's time range minus the cut-outs, as a list of [a, b] pieces in recording time.
function keptPieces([start, end], skips) {
  let pieces = [[start, end]];
  for (const [a, b] of skips) {
    pieces = pieces.flatMap(([s, e]) => (b <= s || a >= e ? [[s, e]] : [[s, Math.max(s, a)], [Math.min(e, b), e]]));
  }
  return pieces.filter(([s, e]) => e - s > 0.02);
}

// Recording time -> clip time (the cut-outs removed).
const toClipTime = (pieces, t) => {
  let acc = 0;
  for (const [s, e] of pieces) {
    if (t < s) return acc;
    if (t <= e) return acc + (t - s);
    acc += e - s;
  }
  return acc;
};

// Writes an ffconcat list (each frame shown until the next one arrives) and encodes it.
function encode(frames, pieces, out, { label }) {
  const entries = [];
  for (const [a, b] of pieces) {
    let i = frames.findLastIndex((f) => f.t <= a);
    if (i < 0) i = 0;
    for (; i < frames.length && frames[i].t < b; i++) {
      const from = Math.max(frames[i].t, a);
      const to = Math.min(frames[i + 1]?.t ?? b, b);
      if (to > from) entries.push({ file: frames[i].file, dur: to - from });
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

export async function buildClips() {
  const recording = JSON.parse(readFileSync(`${RAW}recording.json`, "utf8"));
  const { marks, streams } = recording;
  rmSync(CLIPS, { recursive: true, force: true });
  mkdirSync(CLIPS, { recursive: true });
  const scenes = {};
  for (const sc of marks.scenes) {
    const pieces = keptPieces([sc.start, sc.end], marks.skips);
    const file = `clips/scene${sc.n}.mp4`;
    const duration = encode(streams.main.frames, pieces, `${CLIPS}scene${sc.n}.mp4`, { label: `scene ${sc.n}` });
    const zooms = marks.zooms.filter((z) => z.scene === sc.n).map((z) => ({ at: +toClipTime(pieces, z.t).toFixed(3), hold: z.hold, box: z.box }));
    const entry = { file, duration: +duration.toFixed(3), zooms };
    const popup = marks.popups.find((p) => p.scene === sc.n);
    if (popup && streams.popup) {
      const popPieces = keptPieces([Math.max(popup.start, sc.start), Math.min(popup.end, sc.end)], marks.skips);
      const popFile = `clips/scene${sc.n}-popup.mp4`;
      const popDuration = encode(streams.popup.frames, popPieces, `${CLIPS}scene${sc.n}-popup.mp4`, { label: `scene ${sc.n} popup` });
      entry.popup = { file: popFile, from: +toClipTime(pieces, popPieces[0][0]).toFixed(3), duration: +popDuration.toFixed(3), size: streams.popup.size };
    }
    scenes[sc.n] = entry;
    console.log(`scene ${sc.n}: ${duration.toFixed(1)} s (${(sc.end - sc.start).toFixed(1)} s recorded)${entry.popup ? `, popup ${entry.popup.duration.toFixed(1)} s` : ""}`);
  }
  const manifest = { base: recording.base, version: recording.version, recordedAt: recording.recordedAt, fps: FPS, scenes };
  writeFileSync(`${CLIPS}manifest.json`, JSON.stringify(manifest, null, 2));
  console.log("Clips in public/clips/ (manifest.json lists them).");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(`${RAW}recording.json`)) throw new Error("No recording yet: run npm run record first.");
  await buildClips();
}
