// The demo video: title card, scenes 1-10 from PLAN.md Section 13, a caption on every scene, gentle zooms
// on each recorded scene's key moment, a voice slot per scene and the closing logo. No music.
import { useMemo } from "react";
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
  // The title card's cha-ching (timeline.mjs TITLE_CHIME_AT): the logo fades in from that moment.
  const chime = timeline.titleSounds?.[0];
  const parts = [
    <Sequence key="title" from={0} durationInFrames={from} name="Title card">
      <TitleCard appear={Math.round((chime?.at ?? 0.07) * fps)} />
      {(timeline.titleSounds ?? []).map((sound, i) => (
        <Sequence key={`t${i}`} from={Math.round(sound.at * fps)} name="Cha-ching (title)"><Audio src={staticFile(sound.file)} /></Sequence>
      ))}
    </Sequence>,
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
  if (scene.kind === "chats") return <ChatsScene chats={timeline.chats} hook={scene.hook} />;
  if (scene.kind === "phone") return <PhoneScene phone={timeline.phone} leadIn={scene.leadIn} />;
  if (scene.kind === "tech") return <TechScene check={timeline.check} realScore={timeline.realScore} reveals={scene.reveals} />;
  return <LogoScene caption={scene.caption} />;
}

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };

// ---- captions: big, high-contrast, readable on a phone; they fade in after the cut ----
// The same dark pill carries scene 1's questions (bigger), so they read as one style.
const PILL = {
  padding: "20px 44px", borderRadius: 30, background: "rgba(29, 29, 31, 0.88)", color: C.white, fontWeight: 600,
  lineHeight: 1.22, textAlign: "center", letterSpacing: "-0.01em", boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
};

function Caption({ text, frames }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [4, 14, frames - 8, frames], [0, 1, 1, 0], clamp);
  const lift = interpolate(frame, [4, 14], [16, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 44, pointerEvents: "none" }}>
      <div style={{ ...PILL, opacity, transform: `translateY(${lift}px)`, maxWidth: 1640, fontSize: 58 }}>{text}</div>
    </AbsoluteFill>
  );
}

// ---- recorded scenes: the clip (as shots), the PayPal popup window on top (scene 6), zooms and highlights ----
const easeInOut = Easing.inOut(Easing.cubic);

