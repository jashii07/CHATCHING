// Security headers (review #13), refusing requests from other websites (CSRF), and listening only on this
// computer when not on Render. These are backup protection: no script injection was found in the review.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start(env = {}) {
  const server = createApp(loadConfig(env), { log: () => {}, visitorsDir: mkdtempSync(join(tmpdir(), "chatching-security-")) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return `http://localhost:${server.address().port}`;
}

const policyOf = (res) => Object.fromEntries((res.headers.get("content-security-policy") ?? "").split(";").map((part) => {
  const [name, ...values] = part.trim().split(/\s+/);
  return [name, values];
}));
const scriptsIn = (html) => [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);

test("every kind of reply carries the security headers: the page, the phone page, a file, the API and a 404", async () => {
  const base = await start();
  for (const path of ["/", "/pair", "/app.js", "/api/health", "/api/state", "/nothing-here"]) {
    const res = await fetch(base + path);
    assert.ok(res.headers.get("content-security-policy"), `${path}: Content-Security-Policy`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("referrer-policy"), "same-origin", path);
    assert.equal(res.headers.get("permissions-policy"), "camera=(self), microphone=(), geolocation=(), payment=()", path);
  }
});

test("the policy forbids what it should: no eval, no inline scripts, no wildcards, nobody may frame the page", async () => {
  const policy = policyOf(await fetch(await start()));
  assert.deepEqual(policy["default-src"], ["'self'"]);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'self'"]);
  assert.deepEqual(policy["form-action"], ["'self'"]);
  assert.deepEqual(policy["connect-src"], ["'self'"]);
  assert.deepEqual(policy["font-src"], ["'self'", "data:"], "our Inter file + AG Grid's icon fonts, which sit inside its pinned file");
  assert.deepEqual(policy["img-src"], ["'self'", "data:"], "data: is for the QR images");
  assert.ok(!Object.values(policy).flat().includes("'unsafe-eval'"), "never 'unsafe-eval'");
  assert.ok(!policy["script-src"].includes("'unsafe-inline'"), "no inline scripts");
  assert.ok(!Object.values(policy).flat().some((value) => value === "*" || value === "https:" || value === "blob:"), "no wide-open source");
});

test("the page's scripts all come from our own server (6 Nov: no CDN), and the policy allows only that", async () => {
  const res = await fetch(await start());
  const tags = scriptsIn(await res.text());
  assert.ok(tags.length >= 3);
  assert.deepEqual(policyOf(res)["script-src"], ["'self'"], "no other site may serve a script");
  for (const tag of tags) {
    assert.match(tag, /\bsrc="/, "no inline script");
    assert.doesNotMatch(tag, /src="(https?:)?\/\//, `a script from another site: ${tag}`);
    if (/src="vendor\//.test(tag)) assert.match(tag, /integrity="sha384-/, `third-party code keeps its integrity hash: ${tag}`);
  }
});

test("no page holds an inline script or an inline event handler (the policy would block them)", () => {
  for (const name of ["index.html", "pair.html", "order.html"]) {
    const html = readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
    for (const tag of scriptsIn(html)) assert.match(tag, /\bsrc="/, name);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, name);
  }
});

const post = (base, path, headers = {}, method = "POST") => fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: "{}" });

test("a POST, PUT or DELETE from another website is refused before anything happens", async () => {
  const base = await start();
  for (const [method, path] of [["POST", "/api/reset"], ["POST", "/api/invoices"], ["POST", "/api/pair/open"], ["PUT", "/api/orders/r1"], ["DELETE", "/api/orders/r1"]]) {
    const res = await post(base, path, { Origin: "https://evil.example" }, method);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "This request came from another website, so it was refused." });
    assert.equal(res.headers.getSetCookie().length, 0, "a refused request makes no visitor");
  }
});

test("look-alike origins are refused too: another port, a longer name, a null origin, nonsense", async () => {
  const base = await start();
  const { host, hostname, port } = new URL(base);
  for (const origin of [`http://${hostname}:${Number(port) + 1}`, `http://${host}.evil.example`, `http://evil.example/${host}`, `http://${host}@evil.example`, "null", "not a url", ""]) {
    assert.equal((await post(base, "/api/reset", { Origin: origin })).status, 403, JSON.stringify(origin));
  }
});

test("our own page's requests go through, with the Origin a browser sends", async () => {
  const base = await start();
  const res = await post(base, "/api/reset", { Origin: base });
  assert.equal(res.status, 200);
});

test("behind Render's proxy the Origin is https and the Host is the public name: still our own site", async () => {
  const base = await start({ RENDER: "true" });
  // Node's fetch sets Host itself, so this one goes through http.request, as Render's proxy would send it.
  const statusWith = (headers) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = httpRequest({ hostname, port, path: "/api/reset", method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end("{}");
  });
  const proxied = { Host: "chatching.onrender.com", "X-Forwarded-Proto": "https" };
  assert.equal(await statusWith({ ...proxied, Origin: "https://chatching.onrender.com" }), 200);
  assert.equal(await statusWith({ ...proxied, Origin: "https://evil.example", "X-Forwarded-Host": "evil.example" }), 403, "a faked forwarded name doesn't help");
});

test("a request with no Origin header goes through: scripts, tests and old browsers send none", async () => {
  const base = await start();
  assert.equal((await post(base, "/api/reset")).status, 200);
});

test("reading is never refused: a GET from another website stays a plain read", async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } })).status, 200);
});

test("not on Render: listen on this computer only. On Render: Render's normal setting", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({ PORT: "4000" }).host, "127.0.0.1");
  assert.equal(loadConfig({ RENDER: "true" }).host, "0.0.0.0");
});
