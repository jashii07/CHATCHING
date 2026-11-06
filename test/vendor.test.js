// Third-party code the page uses, served from our own server (public/vendor/): jsQR (Step 10c), and AG Grid and
// Lucide (6 Nov, user test fix: a judge on a network that blocks jsDelivr would have seen no table). Each served
// file is the pinned package's file, unchanged, with its licence next to it. No page loads anything from
// another site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const url = (path) => new URL(`../${path}`, import.meta.url);
const file = (path) => readFileSync(url(path), "utf8").replaceAll("\r\n", "\n");
const bytes = (path) => readFileSync(url(path));
const devDeps = JSON.parse(file("package.json")).devDependencies;

// public/vendor/<name> <- node_modules/<from>, at the pinned version.
const VENDORED = [
  { name: "jsQR.js", pkg: "jsqr", version: "1.4.0", from: "jsqr/dist/jsQR.js", licence: "jsQR-LICENSE.txt", licenceFrom: "jsqr/LICENSE", says: /Apache License\s+Version 2\.0/ },
  { name: "ag-grid-community.min.js", pkg: "ag-grid-community", version: "36.2.0", from: "ag-grid-community/dist/ag-grid-community.min.js", licence: "ag-grid-community-LICENSE.txt", licenceFrom: "ag-grid-community/LICENSE.txt", says: /The MIT License/ },
  { name: "lucide.min.js", pkg: "lucide", version: "1.55.0", from: "lucide/dist/umd/lucide.min.js", licence: "lucide-LICENSE.txt", licenceFrom: "lucide/LICENSE", says: /ISC License/ },
  // Lucide's file ends with a pointer to its source map; without the map, DevTools would warn about it.
  { name: "lucide.min.js.map", pkg: "lucide", version: "1.55.0", from: "lucide/dist/umd/lucide.min.js.map" },
];

for (const v of VENDORED) {
  test(`public/vendor/${v.name} is the pinned ${v.pkg} ${v.version} file, unchanged`, { skip: !existsSync(url(`node_modules/${v.from}`)) }, () => {
    assert.equal(devDeps[v.pkg], v.version, `${v.pkg} is pinned to exactly ${v.version}`);
    assert.ok(bytes(`public/vendor/${v.name}`).equals(bytes(`node_modules/${v.from}`)), `${v.name} differs from node_modules/${v.from}`);
  });
  if (!v.licence) continue;
  test(`${v.pkg}'s licence is served next to it, and the vendor README names the version`, () => {
    assert.match(file(`public/vendor/${v.licence}`), v.says);
    if (existsSync(url(`node_modules/${v.licenceFrom}`))) assert.equal(file(`public/vendor/${v.licence}`), file(`node_modules/${v.licenceFrom}`));
    assert.match(file("public/vendor/README.md"), new RegExp(`${v.pkg}[^\\n]*${v.version.replaceAll(".", "\\.")}`, "i"), "README's line for it names the version");
  });
}

// The integrity hashes the page has used since 25 and 27 Oct, when the files came from jsDelivr: the same bytes now.
const PINNED_HASHES = {
  "vendor/ag-grid-community.min.js": "sha384-icvtRKM0YJJgeDhXnWY8UlF1PVBFd4K8Pj61la+vG+EU+awBeoP0xGPZhCD2SQOV",
  "vendor/lucide.min.js": "sha384-SZUFq9Dx112fyzY/iIBEjyd2gu3jY4XVhp+LUNXSpEMB2IEm/TOoMTNH4BHtQ6Hz",
};

test("the page loads AG Grid and Lucide from our own server, each with its integrity hash, and the hash fits the file", () => {
  const html = file("public/index.html");
  for (const [src, hash] of Object.entries(PINNED_HASHES)) {
    const tag = html.match(new RegExp(`<script\\b[^>]*src="${src}"[^>]*>`))?.[0];
    assert.ok(tag, `index.html loads ${src}`);
    assert.match(tag, new RegExp(`integrity="${hash.replaceAll("+", "\\+").replaceAll("/", "\\/")}"`), src);
    assert.equal(`sha384-${createHash("sha384").update(bytes(`public/${src}`)).digest("base64")}`, hash, `public/${src} has the bytes the hash promises`);
  }
});

test("no page names another site: every script, style and font comes from our own server", () => {
  assert.match(file("public/app.js"), /"vendor\/jsQR\.js"/);
  for (const name of ["index.html", "pair.html", "order.html", "styles.css"]) {
    const hosts = [...file(`public/${name}`).matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]+"|url\(\s*["']?(https?:)?\/\//g)].map(([match]) => match);
    assert.deepEqual(hosts, [], `${name} loads from another site`);
  }
  assert.doesNotMatch(file("public/index.html"), /jsdelivr|unpkg|cdnjs/i);
});

test("the reader never uses eval, so the Content-Security-Policy needn't allow 'unsafe-eval'", () => {
  assert.doesNotMatch(file("public/vendor/jsQR.js"), /\beval\s*\(|new Function\b/);
});
