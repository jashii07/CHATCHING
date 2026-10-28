// Tests for src/config.js: defaults, reading values, and never showing secrets.
// Uses FAKE keys only; the real .env is never loaded by the tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig } from "../src/config.js";

const FAKE = {
  PAYPAL_CLIENT_ID: "fake-client-id-123",
  PAYPAL_CLIENT_SECRET: "fake-secret-456",
  GEMINI_API_KEY: "fake-gemini-789",
};

test("defaults: port 3000, mock mode, no keys, and no crash", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.aiMode, "mock");
  assert.deepEqual(config.keysPresent, { PAYPAL_CLIENT_ID: false, PAYPAL_CLIENT_SECRET: false, GEMINI_API_KEY: false });
  assert.equal(config.paypalConfigured, false);
  assert.equal(config.geminiConfigured, false);
  assert.deepEqual(config.warnings, []);
});

test("reads PORT, AI_MODE and the keys from the environment", () => {
  const config = loadConfig({ PORT: "4000", AI_MODE: "real", ...FAKE });
  assert.equal(config.port, 4000);
  assert.equal(config.aiMode, "real");
  assert.equal(config.paypalConfigured, true);
  assert.equal(config.geminiConfigured, true);
  assert.equal(config.paypal.clientSecret, FAKE.PAYPAL_CLIENT_SECRET); // our code can still use the key
});

test("PayPal counts as configured only when BOTH keys are set", () => {
  assert.equal(loadConfig({ PAYPAL_CLIENT_ID: FAKE.PAYPAL_CLIENT_ID }).paypalConfigured, false);
});

test("a bad PORT or AI_MODE falls back to the default, with a warning", () => {
  const config = loadConfig({ PORT: "abc", AI_MODE: "banana" });
  assert.equal(config.port, 3000);
  assert.equal(config.aiMode, "mock");
  assert.equal(config.warnings.length, 2);
});

test("real AI mode without a Gemini key warns instead of crashing", () => {
  const config = loadConfig({ AI_MODE: "real" });
  assert.match(config.warnings.join(" "), /GEMINI_API_KEY is missing/);
});

test("PayPal is sandbox only: the default base URL is the sandbox, and any other one stops the server", () => {
  assert.equal(loadConfig({}).paypalBaseUrl, "https://api-m.sandbox.paypal.com");
  assert.equal(loadConfig({ PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com/" }).paypalBaseUrl, "https://api-m.sandbox.paypal.com");
  for (const url of ["https://api-m.paypal.com", "https://api.paypal.com", "http://api-m.sandbox.paypal.com", "https://example.com"]) {
    assert.throws(() => loadConfig({ PAYPAL_BASE_URL: url }), /PAYPAL_BASE_URL must be https:\/\/api-m\.sandbox\.paypal\.com/, url);
  }
});

test("printing the config or turning it into JSON never shows a secret", () => {
  const config = loadConfig(FAKE);
  const printed = `${JSON.stringify(config)}\n${inspect(config, { depth: 5 })}`;
  for (const value of Object.values(FAKE)) assert.ok(!printed.includes(value), "a secret value was printed");
  assert.match(printed, /\[hidden\]/);
});
