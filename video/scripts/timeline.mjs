// Builds public/generated/timeline.json: everything the Remotion edit needs, worked out in Node.
//   - captions and planned scene times straight from PLAN.md Section 13 (the storyboard table)
//   - the recorded clips (public/clips/manifest.json from npm run record)
//   - Jasper's voice lines public/voice/scene1.m4a ... scene10.m4a, if they exist (their lengths set the scene lengths)
//   - Jasper's phone clip public/phone/pickup.mp4 (or .mov, or the newest video there), cropped to the page and turned
//     into a plain H.264 copy the edit can play; the scene 8 lead-in still from the recording
//   - voice lines 6 and 8 split at pauses and placed on their moments; the cha-ching sound (lib/chime.mjs)
//   - the demo chats (scene 1), the npm run check result and the real-orders score (scene 9)
// Run on its own: node scripts/timeline.mjs   (npm run draft / final / studio run it first anyway)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mediaSeconds, run, runLog } from "./lib/ff.mjs";
import { writeChime } from "./lib/chime.mjs";

const VIDEO = new URL("../", import.meta.url);
const ROOT = new URL("../../", import.meta.url);
const PUBLIC = fileURLToPath(new URL("public/", VIDEO));
const GENERATED = `${PUBLIC}generated/`;
export const FPS = 30;
export const TITLE_SECONDS = 3;
export const LIMIT_SECONDS = 174.5; // "total under 2:55"
const CLIP_SCENES = [2, 3, 4, 5, 6, 7];
const MIN_SECONDS = { 1: 6, 8: 8, 9: 7, 10: 4 }; // for the scenes made here, when a voice line sets the length
const VOICE_PAD = 0.8; // seconds of quiet after each voice line
const VOICE_DELAY = 0.25; // each voice line starts this long after its scene

// Two voice lines are split at a pause, so each part plays over its moment (Mon 9 Nov). Scene 6 has about 28 s of
// screen for a 12 s line, and scene 8's "Paid?" should come when the phone shows Paid. `splits` are points inside
// a pause of Jasper's 7 Nov recording (checked below: if one isn't silent, the line plays whole, as before).
// Each part starts at its anchor: a cue from the recording, minus how far into the part its key word is.
//   6: "Next, each buyer gets a private order page. Lina checks her order, taps 'Looks right'," (taps at 6.1 s)
//      | "and pays with PayPal." | "A moment later, | ChatChing shows her as Paid. Cha-ching!" (the pause at 1.15 s:
//      the cha-ching sound lands there, just before "ChatChing shows her as Paid")
//   8: "Then at pickup, I simply scan the buyer's QR code with my phone." | "Paid? Great, it's collected. Not paid
//      yet? I'll know before handing anything over." ("Paid?" right after the phone shows Paid)
const VOICE_PARTS = {
  6: { splits: [7.43, 8.88], anchors: [["looks", 6.1], ["pay", 0.2], ["paid", 1.15]] },
  8: { splits: [5.03], anchors: [[null, 0], ["paid", 0.1]] },
};

// Scene 8: a 1.5 s still of the paid buyer's order page (record.mjs) before the phone clip.
const LEAD_IN_SECONDS = 1.5;
// Jasper's phone clip (Mon 9 Nov, video_2026-11-09_17-39-37.mp4, a screen recording, 576 x 1280): the page shows
// "Paid: Aisyah" 4.9 s in. The phone's status bar (notification icons), Chrome's address bar and the navigation
// bar are cropped off, so only ChatChing's page shows.
const PHONE_PAID_AT = 4.9;
const PHONE_CROPS = { "576x1280": { top: 152, height: 1054 } };

// Seconds added to a scene on top of what its clip and voice need: the time scene 6 (sped-up waits) and scene 8
// (a 12.7 s phone clip) saved, given to the scenes with the least quiet after their line.
const EXTRA = { 7: 0.3, 9: 0.5, 10: 0.3 };
// The cha-ching's loudest sample in the video (0..1). The voice lines peak at -1.5 dBTP; the chime is a short,
// bright sound, so it sits well below them.
const CHIME_PEAK = 0.4;

