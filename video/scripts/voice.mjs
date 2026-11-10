// Prepares Jasper's voice lines for the video (7 Nov). Run: npm run voice
// Reads the originals in public/voice/ exactly as recorded on the phone ("scene 1.m4a" ... "scene 10.m4a"; scene 3 is
// two files: "scene 3.m4a" = part 1, "scene 3 second part*.m4a" = part 2; scene 1 is "scene 1 hook.mp3" since 10 Nov,
// see HOOK below) and NEVER changes them. It writes processed
// copies to public/voice-ready/scene1.wav ... scene10.wav (git-ignored), which timeline.mjs uses first:
//   - silence at the start and end trimmed, keeping 0.2 s on each side (speech found with silencedetect at -45 dB)
//   - scene 3: part 1, a 0.3 s pause, part 2
//   - every line made equally loud: EBU R128 loudnorm in two passes (measure, then a straight gain), -16 LUFS
//     (normal speech level for online video), true peak at most -1.5 dBTP, so nothing clips
//   - 48 kHz mono 16-bit WAV (lossless; the render compresses it once, at the end)
// Then it checks what it can: an empty or missing file, clipping or a very quiet recording, long gaps inside a line,
// a speaking speed that doesn't fit the line's words in PLAN.md Section 14, and each line against its scene's slot in
// PLAN.md Section 13. The report goes to the screen and to public/voice-ready/report.md.
// Only ffmpeg filters that both the system ffmpeg and Remotion's bundled one have (no python, works on Windows).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mediaSeconds, run, runLog } from "./lib/ff.mjs";
import { storyboard } from "./timeline.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const SOURCE = `${PUBLIC}voice/`;
const READY = `${PUBLIC}voice-ready/`;
const PLAN = new URL("../../PLAN.md", import.meta.url);

const THRESHOLD = "-45dB"; // quieter than this counts as silence (the recordings' pauses sit below -50 dB)
const MIN_SILENCE = 0.3; // seconds: a shorter quiet moment is part of speech
const KEEP = 0.2; // seconds of silence kept before and after the speech
const JOIN_PAUSE = 0.3; // seconds between scene 3's two parts
const TARGET = { I: -16, TP: -1.5, LRA: 11 };
const LONG_GAP = 1.2; // a pause longer than this inside a line is reported
const VOICE_DELAY = 0.25; // timeline.mjs: a line starts this long after its scene...
const VOICE_PAD = 0.8; // ...and the scene keeps this much quiet after it

// Scene 1's new hook (Tue 10 Nov): "scene 1 hook.mp3" is used instead of "scene 1.m4a". That file is a read-through
// of the whole new script (107 s), so only its start is the hook: "11 PM. ... every single night." ends at 12.8 s,
// followed by 0.3 s of digital silence (where the takes were joined) and then "So I built ChatChing...". `until`
// cuts the file inside that silence; the trim below then finds the end of the speech as usual.
const HOOK = { n: 1, name: /^scene ?1 hook\.(m4a|mp3|wav|aac)$/i, until: 12.95 };

// The original file(s) of each scene, part 1 first. -> { n, files, until }
function sources() {
  const names = existsSync(SOURCE) ? readdirSync(SOURCE).filter((name) => /\.(m4a|mp3|wav|aac)$/i.test(name)) : [];
  const scenes = [];
  for (let n = 1; n <= 10; n++) {
    const hook = n === HOOK.n ? names.find((name) => HOOK.name.test(name)) : null;
    if (hook) {
      scenes.push({ n, files: [hook], until: HOOK.until });
      continue;
    }
    const main = names.find((name) => new RegExp(`^scene ?${n}\\.(m4a|mp3|wav|aac)$`, "i").test(name));
    const second = names.find((name) => new RegExp(`^scene ?${n} second part`, "i").test(name));
    scenes.push({ n, files: [main, second].filter(Boolean) });
  }
  return { names, scenes };
}

// silencedetect -> the quiet stretches of a file: [{ start, end }] (end = the file's end if it runs to the end).
// With `until`, only the file's first `until` seconds count, and a short pad after them lets silencedetect see a
// quiet stretch that runs to that point.
function silences(file, duration, until) {
  const limit = until ? ["-t", String(until)] : [];
  const pad = until ? "apad=pad_dur=0.5," : "";
  const log = runLog("ffmpeg", ["-hide_banner", "-nostats", ...limit, "-i", file, "-af", `${pad}silencedetect=noise=${THRESHOLD}:d=${MIN_SILENCE}`, "-f", "null", "-"]);
  const quiet = [];
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/silence_start: (-?[\d.]+)/);
    const end = line.match(/silence_end: ([\d.]+)/);
    if (start) quiet.push({ start: Math.max(0, Number(start[1])), end: duration });
    if (end && quiet.length) quiet.at(-1).end = Number(end[1]);
  }
  return quiet;
}

