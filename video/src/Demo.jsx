// The demo video: title card, scenes 1-10 from PLAN.md Section 13, a caption on every scene, gentle zooms
// on each recorded scene's key moment, a voice slot per scene and the closing logo. No music.
import { AbsoluteFill, Audio, Easing, Freeze, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const C = {
  page: "#F7F5F2", white: "#FFFFFF", charcoal: "#1D1D1F", grey: "#6E6E73", indigo: "#26307A", indigo2: "#33409A",
  pale: "#D4D7F0", blue: "#3A5BC7", amber: "#E0A030", amberTint: "#FCEFD6", green: "#DCF2E3", greenText: "#1E5B35", hairline: "#EFEBE5",
};
const FONT = '"Inter", -apple-system, "Segoe UI", sans-serif';
const W = 1920;
const H = 1080;

export const Demo = ({ timeline }) => {
  const { fps } = useVideoConfig();
  if (!timeline) return <AbsoluteFill style={{ background: C.page }} />;
  let from = Math.round(timeline.titleSeconds * fps);
  const parts = [
    <Sequence key="title" from={0} durationInFrames={from} name="Title card"><TitleCard /></Sequence>,
  ];
  for (const scene of timeline.scenes) {
    const frames = Math.round(scene.seconds * fps);
    parts.push(
      <Sequence key={scene.n} from={from} durationInFrames={frames} name={`Scene ${scene.n}`}>
        <Scene scene={scene} timeline={timeline} />
        {scene.voiceParts.map((part, i) => (
          <Sequence key={`v${i}`} from={Math.round(part.at * fps)} name={`Voice ${scene.n}${scene.voiceParts.length > 1 ? `.${i + 1}` : ""}`}>
            <Audio src={staticFile(part.file)} />
          </Sequence>
        ))}
        {scene.sounds.map((sound, i) => (
          <Sequence key={`s${i}`} from={Math.round(sound.at * fps)} name="Cha-ching">
            <Audio src={staticFile(sound.file)} />
          </Sequence>
        ))}
        {scene.kind !== "logo" && <Caption text={scene.caption} frames={frames} />}
      </Sequence>,
    );
    from += frames;
  }
  return (
    <AbsoluteFill style={{ background: C.page, fontFamily: FONT }}>
      {parts}
      {timeline.draft && <DraftBadge timeline={timeline} />}
    </AbsoluteFill>
  );
};

function Scene({ scene, timeline }) {
  if (scene.kind === "clip") return scene.clip ? <ClipScene scene={scene} /> : <Missing text={`Scene ${scene.n}: no clip yet (npm run record)`} />;
  if (scene.kind === "chats") return <ChatsScene chats={timeline.chats} />;
  if (scene.kind === "phone") return <PhoneScene phone={timeline.phone} leadIn={scene.leadIn} />;
  if (scene.kind === "tech") return <TechScene check={timeline.check} realScore={timeline.realScore} />;
  return <LogoScene caption={scene.caption} />;
}

// ---- captions: big, high-contrast, readable on a phone; they fade in after the cut ----
function Caption({ text, frames }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [4, 14, frames - 8, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lift = interpolate(frame, [4, 14], [16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 44, pointerEvents: "none" }}>
      <div style={{
        opacity, transform: `translateY(${lift}px)`, maxWidth: 1640, padding: "20px 44px", borderRadius: 30,
        background: "rgba(29, 29, 31, 0.88)", color: C.white, fontSize: 58, fontWeight: 600, lineHeight: 1.22,
        textAlign: "center", letterSpacing: "-0.01em", boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
      }}>{text}</div>
    </AbsoluteFill>
  );
}

// ---- recorded scenes: the clip, the PayPal popup window on top (scene 6), and the zooms ----
const easeInOut = Easing.inOut(Easing.cubic);

// Scale and shift for the zoom moments: eases in over 0.8 s, holds, eases out over 0.8 s. The zoom moves
// the key area toward the middle, but never so far that the frame's edge shows.
function zoomTransform(zooms, t) {
  for (const z of zooms) {
    const p = interpolate(t, [z.at - 0.05, z.at + 0.75, z.at + 0.75 + z.hold, z.at + 1.55 + z.hold], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
    if (p <= 0) continue;
    const target = z.scale ?? Math.min(1.45, Math.max(1.12, Math.min((0.78 * W) / z.box.width, (0.7 * H) / z.box.height)));
    const s = 1 + (target - 1) * p;
    const cx = z.box.x + z.box.width / 2;
    const cy = z.box.y + z.box.height / 2;
    const toX = cx + (W / 2 - cx) * 0.7 * p;
    const toY = cy + (H * 0.44 - cy) * 0.7 * p; // a little above the middle: the caption sits at the bottom
    const tx = Math.min(0, Math.max(W - s * W, toX - s * cx));
    const ty = Math.min(0, Math.max(H - s * H, toY - s * cy));
    return `translate(${tx}px, ${ty}px) scale(${s})`;
  }
  return "none";
}

function ClipScene({ scene }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { clip } = scene;
  const clipFrames = Math.max(1, Math.floor(clip.duration * fps) - 1);
  const playFrames = Math.min(clipFrames, durationInFrames);
  const src = staticFile(clip.file);
  return (
    <AbsoluteFill style={{ background: C.page, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: zoomTransform(clip.zooms ?? [], frame / fps), transformOrigin: "0 0" }}>
        <Sequence durationInFrames={playFrames} layout="none">
          <OffthreadVideo src={src} muted style={{ width: W, height: H }} />
        </Sequence>
        {durationInFrames > playFrames && (
          <Sequence from={playFrames} layout="none">
            <Freeze frame={clipFrames - 1}><OffthreadVideo src={src} muted style={{ width: W, height: H }} /></Freeze>
          </Sequence>
        )}
        {(clip.masks ?? []).map((m, i) => ( // Chrome's own "Debugger paused" strip on PayPal's dimmed page (clips.mjs)
          <Sequence key={`m${i}`} from={Math.round(m.from * fps)} durationInFrames={Math.max(1, Math.round(m.to * fps) - Math.round(m.from * fps))} layout="none">
            <div style={{ position: "absolute", left: m.box.x, top: m.box.y, width: m.box.width, height: m.box.height, background: m.color }} />
          </Sequence>
        ))}
        {clip.popup && (
          <Sequence from={Math.round(clip.popup.from * fps)} durationInFrames={Math.max(1, Math.floor(clip.popup.duration * fps) - 1)}>
            <PopupWindow popup={clip.popup} />
          </Sequence>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// PayPal's checkout opens in its own small window; here it floats in the middle, over the dimmed page.
function PopupWindow({ popup }) {
  const frame = useCurrentFrame();
  const scale = (H * 0.86) / popup.size.height;
  const w = popup.size.width * scale;
  const h = popup.size.height * scale;
  const appear = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", paddingBottom: 40 }}>
      <div style={{
        width: w, height: h, borderRadius: 18, overflow: "hidden", background: C.white, opacity: appear,
        transform: `scale(${0.96 + 0.04 * appear})`, boxShadow: "0 30px 90px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.08)",
      }}>
        <OffthreadVideo src={staticFile(popup.file)} muted style={{ width: w, height: h }} />
      </div>
    </AbsoluteFill>
  );
}

// ---- title card and closing logo ----
const Logo = ({ size, color = C.white, ring = C.indigo }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <path d="M7 4h15a5 5 0 0 1 5 5v6.5a5 5 0 0 1-5 5H13.5L8 25.2V20.5H7a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5z" fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
    <circle cx="23.5" cy="22.5" r="7.5" fill={color} stroke={ring} strokeWidth="2" />
    <circle cx="23.5" cy="22.5" r="3.6" fill="none" stroke={ring} strokeWidth="1.6" />
  </svg>
);

const Brand = ({ children }) => (
  <AbsoluteFill style={{ background: `linear-gradient(135deg, ${C.indigo} 0%, ${C.indigo2} 100%)`, justifyContent: "center", alignItems: "center", fontFamily: FONT, overflow: "hidden" }}>
    <div style={{ position: "absolute", right: -260, top: -260, width: 900, height: 900, borderRadius: "50%", background: "rgba(255,255,255,0.06)" }} />
    <div style={{ position: "absolute", left: -200, bottom: -320, width: 700, height: 700, borderRadius: "50%", background: "rgba(255,255,255,0.04)" }} />
    {children}
  </AbsoluteFill>
);

function useFadeUp(delay = 0) {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [delay, delay + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return { opacity: p, transform: `translateY(${(1 - p) * 24}px)` };
}

function TitleCard() {
  const a = useFadeUp(2);
  const b = useFadeUp(12);
  return (
    <Brand>
      <div style={{ display: "flex", alignItems: "center", gap: 40, ...a }}>
        <Logo size={170} />
        <div style={{ color: C.white, fontSize: 150, fontWeight: 700, letterSpacing: "-0.03em" }}>ChatChing</div>
      </div>
      <div style={{ color: C.pale, fontSize: 52, fontWeight: 500, marginTop: 36, ...b }}>Turns a day of chat orders into PayPal invoices.</div>
    </Brand>
  );
}

function LogoScene({ caption }) {
  const a = useFadeUp(0);
  const b = useFadeUp(10);
  return (
    <Brand>
      <div style={a}><Logo size={210} /></div>
      <div style={{ color: C.white, fontSize: 78, fontWeight: 700, marginTop: 48, letterSpacing: "-0.02em", ...b }}>{caption}</div>
    </Brand>
  );
}

// ---- scene 1: the messy chats as plain text (no chat app's look or logo) ----
function ChatsScene({ chats }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const revealEnd = Math.min(durationInFrames * 0.7, 8 * fps);
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.035]);
  return (
    <AbsoluteFill style={{ background: C.page, alignItems: "center", paddingTop: 40 }}>
      <div style={{ transform: `scale(${zoom})`, transformOrigin: "50% 30%", width: 1640, background: C.white, borderRadius: 32, padding: "36px 56px 40px", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ color: C.grey, fontSize: 26, fontWeight: 500, marginBottom: 18 }}>One day of order chats, 28 Oct</div>
        {chats.map((c, i) => {
          const at = 6 + (i * revealEnd) / chats.length;
          const o = interpolate(frame, [at, at + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={i} style={{ opacity: o, transform: `translateY(${(1 - o) * 10}px)`, fontSize: 26, lineHeight: 1.5, color: C.charcoal, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ color: C.grey, fontVariantNumeric: "tabular-nums" }}>[{c.when}]</span>{" "}
              <span style={{ fontWeight: 700 }}>{c.name}:</span> {c.text}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

// ---- scene 8: the buyer's paid order page (a 1.5 s still), then Jasper's phone clip (pickup scan) ----
const PHONE_H = 900;
const phoneFrame = { height: PHONE_H, borderRadius: 36, overflow: "hidden", boxShadow: "0 24px 60px rgba(27,35,64,0.25)", background: "#000" };

// The buyer's side: their order page on a phone, "Paid. Thank you!" and the pickup QR, with a label.
function LeadIn({ leadIn }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = Math.round(leadIn.seconds * fps);
  const label = useFadeUp(2);
  const out = interpolate(frame, [end - 5, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const zoom = interpolate(frame, [0, end], [1, 1.03]);
  return (
    <AbsoluteFill style={{ background: C.page, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 72, paddingBottom: 60, opacity: out }}>
      <div style={{ ...label, width: 560, fontSize: 56, fontWeight: 700, lineHeight: 1.2, color: C.charcoal, letterSpacing: "-0.01em" }}>
        {leadIn.buyer} shows the QR from her order page
      </div>
      <div style={{ ...phoneFrame, transform: `scale(${zoom})`, background: C.white }}>
        <Img src={staticFile(leadIn.file)} style={{ height: PHONE_H }} />
      </div>
      <div style={{ width: 560 }} />
    </AbsoluteFill>
  );
}

function PhoneScene({ phone, leadIn }) {
  const { fps } = useVideoConfig();
  if (!phone) {
    return (
      <AbsoluteFill style={{ background: C.page, justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: 1100, padding: "64px 72px", borderRadius: 32, border: `4px dashed ${C.grey}`, textAlign: "center", color: C.charcoal }}>
          <div style={{ fontSize: 60, fontWeight: 700 }}>Phone clip goes here</div>
          <div style={{ fontSize: 36, marginTop: 24, color: C.grey, lineHeight: 1.4 }}>Pickup scan: the phone scans the buyer's invoice QR, sees Paid, taps Collected.</div>
          <div style={{ fontSize: 30, marginTop: 28, color: C.grey }}>video/public/phone/pickup.mp4</div>
        </div>
      </AbsoluteFill>
    );
  }
  const lead = leadIn ? Math.round(leadIn.seconds * fps) : 0;
  return (
    <AbsoluteFill style={{ background: C.page }}>
      {leadIn && <Sequence durationInFrames={lead} name="Lead-in: buyer's QR"><LeadIn leadIn={leadIn} /></Sequence>}
      <Sequence from={lead} name="Phone clip"><PhoneClip phone={phone} /></Sequence>
    </AbsoluteFill>
  );
}

// The seller's side: Jasper's phone, Pickup scan. It plays once, then holds its last frame.
function PhoneClip({ phone }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  const playFrames = Math.max(1, Math.floor(phone.duration * fps) - 1);
  const video = (props) => <OffthreadVideo src={staticFile(phone.file)} muted style={{ height: PHONE_H }} {...props} />;
  return (
    <AbsoluteFill style={{ background: C.page, justifyContent: "center", alignItems: "center", paddingBottom: 60, opacity: fadeIn }}>
      <div style={phoneFrame}>
        <Sequence durationInFrames={playFrames} layout="none">{video()}</Sequence>
        <Sequence from={playFrames} layout="none"><Freeze frame={playFrames - 1}>{video()}</Freeze></Sequence>
      </div>
    </AbsoluteFill>
  );
}

// ---- scene 9: what it is built with, and the proof (npm run check + the real-orders score) ----
function TechScene({ check, realScore }) {
  const a = useFadeUp(4);
  const b = useFadeUp(14);
  const c = useFadeUp(24);
  const pill = { background: C.white, borderRadius: 999, padding: "22px 40px", fontSize: 46, fontWeight: 600, color: C.charcoal, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" };
  return (
    <AbsoluteFill style={{ background: C.page, flexDirection: "row", padding: "90px 100px 200px", gap: 64 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ fontSize: 34, color: C.grey, fontWeight: 600, ...a }}>Built with</div>
        <div style={{ ...pill, ...a }}>PayPal Invoicing API</div>
        <div style={{ ...pill, ...b }}>Google Gemini</div>
        <div style={{ ...pill, ...c }}>AG Grid</div>
        <div style={{ display: "flex", gap: 24, marginTop: 20, ...c }}>
          <Stat big={`${check.tests}`} small="automated tests pass" />
          <Stat big={`${realScore.right} of ${realScore.of}`} small="checks right on real cafe orders" />
        </div>
      </div>
      <div style={{ width: 900, background: C.charcoal, borderRadius: 28, padding: "36px 40px", color: "#F2F2F2", fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 22, lineHeight: 1.6, alignSelf: "flex-start", boxShadow: "0 20px 50px rgba(0,0,0,0.2)", ...b }}>
        <div style={{ color: "#9A9AA0" }}>$ npm run check</div>
        {check.lines.map((line, i) => (
          <div key={i} style={{ paddingLeft: "5ch", textIndent: "-5ch" }}>
            <span style={{ color: line.startsWith("PASS") ? "#7FD49A" : C.amber, fontWeight: 700 }}>{line.slice(0, 4)}</span>{line.slice(4)}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

const Stat = ({ big, small }) => (
  <div style={{ flex: 1, background: C.white, borderRadius: 24, padding: "26px 30px", boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
    <div style={{ fontSize: 64, fontWeight: 700, color: C.charcoal, fontVariantNumeric: "tabular-nums" }}>{big}</div>
    <div style={{ fontSize: 28, color: C.grey, marginTop: 6 }}>{small}</div>
  </div>
);

const Missing = ({ text }) => (
  <AbsoluteFill style={{ background: C.amberTint, justifyContent: "center", alignItems: "center", fontSize: 48, color: C.charcoal }}>{text}</AbsoluteFill>
);

function DraftBadge({ timeline }) {
  const voices = 10 - timeline.missing.voice.length;
  return (
    <div style={{ position: "absolute", top: 18, right: 18, padding: "8px 16px", borderRadius: 12, background: "rgba(224,160,48,0.92)", color: C.charcoal, fontSize: 22, fontWeight: 700, fontFamily: FONT }}>
      DRAFT · voice {voices}/10{timeline.phone ? "" : " · phone clip missing"}
    </div>
  );
}
