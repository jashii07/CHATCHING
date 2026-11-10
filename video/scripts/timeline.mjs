// Builds public/generated/timeline.json: everything the Remotion edit needs, worked out in Node.
//   - captions and planned scene times straight from PLAN.md Section 13 (the storyboard table)
//   - the recorded clips (public/clips/manifest.json from npm run record)
//   - Jasper's voice lines public/voice/scene1.m4a ... scene10.m4a, if they exist (their lengths set the scene lengths)
//   - Jasper's phone clip public/phone/pickup.mp4 (or .mov, or the newest video there), cropped to the page and turned
//     into a plain H.264 copy the edit can play; the scene 8 lead-in still from the recording
//   - voice lines 3, 6 and 8 split at pauses and placed on their moments; the cha-ching sound (lib/chime.mjs), on the
//     title card and when Lina turns Paid
//   - the sync edits (10 Nov): scenes 3, 4 and 5 re-cut into shots so each moment lands on its words, row highlights
//     in scene 3, the question times in scene 1, the word times in scene 9
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

// Voice lines split at a pause, so each part plays over its moment (Mon 9 Nov; scenes 3 and 8 on Tue 10 Nov).
// `splits` are points inside a pause of Jasper's recording (checked below: if one isn't silent, the line plays
// whole, as before). A part with an anchor starts at that cue (from the recording), minus how far into the part
// its key word is; a part without one follows the part before it (the pause is inside the split), plus `extra`.
//   3: "Watch this. ... each buyer's final order." | "Lina changed her mind? Updated." | "Aisyah said 'same as Lina'?
//      Understood." | "Danish cancelled? Removed." | "But here's the important part: the AI never sets a price. Prices
//      always come from the menu." | "So when Jun Wei quotes the wrong price, ... for me to check." The picture
//      follows these parts (EDITS below); 0.3 s more before "But here's the important part", where it cuts to the totals.
//   6: "Next, each buyer gets a private order page. Lina checks her order, taps 'Looks right'," (taps at 6.1 s)
//      | "and pays with PayPal." | "A moment later, | ChatChing shows her as Paid. Cha-ching!" (the pause at 1.15 s:
//      the cha-ching sound lands there, just before "ChatChing shows her as Paid")
//   8: "Then at pickup, I simply scan the buyer's QR code with my phone." ("scan" 2.26 s in, as the phone's scanner
//      opens) | "Paid? Great," ("Paid?" right after the phone shows Paid) | "it's collected. Not paid yet? I'll know
//      before handing anything over." ("collected" starts 0.41 s in: 0.3 s before the tap on Collected)
const VOICE_PARTS = {
  3: { splits: [5.95, 8.4, 11.4, 13.44, 19.85], extra: [0, 0, 0, 0, 0.3, 0] },
  6: { splits: [7.43, 8.88], anchors: [["looks", 6.1], ["pay", 0.2], ["paid", 1.15]] },
  8: { splits: [5.03, 7.11], anchors: [["scan", 2.26], ["paid", 0.1], ["collected", 0.71]] },
};

// Scene 8: a 1.5 s still of the paid buyer's order page (record.mjs) before the phone clip.
const LEAD_IN_SECONDS = 1.5;
// Jasper's phone clip (Mon 9 Nov, video_2026-11-09_17-39-37.mp4, a screen recording, 576 x 1280): the scanner opens
// 2.0 s in, the page shows "Paid: Aisyah" 4.9 s in, and the tap on Collected is at 8.0 s. The phone's status bar
// (notification icons), Chrome's address bar and the navigation bar are cropped off, so only ChatChing's page shows.
const PHONE_SCAN_AT = 2.0;
const PHONE_PAID_AT = 4.9;
const PHONE_COLLECTED_AT = 8.0;
const PHONE_CROPS = { "576x1280": { top: 152, height: 1054 } };

// ---- Sync (Tue 10 Nov): the picture shows what the voice says, within about 0.3 s ----
// Where each key word starts was measured on the processed voice lines (Windows' own speech recognizer for the
// words, the loudness for the exact starts), and where each moment is in the 9 Nov recording on its frames. So
// these edits belong to that recording and those voice lines: if either changes, the edit switches off with a
// warning and the scene plays as before (the clip straight through, the voice whole).
const SYNCED_RECORDING = "2026-11-09T10:35:26.680Z";
const SYNCED_VOICE = { 1: 13.161, 3: 27.267, 4: 8.638, 5: 15.146, 9: 19.199 }; // seconds, public/voice-ready/sceneN.wav

