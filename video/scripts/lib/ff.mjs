// ffmpeg / ffprobe: the system copy if it is installed, otherwise the copy that ships with Remotion
// ("npx remotion ffmpeg"), so a fresh machine needs nothing extra.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VIDEO_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REMOTION = process.platform === "win32" ? "node_modules\\.bin\\remotion.cmd" : "node_modules/.bin/remotion";

function pick(tool) {
  const system = spawnSync(tool, ["-version"], { stdio: "ignore", shell: false });
  return system.status === 0 ? { cmd: tool, pre: [], shell: false } : { cmd: REMOTION, pre: [tool], shell: true };
}
const tools = {};

function exec(tool, args) {
  tools[tool] ??= pick(tool);
  const { cmd, pre, shell } = tools[tool];
  const quoted = shell ? args.map((a) => (/[\s"&|<>^;,=\[\]]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  const res = spawnSync(cmd, [...pre, ...quoted], { cwd: VIDEO_DIR, shell, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`${tool} failed (exit ${res.status}):\n${(res.stderr || "").split("\n").slice(-15).join("\n")}`);
  }
  return res;
}

export function run(tool, args, { quiet = true } = {}) {
  const res = exec(tool, args);
  if (!quiet) process.stdout.write(res.stdout);
  return res.stdout;
}

// What the tool printed on stderr: ffmpeg's measuring filters (silencedetect, loudnorm) write their results there.
export const runLog = (tool, args) => exec(tool, args).stderr;

// Length of an audio or video file in seconds.
export function mediaSeconds(file) {
  const out = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read the length of ${file}`);
  return seconds;
}
