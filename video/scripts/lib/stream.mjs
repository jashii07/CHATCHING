// Frame capture through Chrome's own screencast (CDP Page.startScreencast): sharp JPEG frames of the page
// only, with no browser bars. Playwright's built-in video is a 1 Mbit/s VP8 file, too soft for small text.
// Chrome sends a frame only when the picture changes; each frame is saved with the time it arrived, and
// clips.mjs later turns those frames into a constant 30 fps video.
// A Stream can follow different tabs (attach() moves it), so "a new tab opened" is just the next frame.
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Stream {
  constructor(name, dir, clock, { width, height }) {
    this.name = name;
    this.dir = join(dir, name);
    this.clock = clock;
    this.size = { width, height };
    this.frames = []; // { t, file }
    this.pending = new Set();
    this.page = null;
    this.sessions = new Map(); // page -> CDP session
    this.seq = 0;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  async attach(page) {
    if (this.page === page) return;
    await this.detach();
    this.page = page;
    let cdp = this.sessions.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      this.sessions.set(page, cdp);
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        if (this.page !== page) return;
        const t = this.clock();
        const file = join(this.dir, `${String(++this.seq).padStart(6, "0")}.jpg`);
        this.frames.push({ t, file });
        const write = writeFile(file, Buffer.from(data, "base64")).finally(() => this.pending.delete(write));
        this.pending.add(write);
      });
    }
    const { width, height } = page.viewportSize() ?? this.size;
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  }

  async detach() {
    const cdp = this.page && this.sessions.get(this.page);
    this.page = null;
    if (cdp) await cdp.send("Page.stopScreencast").catch(() => {});
  }

  async close() {
    await this.detach();
    await Promise.all(this.pending);
    for (const cdp of this.sessions.values()) await cdp.detach().catch(() => {});
  }

  toJSON() {
    return { name: this.name, size: this.size, frames: this.frames };
  }
}
