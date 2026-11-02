// Finds test files that Windows Node itself crashed, so npm run check can rerun them once (DECISIONS.md, review #18).
// The crash has one exact exit code, and the whole file's tests are lost with no error text. Only that counts:
// a test that fails, or a process that ends any other way, is a real failure and is never rerun.
// Used as a second reporter by scripts/check.mjs: it writes one crashed file per line.
export const WINDOWS_CRASH = 0xC0000409; // 3221226505

export function crashedFile(event) {
  if (event.type !== "test:fail" || event.data?.nesting !== 0) return null;
  const error = event.data.details?.error;
  const code = error?.exitCode ?? error?.cause?.exitCode;
  return error?.failureType === "testCodeFailure" && code === WINDOWS_CRASH ? event.data.file : null;
}

// Did the tests pass? Only a crash counts as forgivable: every failure must be a crashed file, and every crashed
// file must have passed its one rerun. Anything unreadable is a failure.
export function testsPassed({ status, failed, cancelled, crashed, reruns }) {
  if (status === 0) return true;
  if (!crashed.length || reruns.length !== crashed.length) return false;
  return failed === crashed.length && cancelled === 0 && reruns.every((code) => code === 0);
}

export default async function* crashReporter(source) {
  for await (const event of source) {
    const file = crashedFile(event);
    if (file) yield `${file}\n`;
  }
}
