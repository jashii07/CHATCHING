// Chromium's fake camera plays a video file instead of a real camera. This turns a QR image into that file,
// so a browser check can "scan" a real PayPal QR. Used by ui-pickup and ui-live.
// The format is Y4M (plain uncompressed frames), the one Chrome's --use-file-for-fake-video-capture reads.
// Node has no PNG decoder, so the image is drawn on a canvas in the browser and read back.
import { writeFileSync } from "node:fs";

const WIDTH = 640;
const HEIGHT = 480;

// The flags that give a browser the fake camera, with permission already granted.
export const cameraArgs = (file) => ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${file}`];

// What a phone would read from a QR picture on screen: the <img> drawn on a canvas, read by the page's own jsQR.
export async function readQrOnScreen(page, selector) {
  await page.addScriptTag({ url: "/vendor/jsQR.js" });
  return page.$eval(selector, async (img) => {
    await img.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
  });
}

// A white "desk" with the QR in the middle, at its own size, like a phone held up to a camera.
export async function writeCameraFile(browser, pngBase64, file) {
  const page = await browser.newPage();
  try {
    const grey = await page.evaluate(async ({ png, width, height }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, (width - img.width) / 2, (height - img.height) / 2);
      const { data } = ctx.getImageData(0, 0, width, height);
      return Array.from({ length: width * height }, (_, i) => data[i * 4]);
    }, { png: pngBase64, width: WIDTH, height: HEIGHT });
    const frame = Buffer.concat([
      Buffer.from("FRAME\n"),
      Buffer.from(grey), // brightness of every pixel
      Buffer.alloc((WIDTH * HEIGHT) / 2, 128), // no colour
    ]);
    writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  } finally {
    await page.close();
  }
}
