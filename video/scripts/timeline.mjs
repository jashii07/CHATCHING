// Builds public/generated/timeline.json: everything the Remotion edit needs, worked out in Node.
//   - captions and planned scene times straight from PLAN.md Section 13 (the storyboard table)
//   - the recorded clips (public/clips/manifest.json from npm run record)
//   - Jasper's voice lines public/voice/scene1.m4a ... scene10.m4a, if they exist (their lengths set the scene lengths)
//   - Jasper's phone clip public/phone/pickup.mp4 (or .mov), turned into a plain H.264 copy the edit can play
//   - the demo chats (scene 1), the npm run check result and the real-orders score (scene 9)
// Run on its own: node scripts/timeline.mjs   (npm run draft / final / studio run it first anyway)
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mediaSeconds, run } from "./lib/ff.mjs";

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

// The phone clip as H.264 at up to 1080 px tall, no sound (the voice line plays instead).
function phoneClip() {
  const src = findFile(`${PUBLIC}phone/`, "pickup", ["mp4", "mov", "m4v", "webm", "MP4", "MOV"]);
  if (!src) return null;
  const out = `${GENERATED}phone.mp4`;
  if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
    console.log(`Converting the phone clip ${src.replace(PUBLIC, "public/")} ...`);
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-an", "-vf", "scale=-2:'min(1080,ih)',fps=30,format=yuv420p",
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", out]);
  }
  return { file: "generated/phone.mp4", duration: mediaSeconds(out) };
}

export function buildTimeline({ draft = true, freshCheck = false } = {}) {
  mkdirSync(GENERATED, { recursive: true });
  copyFileSync(new URL("public/fonts/inter-latin-wght-normal.woff2", ROOT), `${GENERATED}inter.woff2`);
  const board = storyboard();
  const manifestFile = `${PUBLIC}clips/manifest.json`;
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
  const phone = phoneClip();
  const missing = { voice: [], clips: [], phone: !phone };

  const scenes = board.map((b) => {
    const voiceFile = findFile(`${PUBLIC}voice/`, `scene${b.n}`, ["m4a", "mp3", "wav", "M4A"]);
    const voiceSeconds = voiceFile ? mediaSeconds(voiceFile) : null;
    if (!voiceFile) missing.voice.push(b.n);
    const voiceNeeds = voiceSeconds ? VOICE_DELAY + voiceSeconds + VOICE_PAD : 0;
    const scene = { n: b.n, caption: b.caption, planned: b.planned, voice: voiceFile ? `voice/${voiceFile.split("/").pop()}` : null, voiceSeconds, voiceDelay: VOICE_DELAY };
    if (CLIP_SCENES.includes(b.n)) {
      const clip = manifest?.scenes?.[b.n];
      if (!clip) missing.clips.push(b.n);
      scene.kind = "clip";
      scene.clip = clip ?? null;
      // The clip plays at normal speed; a longer voice line holds the last frame a little.
      scene.seconds = Math.max(clip?.duration ?? b.planned, voiceNeeds);
    } else {
      scene.kind = { 1: "chats", 8: "phone", 9: "tech", 10: "logo" }[b.n];
      let base = b.planned;
      if (b.n === 8 && phone) base = Math.min(Math.max(phone.duration, 6), 22);
      scene.seconds = voiceSeconds ? Math.max(voiceNeeds, MIN_SECONDS[b.n], b.n === 8 && phone ? base : 0) : base;
    }
    scene.seconds = Math.round(scene.seconds * FPS) / FPS;
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
    const voice = s.voice ? `voice ${s.voiceSeconds.toFixed(1)} s` : "no voice yet";
    const clip = s.kind === "clip" ? (s.clip ? `clip ${s.clip.duration.toFixed(1)} s` : "NO CLIP") : s.kind === "phone" ? (t.phone ? `phone clip ${t.phone.duration.toFixed(1)} s` : "phone placeholder") : s.kind;
    console.log(`  scene ${String(s.n).padStart(2)}    ${s.seconds.toFixed(1).padStart(4)} s   (planned ${s.planned} s; ${clip}; ${voice})`);
  }
  console.log(`  total        ${fmt(t.totalSeconds)} (limit ${fmt(t.limitSeconds)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t = buildTimeline({ draft: !process.argv.includes("--final"), freshCheck: process.argv.includes("--check") });
  printTimeline(t);
}
