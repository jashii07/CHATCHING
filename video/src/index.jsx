import { continueRender, delayRender, registerRoot, staticFile } from "remotion";
import { Root } from "./Root.jsx";

// Inter, the app's own font (SIL Open Font License), copied in by scripts/timeline.mjs.
const fontHandle = delayRender("Loading Inter");
const inter = new FontFace("Inter", `url(${staticFile("generated/inter.woff2")}) format("woff2")`, { weight: "100 900" });
inter.load()
  .then(() => document.fonts.add(inter))
  .catch((err) => console.warn("Inter did not load, using the system font", err))
  .finally(() => continueRender(fontHandle));

registerRoot(Root);