// Scene 1 (the 10 Nov hook): when each question starts in the voice line, and "My friend sorts this out...".
const HOOK = { questions: [["Who wants what?", 3.95], ["Who changed their mind?", 5.63], ["Who actually paid?", 6.98]], friend: 8.62 };
// Scene 9: when each thing is named ("Under the hood" 0.23 s, "PayPal's" 1.34 s ...), so it appears then.
const TECH = { hood: 0.23, paypal: 1.34, gemini: 3.58, aggrid: 4.66, tests: 6.17, real: 9.3, quote: 16.63 };

// Boxes on the 1920 x 1080 recording, measured on its frames: the rows of the table and the cards named in the voice.
const BOX = {
  lina: { x: 288, y: 269, width: 1344, height: 94 }, // scene 3, page 1 (clip 8.7-10 s)
  aisyah: { x: 288, y: 556, width: 1344, height: 94 }, // page 1 after Lina's panel closed (clip 16-19 s)
  danish: { x: 288, y: 302, width: 1344, height: 94 }, // page 2, crossed out: Cancelled
  junWei: { x: 288, y: 584, width: 1344, height: 170 }, // page 2, amber: the price check
  junWeiCheck: { x: 300, y: 600, width: 660, height: 140 }, // his name, items and "Check: buyer mentioned RM 15.00, menu says RM 18.00."
  expected: { x: 256, y: 180, width: 483, height: 255 }, // the Expected RM 366.00 card (clip 3-7.5 s)
  question: { x: 1492, y: 694.6, width: 376, height: 127 }, // scene 4: Priya's question + Copy question
  sent: { x: 274, y: 662, width: 1170, height: 180 }, // scene 5: "All invoices sent" (disabled) + "7 of 7 sent."
};

// The picture of a recorded scene as shots: from scene time `at`, the clip plays from `from` to `to` (at `speed`),
// then holds on `to` until the next shot. `v` = the scene's voice parts (scene time `at`); word times are seconds
// into the voice line (file), measured as above. Zooms and highlights are in scene time; `until` ends one at a cut.
const EDITS = {
  // Scene 3 (clip: 0.9 s Read orders, 1.6 s rows in, 3-7.5 s the totals, 8.7 s page 1, 9.6 s cursor on Lina's
  // items, 17.6-18.9 s on Aisyah's, 22.4-23.4 s page 2 on Danish's, 25.6 s on: Jun Wei's amber row, cursor below it).
  3: (v) => {
    const [, b, c, d, e, f] = v.map((p) => p.at);
    const lina = b + 0.37, aisyah = c + 0.28, danish = d + 0.24, ai = e + 2.11, junWei = f + 0.64, price = f + 2.0;
    return {
      shots: [
        { at: 0, from: 0, to: 2.7 }, // "Watch this. Gemini reads every conversation...": Read orders, the rows come in
        { at: 2.7, from: 8.25, to: 8.75 }, // "...each buyer's final order": down to the table
        { at: lina - 0.85, from: 8.75, to: 9.95 }, // the cursor reaches Lina's items as her name is said
        { at: c, from: 17.55, to: 18.85 }, // Aisyah's items
        { at: d, from: 22.35, to: 23.4 }, // page 2: Danish, crossed out
        { at: e, from: 3.05, to: 7.5 }, // "But here's the important part": the totals
        { at: f, from: 25.6, to: 29.9 }, // "So when Jun Wei...": his amber row
      ],
      highlights: [
        { from: lina - 0.1, to: c, box: BOX.lina },
        { from: aisyah - 0.1, to: d, box: BOX.aisyah },
        { from: danish - 0.1, to: e, box: BOX.danish },
        { from: ai - 0.1, to: f, box: BOX.expected, radius: 30 },
        { from: junWei - 0.1, to: Infinity, box: BOX.junWei },
      ],
      zooms: [
        { at: ai - 0.6, hold: 99, until: f, box: BOX.expected }, // "the AI never sets a price"
        { at: price - 0.4, hold: 99, box: BOX.junWeiCheck }, // "quotes the wrong price": the check
      ],
    };
  },
  // Scene 4 (clip: 3.85 s Priya's row clicked, 5.5 s her panel shows the question, 12.25 s Copy question -> Copied,
  // 13.5 s the panel closes). Voice: "Priya's" 2.03 s, "tap" 4.45 s.
  4: (v) => {
    const priya = v[0].at + 2.03, tap = v[0].at + 4.45;
    return {
      shots: [
        { at: 0, from: 3.85 - (priya + 0.1), to: 5.75 }, // page 1, Priya's amber row clicked on "Priya's"
        { at: tap + 0.05 - 0.4, from: 11.85, to: 13.4 }, // "One tap copies...": the tap on Copy question
      ],
      highlights: [],
      zooms: [{ at: tap - 0.85, hold: 99, box: BOX.question }],
    };
  },
  // Scene 5 (clip: 1.8 s cursor on Send 7 invoices, 3.35 s the click, 3.6-8.6 s the bar fills, 8.5 s "Invoices
  // sent", 13.5 s cursor to the button again, 14.0 s the second click: nothing). Voice: "click" 5.05 s, "click
  // again" 9.42 s, "Nothing happens" 11.25 s.
  5: (v) => {
    const click = v[0].at + 5.05, again = v[0].at + 9.42, nothing = v[0].at + 11.25;
    return {
      shots: [
        { at: 0, from: 0, to: 1.85 }, // "Now, seven orders are ready, worth RM 366.": the totals, cursor on the button
        { at: click - 0.9, from: 2.45, to: 3.6 }, // "One click"
        { at: click + 0.25, from: 3.6, to: 8.6, speed: 2 }, // "...every buyer gets their own PayPal invoice": the bar
        { at: click + 2.75, from: 8.6, to: 9.7 }, // "Invoices sent"
        { at: again - 0.5, from: 13.5, to: 15.9 }, // "And if I click again by accident?"
      ],
      highlights: [],
      zooms: [{ at: nothing - 0.3, hold: 99, box: BOX.sent }], // "Nothing happens": still 7 of 7
    };
  },
};