// PLAN.md Section 13: | # | Time | On screen | Caption | Moment | Built in step |
export function storyboard() {
  const plan = readFileSync(new URL("PLAN.md", ROOT), "utf8");
  const section = plan.slice(plan.indexOf("## 13. Video storyboard"), plan.indexOf("## 14."));
  const scenes = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^\d+$/.test(cells[1] ?? "")) continue;
    const [from, to] = cells[2].split("-").map((t) => t.split(":").reduce((m, s) => m * 60 + Number(s), 0));
    const caption = cells[4].replace(/^"|"$/g, "");
    scenes.push({ n: Number(cells[1]), planned: to - from, caption, onScreen: cells[3] });
  }
  if (scenes.length !== 10 || scenes.some((s, i) => s.n !== i + 1 || !s.caption)) {
    throw new Error("Could not read the 10 scenes from PLAN.md Section 13 (the storyboard table).");
  }
  return scenes;
}

const findFile = (dir, base, exts) => exts.map((e) => `${dir}${base}.${e}`).find((f) => existsSync(f));
// A scene's voice line: the processed copy from npm run voice (public/voice-ready/sceneN.wav: trimmed, equally loud)
// first, else a file already named sceneN in public/voice/. Jasper's phone originals ("scene 1.m4a") are only read
// by npm run voice, never used as they are.
export const findVoice = (n) => findFile(`${PUBLIC}voice-ready/`, `scene${n}`, ["wav"]) ?? findFile(`${PUBLIC}voice/`, `scene${n}`, ["m4a", "mp3", "wav", "M4A"]);

function chats() {
  return readFileSync(new URL("data/demo-chats.txt", ROOT), "utf8").trim().split(/\r?\n/).map((line) => {
    const m = line.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/);
    return m ? { when: m[1], name: m[2], text: m[3] } : { when: "", name: "", text: line };
  });
}

// The real-orders score from docs/accuracy.md, set A ("cafe-usd"): e.g. **73/74**.
function realScore() {
  const doc = readFileSync(new URL("docs/accuracy.md", ROOT), "utf8");
  const m = doc.match(/\|\s*A "cafe-usd"[^\n]*?\*\*(\d+)\/(\d+)\*\*/);
  if (!m) throw new Error('Could not find set A ("cafe-usd") in docs/accuracy.md.');
  return { right: Number(m[1]), of: Number(m[2]) };
}

