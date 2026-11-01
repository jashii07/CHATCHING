// Loaded before every test file (npm test, npm run check). In our tests one process is both the server and the
// browser-like client. On Windows, Node's fetch keeping connections open for reuse crashed that process about
// once in 400 runs of a file under load: exit code 3221226505 (0xC0000409), no error text, and every test in the
// file lost (DECISIONS.md, 2 Nov). Measured on test/api.test.js: 5 crashes in 2,000 runs, and 0 in 2,000 with this.
// Tests don't need reuse, so each request here closes its connection. The app itself is unchanged.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? input?.headers);
  headers.set("Connection", "close");
  return realFetch(input, { ...init, headers });
};