// Seconds added to a scene on top of what its clip and voice need: the time scene 6 (sped-up waits) and scene 8
// (a 12.7 s phone clip) saved, given to the scenes with the least quiet after their line.
const EXTRA = { 7: 0.3, 9: 0.5, 10: 0.3 };
// The cha-ching's loudest sample in the video (0..1). The voice lines peak at -1.5 dBTP; the chime is a short,
// bright sound, so it sits well below them.
const CHIME_PEAK = 0.4;
// The title card plays the same cha-ching (same file, same level) as the logo appears: Demo.jsx fades the logo in
// from this moment (0.2 s, so the video doesn't open on the sound's first instant).
const TITLE_CHIME_AT = 0.2;

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

// Where each voice part starts in its scene: at its anchor (never before the previous part has ended, plus 0.1 s),
// or right after the previous part (plus its `extra`) when it has none. The first part without an anchor starts
// VOICE_DELAY into the scene.
function placeVoice(n, voiceFile, voiceSeconds, cues) {
  const whole = [{ file: voiceFile.slice(PUBLIC.length), at: VOICE_DELAY, seconds: voiceSeconds }];
  const plan = VOICE_PARTS[n];
  if (!plan) return whole;
  if ((plan.anchors ?? []).some(([cue]) => cue && cues?.[cue] === undefined)) {
    console.log(`  scene ${n}: no cue times in the recording, so the voice line plays whole`);
    return whole;
  }
  const parts = splitVoice(n, voiceFile, plan.splits);
  if (!parts) return whole;
  let end = null; // where the previous part ends
  return parts.map((part, i) => {
    const [cue, offset] = plan.anchors?.[i] ?? [];
    const after = end === null ? VOICE_DELAY : end + (cue ? 0.1 : plan.extra?.[i] ?? 0);
    const at = cue ? Math.max(after, cues[cue] - offset) : after;
    end = at + part.seconds;
    return { ...part, at: +at.toFixed(3) };
  });
}

// The scene's picture edit (EDITS), if it still fits: the same recording, the same voice line, every part placed.
function pictureEdit(n, clip, manifest, voiceFile, voiceParts) {
  if (!EDITS[n] || !clip) return null;
  const off = (why) => {
    console.log(`  scene ${n}: ${why}, so the sync edit is off: the clip plays straight (check the timing by eye)`);
    return null;
  };
  if (manifest?.recordedAt !== SYNCED_RECORDING) return off(`a new recording (${manifest?.recordedAt}, the edit was made on ${SYNCED_RECORDING})`);
  if (!voiceFile || Math.abs(mediaSeconds(voiceFile) - SYNCED_VOICE[n]) > 0.02) return off("its voice line changed since the word times were measured");
  if (VOICE_PARTS[n] && voiceParts.length !== VOICE_PARTS[n].splits.length + 1) return off("its voice line plays whole");
  if (clip.popup || clip.masks?.length) return off("the clip has a popup or a cover, which the edit doesn't move");
  const edit = EDITS[n](voiceParts);
  for (let i = 1; i < edit.shots.length; i++) {
    const prev = edit.shots[i - 1];
    if (edit.shots[i].at < prev.at - 0.001) return off(`shot ${i + 1} starts before shot ${i}`);
  }
  if (edit.shots.some((s) => s.from < 0 || s.to > clip.duration + 0.01 || s.to < s.from)) return off("a shot is outside the clip");
  const round = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x);
  return {
    shots: edit.shots.map((s) => ({ at: round(s.at), from: round(s.from), to: round(s.to), speed: s.speed ?? 1 })),
    highlights: edit.highlights.map((h) => ({ ...h, from: round(h.from), to: Number.isFinite(h.to) ? round(h.to) : null })),
    zooms: edit.zooms.map((z) => ({ ...z, at: round(z.at), ...(z.until !== undefined ? { until: round(z.until) } : {}) })),
  };
}