// One part: where the speech starts and ends, and the long pauses inside it. Two quiet stretches with less than
// 0.25 s of sound between them are one. A sound in the first or last EDGE seconds is not speech: the files start
// with digital silence (-80 dB) that silencedetect reports a moment late, and end with the tap on the phone's stop
// button (peaks near -38 dB, under 0.2 s; speech averages about -34 dB). Measured on the 7 Nov recordings.
const EDGE = 0.4;
function speech(file, until) {
  const duration = until ? Math.min(until, mediaSeconds(file)) : mediaSeconds(file);
  const quiet = [];
  for (const q of silences(file, duration, until)) {
    const last = quiet.at(-1);
    if (last && q.start - last.end < 0.25) last.end = q.end;
    else quiet.push({ ...q });
  }
  const lead = quiet[0]?.start < EDGE ? quiet[0] : null;
  const tail = quiet.at(-1) && quiet.at(-1) !== lead && quiet.at(-1).end > duration - EDGE ? quiet.at(-1) : null;
  const start = lead ? lead.end : 0;
  const end = tail ? tail.start : duration;
  const gaps = quiet.filter((q) => q !== lead && q !== tail && q.end - q.start > LONG_GAP).map((q) => ({ at: q.start - start, seconds: q.end - q.start }));
  return { file, duration, start, end, length: Math.max(0, end - start), gaps };
}

// The filter graph: each part trimmed to its speech, mono 48 kHz; scene 3's parts joined with a short pause; then
// KEEP seconds of silence added on both sides. extra: what comes after (the loudnorm pass).
function graph(parts, extra) {
  const chains = parts.map((p, i) => `[${i}:a]atrim=start=${p.start.toFixed(3)}:end=${p.end.toFixed(3)},asetpts=PTS-STARTPTS,`
    + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono${i < parts.length - 1 ? `,apad=pad_dur=${JOIN_PAUSE}` : ""}[p${i}]`);
  const joined = parts.length > 1 ? `${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[j]` : "[p0]anull[j]";
  return [...chains, joined, `[j]adelay=${Math.round(KEEP * 1000)}:all=1,apad=pad_dur=${KEEP},${extra}[out]`].join(";");
}

const loudnormJson = (log) => JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1));
const inputs = (parts) => parts.flatMap((p) => ["-i", p.file]);

// Loudness, with loudnorm only (it is in both ffmpegs; the system one's alimiter is not in Remotion's). Pass 1
// measures; then loudnorm makes the line louder and holds its peaks under -1.5 dBTP. The recordings are quiet
// (-27 to -32 LUFS) with peaks 4 to 14 dB below full scale, so one straight gain to -16 LUFS would clip most of
// them, and a straight gain that clips none would leave every line near -23 LUFS: loudnorm's own limiter does the
// rest (its "dynamic" mode). On short lines it lands up to 1.5 LU under its target, so the target is corrected
// from what came out, up to 3 rounds, until every line is within 0.5 LU of -16. -> { before, after, mode, rounds }
const TOLERANCE = 0.5; // LU: about 1 LU is the smallest loudness difference most listeners notice
function processScene(parts, out) {
  const json = (args) => loudnormJson(runLog("ffmpeg", ["-hide_banner", "-nostats", ...args]));
  const measure = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:print_format=json`;
  const before = json([...inputs(parts), "-filter_complex", graph(parts, measure), "-map", "[out]", "-f", "null", "-"]);
  let aim = TARGET.I;
  let after;
  let mode;
  let rounds = 0;
  do {
    rounds += 1;
    const apply = `loudnorm=I=${aim.toFixed(2)}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:measured_I=${before.input_i}:measured_TP=${before.input_tp}`
      + `:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:linear=true:print_format=json,aresample=48000`;
    mode = json(["-y", ...inputs(parts), "-filter_complex", graph(parts, apply), "-map", "[out]", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]).normalization_type;
    after = json(["-i", out, "-af", measure, "-f", "null", "-"]);
    aim = Math.min(-9, aim + (TARGET.I - Number(after.input_i)));
  } while (Math.abs(Number(after.input_i) - TARGET.I) > TOLERANCE && rounds < 3);
  return { before, after, mode, rounds };
}

// PLAN.md Section 14: the words of each scene's line.
function scriptWords() {
  const plan = readFileSync(PLAN, "utf8");
  const section = plan.slice(plan.indexOf("## 14. Video script"));
  const words = {};
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^\d+$/.test(cells[1] ?? "")) continue;
    const quoted = cells[3].match(/"(.*)"/)?.[1] ?? cells[3];
    words[Number(cells[1])] = { text: quoted, count: quoted.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length };
  }
  return { words, connectors: /Meet my friend|So I built ChatChing|Watch this/i.test(section) };
}

const f1 = (s) => s.toFixed(1);
const { names, scenes } = sources();
mkdirSync(READY, { recursive: true });
const board = storyboard();
const { words, connectors } = scriptWords();
const rows = [];
const warnings = [];

