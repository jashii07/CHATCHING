// What is inside PayPal's pickup QR code? (Step 7, for Step 10c's pickup scan.)
// Decodes a QR image (PNG) and prints the text it holds, plus the invoice id found in it.
//   node scripts/decode-qr.mjs tmp/qr-INV2-XXXX.png [more.png ...]
// No network, no keys. Node has no PNG decoder built in, so the image is drawn on a canvas in the
// installed Chrome (playwright-core) and read there by jsQR 1.4.0 (dev dependency, Apache-2.0).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { invoiceIdIn } from "../src/qr.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.log("Usage: node scripts/decode-qr.mjs <qr.png> [more.png ...]");
  process.exitCode = 1;
} else {
  const jsQR = readFileSync(createRequire(import.meta.url).resolve("jsqr/dist/jsQR.js"), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    await page.setContent("<canvas></canvas>");
    await page.addScriptTag({ content: jsQR });
    for (const file of files) {
      const png = readFileSync(file).toString("base64");
      const result = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.querySelector("canvas");
        Object.assign(canvas, { width: img.width, height: img.height });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const code = window.jsQR(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
        return { size: `${img.width} x ${img.height}`, text: code?.data ?? null, version: code?.version ?? null };
      }, png);
      console.log(`\n${file} (${result.size} px)`);
      if (result.text == null) {
        console.log("  no QR code found");
        failed++;
        continue;
      }
      console.log(`  QR version ${result.version}, ${result.text.length} characters`);
      console.log(`  text: ${result.text}`);
      console.log(`  invoice id in it: ${invoiceIdIn(result.text) ?? "(none found)"}`);
    }
  } finally {
    await browser.close();
  }
  process.exitCode = failed ? 1 : 0;
}