// When a shot list's picture ends (its last shot reaches `to`); after that the last frame holds.
const shotsEnd = (shots) => Math.max(...shots.map((s) => s.at + (s.to - s.from) / (s.speed ?? 1)));

// A voice line measured for scenes 1 and 9: still the same file? (else its times would be off)
const sameVoice = (n, voiceFile) => voiceFile && Math.abs(mediaSeconds(voiceFile) - SYNCED_VOICE[n]) <= 0.02;

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
    const lead = leadIn ? LEAD_IN_SECONDS : 0;
    const cues = b.n === 8 ? { scan: lead + PHONE_SCAN_AT, paid: lead + PHONE_PAID_AT, collected: lead + PHONE_COLLECTED_AT } : clip?.cues;
    scene.voiceParts = voiceFile ? placeVoice(b.n, voiceFile, voiceSeconds, phone || b.n !== 8 ? cues : null) : [];
    const last = scene.voiceParts.at(-1);
    const voiceNeeds = last ? last.at + last.seconds + VOICE_PAD : 0;
    if (CLIP_SCENES.includes(b.n)) {
      if (!clip) missing.clips.push(b.n);
      scene.kind = "clip";
      scene.clip = clip;
      const edit = pictureEdit(b.n, clip, manifest, voiceFile, scene.voiceParts);
      // Without an edit the clip plays straight through at normal speed; with one, its shots (EDITS). Either way a
      // longer voice line holds the last frame a little.
      scene.shots = edit?.shots ?? (clip ? [{ at: 0, from: 0, to: (Math.max(1, Math.floor(clip.duration * FPS) - 1) - 1) / FPS, speed: 1 }] : null);
      scene.zooms = edit?.zooms ?? clip?.zooms ?? [];
      scene.highlights = edit?.highlights ?? [];
      scene.edited = Boolean(edit);
      scene.seconds = Math.max(edit ? shotsEnd(edit.shots) : clip?.duration ?? b.planned, voiceNeeds);
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
      const voiceAt = scene.voiceParts[0]?.at ?? VOICE_DELAY;
      // Scene 1: each question appears as it is said; the scroll slows down on "My friend sorts this out...".
      if (b.n === 1) {
        if (sameVoice(1, voiceFile)) {
          scene.hook = { questions: HOOK.questions.map(([text, t]) => ({ text, at: +(voiceAt + t).toFixed(3) })), slowAt: +(voiceAt + HOOK.friend).toFixed(3) };
        } else console.log("  scene 1: its voice line changed since the question times were measured, so the questions are off");
      }
      // Scene 9: each name and number appears as it is said.
      if (b.n === 9) {
        if (sameVoice(9, voiceFile)) scene.reveals = Object.fromEntries(Object.entries(TECH).map(([k, t]) => [k, +(voiceAt + t).toFixed(3)]));
        else console.log("  scene 9: its voice line changed since the word times were measured, so everything appears at the start, as before");
      }
    }
    scene.extra = EXTRA[b.n] ?? 0;
    scene.seconds = Math.round((scene.seconds + scene.extra) * FPS) / FPS;
    return scene;
  });

  const totalSeconds = TITLE_SECONDS + scenes.reduce((s, sc) => s + sc.seconds, 0);
  const timeline = {
    draft, fps: FPS, width: 1920, height: 1080, titleSeconds: TITLE_SECONDS, totalSeconds: Math.round(totalSeconds * FPS) / FPS,
    titleSounds: [{ file: "generated/chime.wav", at: TITLE_CHIME_AT }],
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
    const synced = s.edited ? `, synced in ${s.shots.length} shots` : s.hook ? ", questions synced" : s.reveals ? ", names synced" : "";
    console.log(`  scene ${String(s.n).padStart(2)}    ${s.seconds.toFixed(1).padStart(4)} s   (planned ${s.planned} s; ${clip}; ${voice}${extra}${synced})`);
  }
  console.log(`  total        ${fmt(t.totalSeconds)} (limit ${fmt(t.limitSeconds)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t = buildTimeline({ draft: !process.argv.includes("--final"), freshCheck: process.argv.includes("--check") });
  printTimeline(t);
}