// npm run check in the app folder; the PASS/FAIL lines are shown in scene 9.
function checkResult({ fresh }) {
  const file = `${GENERATED}check.json`;
  if (!fresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  console.log("Running npm run check in the app folder (about a minute)...");
  const res = spawnSync("npm run check", { cwd: fileURLToPath(ROOT), shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${res.stdout}\n${res.stderr}`;
  const summary = out.slice(out.lastIndexOf("=== npm run check ==="));
  const lines = summary.split(/\r?\n/).filter((l) => /^(PASS|FAIL)\b/.test(l.trim())).map((l) => l.trim().replace(/\s{2,}/g, "  "));
  const tests = Number(summary.match(/tests \((\d+) passed/)?.[1] ?? 0);
  const result = { ok: res.status === 0, tests, lines, at: new Date().toISOString() };
  if (!result.ok || !tests) throw new Error(`npm run check did not pass, so it can't go in the video:\n${lines.join("\n")}`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}

// Jasper's phone clip: public/phone/pickup.mp4 (or .mov ...), else the newest video in public/phone/ (a phone's
// own file name works too, e.g. video_2026-11-09_17-39-37.mp4).
export function findPhone() {
  const dir = `${PUBLIC}phone/`;
  const named = findFile(dir, "pickup", ["mp4", "mov", "m4v", "webm", "MP4", "MOV"]);
  if (named || !existsSync(dir)) return named ?? null;
  return readdirSync(dir).filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f)).map((f) => `${dir}${f}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

// The phone clip as H.264 at up to 1080 px tall, no sound (the voice line plays instead), phone bars cropped off.
function phoneClip() {
  const src = findPhone();
  if (!src) return null;
  const out = `${GENERATED}phone.mp4`;
  const [w, h] = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", src]).trim().split(",").map(Number);
  const crop = PHONE_CROPS[`${w}x${h}`];
  const stamp = JSON.stringify({ src, mtime: statSync(src).mtimeMs, crop });
  const stampFile = `${GENERATED}phone.json`;
  if (!existsSync(out) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    console.log(`Converting the phone clip ${src.replace(PUBLIC, "public/")} (${w} x ${h}${crop ? ", phone bars cropped off" : ", NOT cropped: unknown screen size"}) ...`);
    const filters = [crop ? `crop=${w}:${crop.height}:0:${crop.top}` : null, "scale=-2:'min(1080,ih)'", "fps=30", "format=yuv420p"].filter(Boolean).join(",");
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-an", "-vf", filters,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", out]);
    writeFileSync(stampFile, stamp);
  }
  const [ow, oh] = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).trim().split(",").map(Number);
  return { file: "generated/phone.mp4", duration: mediaSeconds(out), width: ow, height: oh, source: src.slice(PUBLIC.length) };
}

// Splits a voice line at the given points (inside pauses) into generated/voiceN-1.wav, -2.wav ...
// -> [{ file, seconds }], or null if a split point is not in a pause (then the line plays whole).
function splitVoice(n, voiceFile, splits) {
  const log = runLog("ffmpeg", ["-hide_banner", "-nostats", "-i", voiceFile, "-af", "silencedetect=noise=-35dB:d=0.1", "-f", "null", "-"]);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const quiet = (t) => starts.some((s, i) => s <= t && t <= (ends[i] ?? Infinity));
  const bad = splits.filter((t) => !quiet(t));
  if (bad.length) {
    console.log(`  scene ${n}: the voice line is not quiet at ${bad.join(", ")} s, so it plays whole (re-recorded? update VOICE_PARTS)`);
    return null;
  }
  const points = [0, ...splits, mediaSeconds(voiceFile)];
  return points.slice(1).map((end, i) => {
    const file = `${GENERATED}voice${n}-${i + 1}.wav`;
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", voiceFile, "-ss", points[i].toFixed(3), "-to", end.toFixed(3), "-c:a", "pcm_s16le", file]);
    return { file: file.slice(PUBLIC.length), seconds: mediaSeconds(file) };
  });
}

// Where each voice part starts in its scene: at its anchor, never before the previous part has ended.
function placeVoice(n, voiceFile, voiceSeconds, cues) {
  const whole = [{ file: voiceFile.slice(PUBLIC.length), at: VOICE_DELAY, seconds: voiceSeconds }];
  const plan = VOICE_PARTS[n];
  if (!plan) return whole;
  if (plan.anchors.some(([cue]) => cue && cues?.[cue] === undefined)) {
    console.log(`  scene ${n}: no cue times in the recording, so the voice line plays whole`);
    return whole;
  }
  const parts = splitVoice(n, voiceFile, plan.splits);
  if (!parts) return whole;
  let free = VOICE_DELAY;
  return parts.map((part, i) => {
    const [cue, offset] = plan.anchors[i];
    const at = Math.max(free, cue ? cues[cue] - offset : VOICE_DELAY);
    free = at + part.seconds + 0.1;
    return { ...part, at: +at.toFixed(3) };
  });
}

export function buildTimeline({ draft = true, freshCheck = false } = {}) {
  mkdirSync(GENERATED, { recursive: true });
  copyFileSync(new URL("public/fonts/inter-latin-wght-normal.woff2", ROOT), `${GENERATED}inter.woff2`);
  const board = storyboard();
  const manifestFile = `${PUBLIC}clips/manifest.json`;
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
  const phone = phoneClip();
  const missing = { voice: [], clips: [], phone: !phone };

  const chime = `${GENERATED}chime.wav`;
  writeChime(chime, { peak: CHIME_PEAK });
  const leadIn = phone && manifest?.leadIn ? { ...manifest.leadIn, seconds: LEAD_IN_SECONDS } : null;

  const scenes = board.map((b) => {
    const voiceFile = findVoice(b.n);
    const voiceSeconds = voiceFile ? mediaSeconds(voiceFile) : null;
    if (!voiceFile) missing.voice.push(b.n);
    const scene = { n: b.n, caption: b.caption, planned: b.planned, voice: voiceFile ? voiceFile.slice(PUBLIC.length) : null, voiceSeconds, sounds: [] };
    const clip = CLIP_SCENES.includes(b.n) ? manifest?.scenes?.[b.n] ?? null : null;
    const cues = b.n === 8 ? { paid: (leadIn ? LEAD_IN_SECONDS : 0) + PHONE_PAID_AT } : clip?.cues;
    scene.voiceParts = voiceFile ? placeVoice(b.n, voiceFile, voiceSeconds, phone || b.n !== 8 ? cues : null) : [];
    const last = scene.voiceParts.at(-1);
    const voiceNeeds = last ? last.at + last.seconds + VOICE_PAD : 0;
    if (CLIP_SCENES.includes(b.n)) {
      if (!clip) missing.clips.push(b.n);
      scene.kind = "clip";
      scene.clip = clip;
      // The clip plays at normal speed; a longer voice line holds the last frame a little.
      scene.seconds = Math.max(clip?.duration ?? b.planned, voiceNeeds);
      // The cha-ching: the app plays it when Lina turns Paid, but the screen recording has no sound.
      if (clip?.cues?.paid !== undefined) scene.sounds.push({ file: "generated/chime.wav", at: clip.cues.paid });
    } else {
      scene.kind = { 1: "chats", 8: "phone", 9: "tech", 10: "logo" }[b.n];
      let base = b.planned;
      if (b.n === 8 && phone) {
        scene.leadIn = leadIn;
        base = Math.min(Math.max(phone.duration + (leadIn ? LEAD_IN_SECONDS : 0), 6), 22);
      }
      scene.seconds = voiceSeconds ? Math.max(voiceNeeds, MIN_SECONDS[b.n], b.n === 8 && phone ? base : 0) : base;
    }
    scene.extra = EXTRA[b.n] ?? 0;
    scene.seconds = Math.round((scene.seconds + scene.extra) * FPS) / FPS;
    return scene;
  });

  const totalSeconds = TITLE_SECONDS + scenes.reduce((s, sc) => s + sc.seconds, 0);
  const timeline = {
    draft, fps: FPS, width: 1920, height: 1080, titleSeconds: TITLE_SECONDS, totalSeconds: Math.round(totalSeconds * FPS) / FPS,
    limitSeconds: LIMIT_SECONDS, scenes, chats: chats(), check: checkResult({ fresh: freshCheck }), realScore: realScore(), phone,
    recording: manifest ? { base: manifest.base, version: manifest.version, recordedAt: manifest.recordedAt } : null, missing,
  };
  writeFileSync(`${GENERATED}timeline.json`, JSON.stringify(timeline, null, 2));
  return timeline;
}

export const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export function printTimeline(t) {
  console.log(`  title card   ${TITLE_SECONDS.toFixed(1)} s`);
  for (const s of t.scenes) {
    const parts = s.voiceParts.length > 1 ? ` in ${s.voiceParts.length} parts at ${s.voiceParts.map((p) => p.at.toFixed(1)).join(", ")} s` : "";
    const voice = s.voice ? `voice ${s.voiceSeconds.toFixed(1)} s${parts}, quiet after ${(s.seconds - s.voiceParts.at(-1).at - s.voiceParts.at(-1).seconds).toFixed(1)} s` : "no voice yet";
    const lead = s.leadIn ? ` + ${s.leadIn.buyer}'s page ${s.leadIn.seconds} s` : "";
    const clip = s.kind === "clip" ? (s.clip ? `clip ${s.clip.duration.toFixed(1)} s` : "NO CLIP") : s.kind === "phone" ? (t.phone ? `phone clip ${t.phone.duration.toFixed(1)} s${lead}` : "phone placeholder") : s.kind;
    const extra = s.extra ? `, +${s.extra} s extra` : "";
    console.log(`  scene ${String(s.n).padStart(2)}    ${s.seconds.toFixed(1).padStart(4)} s   (planned ${s.planned} s; ${clip}; ${voice}${extra})`);
  }
  console.log(`  total        ${fmt(t.totalSeconds)} (limit ${fmt(t.limitSeconds)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t = buildTimeline({ draft: !process.argv.includes("--final"), freshCheck: process.argv.includes("--check") });
  printTimeline(t);
}
