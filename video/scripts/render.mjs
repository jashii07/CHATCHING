// Renders the demo video with Remotion.
//   npm run draft   -> out/chatching-draft.mp4  (a "DRAFT" badge; missing voice lines and the phone clip are
//                      silent placeholders; reuses the last npm run check result if there is one)
//   npm run final   -> out/chatching-final.mp4  (stops if a voice line or the phone clip is missing; then
//                      RE-RECORDS the live site, so the video shows the current design; stops if the video
//                      would be 2:55 or longer; runs npm run check fresh for scene 9)
//                      --no-record  reuse the clips from the last recording
//                      --judge=2    pay with the README's second judge login
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mediaSeconds } from "./lib/ff.mjs";
import { buildTimeline, findVoice, fmt, printTimeline } from "./timeline.mjs";

const draft = process.argv.includes("--draft");
const VIDEO_DIR = fileURLToPath(new URL("../", import.meta.url));
const out = `out/chatching-${draft ? "draft" : "final"}.mp4`;

if (!draft) {
  // Fail fast, before a 4-minute recording: Jasper's own files must be in place.
  const has = (dir, base, exts) => exts.some((e) => existsSync(`${VIDEO_DIR}public/${dir}/${base}.${e}`));
  const noVoice = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => !findVoice(n));
  const noPhone = !has("phone", "pickup", ["mp4", "mov", "m4v", "webm", "MP4", "MOV"]);
  if (noVoice.length || noPhone) {
    console.log("Stopped, nothing recorded yet:");
    if (noVoice.length) console.log(`- voice line(s) missing for scene(s) ${noVoice.join(", ")}: put the recordings in public/voice/, then run npm run voice`);
    if (noPhone) console.log("- the phone clip is missing: public/phone/pickup.mp4");
    process.exit(1);
  }
  if (!process.argv.includes("--no-record")) {
    console.log("Recording the live site again (about 4 minutes; 7 sandbox invoices, one sandbox payment)...");
    const extra = process.argv.includes("--judge=2") ? " --judge=2" : "";
    const rec = spawnSync(`node scripts/record.mjs --strict-version${extra}`, { cwd: VIDEO_DIR, stdio: "inherit", shell: true });
    if (rec.status !== 0) process.exit(rec.status ?? 1);
  }
}

const timeline = buildTimeline({ draft, freshCheck: !draft || process.argv.includes("--check") });
console.log(`\nTimeline (${draft ? "draft" : "final"}):`);
printTimeline(timeline);

const problems = [];
if (timeline.missing.clips.length) problems.push(`no recorded clip for scene(s) ${timeline.missing.clips.join(", ")}: run npm run record`);
if (timeline.totalSeconds > timeline.limitSeconds) problems.push(`the video is ${fmt(timeline.totalSeconds)}, over ${fmt(timeline.limitSeconds)}: shorten the longest voice lines (see the list above)`);
if (!draft) {
  if (timeline.missing.voice.length) problems.push(`voice line(s) missing for scene(s) ${timeline.missing.voice.join(", ")}: run npm run voice`);
  if (timeline.missing.phone) problems.push("the phone clip is missing: public/phone/pickup.mp4");
}
if (problems.length) {
  console.log(`\n${draft ? "Warning" : "Stopped"}:\n- ${problems.join("\n- ")}`);
  if (!draft || timeline.missing.clips.length) process.exit(1);
}

mkdirSync(`${VIDEO_DIR}out`, { recursive: true });
console.log(`\nRendering ${out} ...`);
const bin = process.platform === "win32" ? "node_modules\\.bin\\remotion.cmd" : "node_modules/.bin/remotion";
const res = spawnSync(`${bin} render src/index.jsx ChatChingDemo ${out} --codec=h264 --crf=18 --concurrency=50%`, { cwd: VIDEO_DIR, stdio: "inherit", shell: true });
if (res.status !== 0) process.exit(res.status ?? 1);

const length = mediaSeconds(`${VIDEO_DIR}${out}`);
console.log(`\nDone: video/${out}, ${fmt(length)} long.`);
