import { Composition, staticFile } from "remotion";
import { Demo } from "./Demo.jsx";

// The length and every scene come from public/generated/timeline.json (scripts/timeline.mjs).
export const Root = () => (
  <Composition
    id="ChatChingDemo"
    component={Demo}
    fps={30}
    width={1920}
    height={1080}
    durationInFrames={30 * 60}
    defaultProps={{ timeline: null }}
    calculateMetadata={async () => {
      const res = await fetch(staticFile("generated/timeline.json"));
      if (!res.ok) throw new Error("No timeline yet: run node scripts/timeline.mjs (npm run draft does it for you).");
      const timeline = await res.json();
      return { durationInFrames: Math.round(timeline.totalSeconds * timeline.fps), fps: timeline.fps, props: { timeline } };
    }}
  />
);
