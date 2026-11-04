// Slow, human-like actions for the recording, plus a visible cursor (a headless browser draws none).
// The cursor is a small arrow with a soft yellow halo, drawn into the page by an init script and moved
// by the recorder itself (not by mouse events, which stop at iframe edges). Styles are set through the
// DOM style API, so the app's Content-Security-Policy is left untouched.
//
// On PayPal's pages the same init script blurs the login fields and any text that looks like an email
// address, so the judge login never shows in the video.

export const INIT_SCRIPT = `(() => {
  const onPayPal = /(^|\\.)paypal\\.com$/.test(location.hostname);
  const ready = (fn) => (document.body ? fn() : addEventListener("DOMContentLoaded", fn, { once: true }));

  if (window.top === window) {
    let el = null;
    let pos = null;
    const make = () => {
      if (el && el.isConnected) return el;
      el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, { position: "fixed", left: "0", top: "0", width: "0", height: "0", zIndex: "2147483647", pointerEvents: "none", display: "none" });
      const halo = document.createElement("div");
      Object.assign(halo.style, { position: "absolute", left: "-23px", top: "-23px", width: "46px", height: "46px", borderRadius: "50%", background: "rgba(255, 204, 0, 0.32)", boxShadow: "0 0 0 2px rgba(240, 180, 0, 0.55)" });
      const ring = document.createElement("div");
      ring.dataset.ring = "1";
      Object.assign(ring.style, { position: "absolute", left: "-23px", top: "-23px", width: "46px", height: "46px", borderRadius: "50%", border: "3px solid rgba(240, 170, 0, 0.9)", opacity: "0" });
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("width", "26");
      arrow.setAttribute("height", "30");
      arrow.setAttribute("viewBox", "0 0 26 30");
      Object.assign(arrow.style, { position: "absolute", left: "-3px", top: "-2px", overflow: "visible", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))" });
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M3 2 L3 24 L9 18.5 L13 27 L17 25.2 L13 17 L21 17 Z");
      path.setAttribute("fill", "#1D1D1F");
      path.setAttribute("stroke", "#FFFFFF");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linejoin", "round");
      arrow.append(path);
      el.append(halo, ring, arrow);
      (document.body || document.documentElement).append(el);
      return el;
    };
    window.__cursor = (x, y) => {
      pos = [x, y];
      const c = make();
      c.style.display = "block";
      c.style.transform = "translate(" + x + "px, " + y + "px)";
    };
    window.__cursorHide = () => { if (el) el.style.display = "none"; };
    window.__click = () => {
      const ring = make().querySelector("[data-ring]");
      ring.animate([{ opacity: 0.95, transform: "scale(0.6)" }, { opacity: 0, transform: "scale(1.7)" }], { duration: 520, easing: "ease-out" });
    };
    ready(() => { if (pos) window.__cursor(pos[0], pos[1]); });
  }

  if (onPayPal) {
    // A stylesheet rule (with !important) that the page's own re-renders can't wipe, plus inline styles
    // re-applied on every change, including attribute changes (React rewrites the style attribute).
    const FIELDS = 'input[type=email], input[type=password], input[name*=email i], input[name*=password i], #email, #password';
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FIELDS + ", [data-blurred-login] { filter: blur(9px) !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {}
    const EMAIL = /[^\\s@]+@[^\\s@]+\\.[a-z]{2,}/i;
    const blur = (node) => {
      if (!node || !node.style) return;
      if (!node.hasAttribute("data-blurred-login")) node.setAttribute("data-blurred-login", "");
      if (node.style.getPropertyValue("filter") !== "blur(9px)") node.style.setProperty("filter", "blur(9px)", "important");
    };
    const scan = () => {
      for (const input of document.querySelectorAll(FIELDS)) blur(input);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (EMAIL.test(n.nodeValue)) blur(n.parentElement);
    };
    // For the recorder's guard: is every login field and every email address on screen blurred right now?
    // (Checked before scan() repairs anything, so a gap is reported, not hidden.)
    const blurredUp = (el) => { for (let p = el; p && p.nodeType === 1; p = p.parentElement) if (getComputedStyle(p).filter.includes("blur")) return true; return false; };
    window.__loginBlurred = () => {
      let ok = [...document.querySelectorAll(FIELDS)].every((el) => !el.value || blurredUp(el));
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && ok; n = walker.nextNode()) if (EMAIL.test(n.nodeValue) && n.parentElement && n.parentElement.offsetParent !== null) ok = blurredUp(n.parentElement);
      scan();
      return ok;
    };
    ready(() => { scan(); new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "value"] }); });
  }
})();`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function makeHuman(page, start = { x: 1100, y: 620 }) {
  let pos = { ...start };
  const human = {
    page,
    get pos() { return pos; },
    sleep,
    async show() { await page.evaluate(([x, y]) => window.__cursor?.(x, y), [pos.x, pos.y]).catch(() => {}); },
    async hide() { await page.evaluate(() => window.__cursorHide?.()).catch(() => {}); },

    // A gently curved, eased path at about 60 steps a second.
    async moveTo(x, y, ms) {
      const dist = Math.hypot(x - pos.x, y - pos.y);
      ms ??= Math.min(1100, Math.max(450, 300 + dist * 0.55));
      // Time-based (not a fixed number of steps), so a busy machine doesn't make the moves slower.
      const from = { ...pos };
      const bend = Math.min(60, dist * 0.08) * (from.x < x ? 1 : -1);
      const started = performance.now();
      for (let done = false; !done;) {
        const p = Math.min(1, (performance.now() - started) / ms);
        done = p >= 1;
        const k = ease(p);
        const arc = Math.sin(Math.PI * k) * bend;
        const px = from.x + (x - from.x) * k + arc * ((y - from.y) / (dist || 1));
        const py = from.y + (y - from.y) * k - arc * ((x - from.x) / (dist || 1));
        await page.mouse.move(px, py);
        await page.evaluate(([cx, cy]) => window.__cursor?.(cx, cy), [px, py]).catch(() => {});
        await sleep(12);
      }
      pos = { x, y };
    },

    // Moves to an element (scrolling it into view first if needed) and clicks it.
    async click(target, { pause = 160, after = 450, offset, reveal = true } = {}) {
      const box = await human.boxOf(target, reveal);
      const x = box.x + (offset?.x ?? box.width / 2);
      const y = box.y + (offset?.y ?? box.height / 2);
      await human.moveTo(x, y);
      await sleep(pause);
      await page.evaluate(() => window.__click?.()).catch(() => {});
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(after);
    },

    async hover(target, pause = 900) {
      const box = await human.boxOf(target, true);
      await human.moveTo(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2);
      await sleep(pause);
    },

    async type(text, delay = 75) {
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep(delay * (0.6 + Math.random() * 0.8));
      }
    },

    // The element's box in viewport pixels (= video pixels: the device scale factor is 1).
    async boxOf(target, reveal = false) {
      const locator = typeof target === "string" ? page.locator(target).first() : target;
      await locator.waitFor({ state: "visible", timeout: 90_000 });
      if (reveal) await human.reveal(locator);
      const box = await locator.boundingBox();
      if (!box) throw new Error(`No box for ${target}`);
      return box;
    },

    // Smoothly scrolls the nearest scroll container (or the page) so the element sits in view.
    async reveal(target, { block = "nearest", ms = 900 } = {}) {
      const locator = typeof target === "string" ? page.locator(target).first() : target;
      const handle = await locator.elementHandle();
      if (!handle) return;
      await handle.evaluate(async (el, { block, ms }) => {
        const scrollerOf = (node) => {
          for (let p = node.parentElement; p; p = p.parentElement) {
            const style = getComputedStyle(p);
            if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
          }
          return null;
        };
        const box = el.getBoundingClientRect();
        const scroller = scrollerOf(el);
        const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight, height: innerHeight };
        const topPad = scroller ? 24 : 96; // the app's sticky top bar is 64 px tall
        const bottomPad = 200; // leaves room for the video's caption
        let delta = 0;
        if (block === "center") delta = box.top + box.height / 2 - (view.top + view.height / 2);
        else if (block === "start") delta = box.top - view.top - topPad;
        else if (box.top < view.top + topPad) delta = box.top - view.top - topPad;
        else if (box.bottom > view.bottom - bottomPad) delta = Math.min(box.bottom - (view.bottom - bottomPad), box.top - view.top - topPad);
        if (Math.abs(delta) < 4) return;
        const get = () => (scroller ? scroller.scrollTop : scrollY);
        const set = (v) => (scroller ? (scroller.scrollTop = v) : scrollTo({ top: v, behavior: "instant" }));
        const from = get();
        const t0 = performance.now();
        await new Promise((resolve) => {
          const step = (now) => {
            const p = Math.min(1, (now - t0) / ms);
            const k = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
            set(from + delta * k);
            if (p < 1) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
      }, { block, ms });
      await sleep(150);
    },

    async scrollPageTo(y, ms = 1000) {
      await page.evaluate(async ({ y, ms }) => {
        const from = scrollY;
        const t0 = performance.now();
        await new Promise((resolve) => {
          const step = (now) => {
            const p = Math.min(1, (now - t0) / ms);
            const k = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
            scrollTo({ top: from + (y - from) * k, behavior: "instant" });
            if (p < 1) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
      }, { y, ms });
      await sleep(150);
    },
  };
  return human;
}
