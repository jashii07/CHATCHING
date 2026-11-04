// Saves still frames from a rendered video to out/frames/, for checking by eye: captions readable,
// nothing cut off, no logins on screen. One frame every N seconds plus a contact sheet.
// Run: npm run frames                      (out/chatching-draft.mp4, every 4 s)
//      npm run frames -- out/chatching-final.mp4 2
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mediaSeconds, run } from "./lib/ff.mjs";

const VIDEO_DIR = fileURLToPath(new URL("../", import.meta.url));
const file = `${VIDEO_DIR}${process.argv[2] ?? "out/chatching-draft.mp4"}`;
const every = Number(process.argv[3] ?? 4);
const dir = `${VIDEO_DIR}out/frames/`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const length = mediaSeconds(file);
let count = 0;
for (let t = 1; t < length; t += every) {
  const name = `${String(Math.floor(t / 60))}m${String(Math.floor(t % 60)).padStart(2, "0")}s.png`;
  run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", `${dir}${name}`]);
  count++;
}
run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vf", `fps=1/${every},scale=480:-1,tile=6x8`, "-frames:v", "1", `${dir}contact-sheet.png`]);
console.log(`${count} frames + contact-sheet.png in out/frames/ (video ${length.toFixed(1)} s)`);
