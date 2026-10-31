// The self-hosted QR reader (Step 10c): the file the page serves is the pinned package's file, unchanged,
// with its licence next to it, and the page gets it from our own server, not from a new CDN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("public/vendor/jsQR.js is the pinned jsQR file, unchanged", { skip: !existsSync(new URL("../node_modules/jsqr/dist/jsQR.js", import.meta.url)) }, () => {
  assert.equal(JSON.parse(file("package.json")).devDependencies.jsqr, "1.4.0");
  assert.equal(file("public/vendor/jsQR.js"), file("node_modules/jsqr/dist/jsQR.js"));
});

test("its Apache-2.0 licence is served next to it", () => {
  assert.match(file("public/vendor/jsQR-LICENSE.txt"), /Apache License\s+Version 2\.0/);
  assert.match(file("public/vendor/README.md"), /jsQR 1\.4\.0/);
});

test("the page loads the reader from our own server; no new CDN", () => {
  assert.match(file("public/app.js"), /"vendor\/jsQR\.js"/);
  const hosts = [...file("public/index.html").matchAll(/https?:\/\/[^/"]+/g)].map(([url]) => url);
  assert.deepEqual([...new Set(hosts)], ["https://cdn.jsdelivr.net"]);
});

test("the reader never uses eval, so a later Content-Security-Policy needn't allow 'unsafe-eval'", () => {
  assert.doesNotMatch(file("public/vendor/jsQR.js"), /\beval\s*\(|new Function\b/);
});