console.log(`Originals in public/voice/: ${names.length ? names.join(", ") : "none"}\n`);
for (const scene of scenes) {
  const out = `${READY}scene${scene.n}.wav`;
  const planned = board[scene.n - 1].planned;
  if (!scene.files.length) {
    warnings.push(`scene ${scene.n}: no recording found in public/voice/.`);
    rows.push({ n: scene.n, missing: true, planned });
    continue;
  }
  if (scene.n === 3 && scene.files.length !== 2) warnings.push("scene 3: expected 2 parts (\"scene 3.m4a\" and \"scene 3 second part...\"), found " + scene.files.length + ".");
  const parts = scene.files.map((name) => speech(`${SOURCE}${name}`, scene.until));
  const spoken = parts.reduce((sum, p) => sum + p.length, 0);
  if (spoken < 0.5) {
    warnings.push(`scene ${scene.n}: no speech found (empty or silent file).`);
    rows.push({ n: scene.n, missing: true, planned });
    continue;
  }
  const { before, after, mode, rounds } = processScene(parts, out);
  const seconds = mediaSeconds(out);
  const needs = VOICE_DELAY + seconds + VOICE_PAD;
  const wps = words[scene.n] ? words[scene.n].count / spoken : null;
  const problems = [];
  if (Number(before.input_tp) > -0.5) problems.push(`peaks at ${before.input_tp} dBTP in the recording: listen for distortion (clipping)`);
  if (Number(before.input_i) < -35) problems.push(`very quiet recording (${before.input_i} LUFS): it was raised a lot, so background noise rises too`);
  if (Math.abs(Number(after.input_i) - TARGET.I) > TOLERANCE) problems.push(`ended at ${after.input_i} LUFS after ${rounds} rounds (aim ${TARGET.I})`);
  if (Number(after.input_tp) > TARGET.TP + 0.3) problems.push(`peak ${after.input_tp} dBTP after processing`);
  for (const p of parts) for (const g of p.gaps) problems.push(`a ${f1(g.seconds)} s pause ${f1(g.at)} s into ${p.file.split("/").pop()}`);
  // Natural speech is about 2 to 3 words a second; well outside that, the recording and the written line differ.
  if (wps !== null && (wps < 1.0 || wps > 3.8)) problems.push(`${f1(wps)} words a second for the ${words[scene.n].count} words in Section 14: the recording may not match that line`);
  rows.push({ n: scene.n, files: scene.files.map((name) => (scene.until ? `${name} (first ${scene.until} s)` : name)), original: parts.reduce((s, p) => s + p.duration, 0), seconds, planned, needs, room: planned - needs, wps, before, after, mode, problems });
}

// ---- The report ----
const lines = [];
const say = (text = "") => lines.push(text);
say(`# Voice lines (npm run voice, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`);
say();
say(`Processed copies: public/voice-ready/scene1.wav ... scene10.wav. Originals untouched in public/voice/.`);
say(`Trim: silence below ${THRESHOLD} at both ends, ${KEEP} s kept. Loudness: ${TARGET.I} LUFS, true peak at most ${TARGET.TP} dBTP (two-pass loudnorm).`);
say(`A scene needs ${VOICE_DELAY} s + the line + ${VOICE_PAD} s of quiet (timeline.mjs). Slot = the scene's time in PLAN.md Section 13.`);
say();
say("| Scene | Recording(s) | Before (s) | After trim (s) | Slot (s) | Needs (s) | Fits? | Loudness before -> after | Words/s |");
say("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  if (r.missing) {
    say(`| ${r.n} | missing | — | — | ${r.planned} | — | — | — | — |`);
    continue;
  }
  const fits = r.room >= 0 ? `yes (${f1(r.room)} s spare)` : `**no, ${f1(-r.room)} s over**`;
  say(`| ${r.n} | ${r.files.join(" + ")} | ${f1(r.original)} | ${f1(r.seconds)} | ${r.planned} | ${f1(r.needs)} | ${fits} | ${r.before.input_i} -> ${r.after.input_i} LUFS, peak ${r.after.input_tp} dBTP | ${r.wps === null ? "—" : f1(r.wps)} |`);
}
const done = rows.filter((r) => !r.missing);
say();
say(`Total of the lines: ${f1(done.reduce((s, r) => s + r.seconds, 0))} s. Lines over their slot: ${done.filter((r) => r.room < 0).map((r) => `scene ${r.n} (+${f1(-r.room)} s)`).join(", ") || "none"}.`);
say();
say("## Problems found");
const found = [...warnings, ...done.flatMap((r) => r.problems.map((p) => `scene ${r.n}: ${p}`))];
for (const p of found.length ? found : ["none"]) say(`- ${p}`);
if (!connectors) {
  say();
  say("Note: PLAN.md Section 14 is still the 4 Nov script (no \"Meet my friend...\", \"So I built ChatChing...\", \"Watch this...\"), so the words-a-second column compares the recordings with the OLD words. Paste the recorded version into Section 14 for an exact check.");
}
writeFileSync(`${READY}report.md`, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log("\nNext: node scripts/timeline.mjs shows each scene's length and the total with these lines.");