// Scale and shift for the zoom moments: eases in over 0.8 s, holds, eases out over 0.8 s (or ends at `until`, a
// cut). The zoom moves the key area toward the middle, but never so far that the frame's edge shows.
function zoomTransform(zooms, t) {
  for (const z of zooms) {
    if (z.until != null && t >= z.until) continue;
    const p = interpolate(t, [z.at - 0.05, z.at + 0.75, z.at + 0.75 + z.hold, z.at + 1.55 + z.hold], [0, 1, 1, 0], { ...clamp, easing: easeInOut });
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

// Which clip frame the scene shows at scene time t: the shot that has started plays from `from` at its speed, and
// holds on `to` once it gets there (timeline.mjs EDITS; an unedited scene is one shot, the clip straight through).
function clipFrameAt(shots, t, fps) {
  let shot = shots[0];
  for (const s of shots) if (t >= s.at - 1e-6) shot = s;
  const clipTime = Math.min(shot.to, shot.from + Math.max(0, t - shot.at) * shot.speed);
  return Math.round(clipTime * fps);
}

// A soft ring around the row or card the voice names (scene 3): fades in over 0.2 s, ends at the next cut.
function Highlight({ box, from, to, radius = 16, t }) {
  if (t < from - 0.01 || (to != null && t >= to)) return null;
  const o = interpolate(t, [from, from + 0.2], [0, 1], clamp);
  const pad = 7;
  return (
    <div style={{
      position: "absolute", left: box.x - pad, top: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad,
      borderRadius: radius, border: `4px solid ${C.blue}`, background: "rgba(58, 91, 199, 0.05)",
      boxShadow: "0 0 0 7px rgba(58, 91, 199, 0.16)", opacity: o, boxSizing: "border-box",
    }} />
  );
}

function ClipScene({ scene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { clip } = scene;
  const t = frame / fps;
  const src = staticFile(clip.file);
  return (
    <AbsoluteFill style={{ background: C.page, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: zoomTransform(scene.zooms ?? [], t), transformOrigin: "0 0" }}>
        <Freeze frame={clipFrameAt(scene.shots, t, fps)}><OffthreadVideo src={src} muted style={{ width: W, height: H }} /></Freeze>
        {(scene.highlights ?? []).map((h, i) => <Highlight key={`h${i}`} {...h} t={t} />)}
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

// The logo appears on the cha-ching (`appear`, in frames: when the title's chime starts).
function TitleCard({ appear = 2 }) {
  const a = useFadeUp(appear);
  const b = useFadeUp(appear + 10);
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

// ---- scene 1: the messy chats as plain text (no chat app's look or logo), scrolling fast, then slowly ----
// The 10 Nov hook: the day's chats scroll by quickly while the three questions appear, each as it is said, in the
// captions' dark pill; on "My friend sorts this out by hand..." (hook.slowAt) the questions go and the scroll slows
// down to the evening's last messages.
const CHAT_VIEW = 720; // px of the chat list in view, above the caption
const SLOW = 0.14; // the slow scroll's speed, as a share of the fast one
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

// How far down the list (0 = the first message at the top, 1 = the last one at the bottom) at each frame.
function scrollPositions(frames, fps, slowAt) {
  const speed = (s) => smooth(0.1, 0.7, s) * (SLOW + (1 - SLOW) * (1 - smooth(slowAt - 0.3, slowAt + 0.5, s)));
  const sums = [0];
  for (let f = 1; f < frames; f++) sums.push(sums[f - 1] + speed(f / fps));
  const total = sums[frames - 1] || 1;
  return sums.map((s) => s / total);
}

function ChatsScene({ chats, hook }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const slowAt = hook?.slowAt ?? (durationInFrames / fps) * 0.62;
  const positions = useMemo(() => scrollPositions(durationInFrames, fps, slowAt), [durationInFrames, fps, slowAt]);
  const p = positions[Math.min(frame, positions.length - 1)];
  const fadeEdges = "linear-gradient(to bottom, transparent 0, black 56px, black calc(100% - 56px), transparent 100%)";
  return (
    <AbsoluteFill style={{ background: C.page }}>
      <div style={{ position: "absolute", left: 140, top: 36, width: 1640, background: C.white, borderRadius: 32, padding: "30px 56px 0", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ color: C.grey, fontSize: 28, fontWeight: 500, marginBottom: 6 }}>One day of order chats, 28 Oct</div>
        <div style={{ height: CHAT_VIEW, overflow: "hidden", WebkitMaskImage: fadeEdges, maskImage: fadeEdges }}>
          <div style={{ transform: `translateY(calc(${-p * 100}% + ${p * CHAT_VIEW}px))`, paddingTop: 40, paddingBottom: 56 }}>
            {chats.map((c, i) => (
              <div key={i} style={{ fontSize: 46, lineHeight: 1.38, color: C.charcoal, marginBottom: 18 }}>
                <span style={{ color: C.grey, fontVariantNumeric: "tabular-nums" }}>[{c.when}]</span>{" "}
                <span style={{ fontWeight: 700 }}>{c.name}:</span> {c.text}
              </div>
            ))}
          </div>
        </div>
      </div>
      {hook && (
        <AbsoluteFill style={{ flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 30, paddingBottom: 190 }}>
          {hook.questions.map((q) => {
            const o = Math.min(interpolate(t, [q.at - 0.07, q.at + 0.13], [0, 1], clamp), interpolate(t, [slowAt - 0.1, slowAt + 0.25], [1, 0], clamp));
            const lift = interpolate(t, [q.at - 0.07, q.at + 0.2], [16, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
            return <div key={q.text} style={{ ...PILL, fontSize: 76, opacity: o, transform: `translateY(${lift}px)` }}>{q.text}</div>;
          })}
        </AbsoluteFill>
      )}
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
// Each name and number appears as the voice says it (`reveals`, seconds into the scene, timeline.mjs TECH), two
// frames early so it is already visible on the word; the friend's words appear as they are quoted. Without
// `reveals` (a re-recorded line), everything appears in the first second, as before.
const BEFORE_WORD = 0.07;
function TechScene({ check, realScore, reveals }) {
  const { fps } = useVideoConfig();
  const at = (key, fallback) => Math.round(((reveals?.[key] ?? fallback) - (reveals ? BEFORE_WORD : 0)) * fps);
  const hood = useFadeUp(at("hood", 4 / 30));
  const paypal = useFadeUp(at("paypal", 4 / 30));
  const gemini = useFadeUp(at("gemini", 14 / 30));
  const aggrid = useFadeUp(at("aggrid", 24 / 30));
  const tests = useFadeUp(at("tests", 24 / 30));
  const real = useFadeUp(at("real", 24 / 30));
  const terminal = useFadeUp(at("hood", 14 / 30));
  const quote = useFadeUp(at("quote", 0));
  const pill = { background: C.white, borderRadius: 999, padding: "22px 40px", fontSize: 46, fontWeight: 600, color: C.charcoal, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" };
  return (
    <AbsoluteFill style={{ background: C.page, flexDirection: "row", padding: "90px 100px 200px", gap: 64 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ fontSize: 34, color: C.grey, fontWeight: 600, ...hood }}>Built with</div>
        <div style={{ ...pill, ...paypal }}>PayPal Invoicing API</div>
        <div style={{ ...pill, ...gemini }}>Google Gemini</div>
        <div style={{ ...pill, ...aggrid }}>AG Grid</div>
        <div style={{ display: "flex", gap: 24, marginTop: 20 }}>
          <Stat big={`${check.tests}`} small="automated tests pass" style={tests} />
          <Stat big={`${realScore.right} of ${realScore.of}`} small="checks right on real cafe orders" style={real} />
        </div>
      </div>
      <div style={{ width: 900, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ background: C.charcoal, borderRadius: 28, padding: "36px 40px", color: "#F2F2F2", fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 22, lineHeight: 1.6, boxShadow: "0 20px 50px rgba(0,0,0,0.2)", ...terminal }}>
          <div style={{ color: "#9A9AA0" }}>$ npm run check</div>
          {check.lines.map((line, i) => (
            <div key={i} style={{ paddingLeft: "5ch", textIndent: "-5ch" }}>
              <span style={{ color: line.startsWith("PASS") ? "#7FD49A" : C.amber, fontWeight: 700 }}>{line.slice(0, 4)}</span>{line.slice(4)}
            </div>
          ))}
        </div>
        {reveals?.quote != null && (
          <div style={{ background: C.white, borderRadius: 24, padding: "28px 36px", boxShadow: "0 4px 24px rgba(0,0,0,0.05)", ...quote }}>
            <div style={{ fontSize: 50, fontWeight: 700, color: C.charcoal, letterSpacing: "-0.01em" }}>“More convenient than Excel.”</div>
            <div style={{ fontSize: 28, color: C.grey, marginTop: 8 }}>A friend who tested ChatChing</div>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

const Stat = ({ big, small, style }) => (
  <div style={{ flex: 1, background: C.white, borderRadius: 24, padding: "26px 30px", boxShadow: "0 4px 24px rgba(0,0,0,0.05)", ...style }}>
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
