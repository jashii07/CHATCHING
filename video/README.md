# ChatChing demo video

This folder makes the 3-minute demo video. It is separate from the app: it has its own `package.json`, so Render never installs it, and everything it makes (clips, renders, your recordings) is git-ignored. Only the source is in git.

How it works, in two halves:

1. **Recording** (`npm run record`): a Playwright script drives the **live site** at 1920 × 1080 and follows the storyboard (PLAN.md Section 13), with a visible cursor and short pauses. It saves one clip per scene in `public/clips/`. It sends 7 real sandbox invoices and pays Lina's with the judge 1 login from the main README. That login is blurred on PayPal's pages, and a guard cuts any moment where it isn't. It makes **no Gemini call**: only the demo chats can reach the app's AI route (the server answers them from its saved reply), and the run fails if "AI calls left" changes.
2. **Editing** (`npm run draft` / `npm run final`): Remotion builds the video. It adds the title card, the chats scene, the recorded scenes with gentle zooms on each key moment, your phone clip, the tech scene and the closing logo. Every scene has its caption, read straight from PLAN.md Section 13, plus your voice line. There is no music.

## Setup (once)

```
cd video
npm install
```

It uses the Google Chrome that is already installed. The first render downloads Remotion's own small Chrome (about 120 MB).

## 1. Record your voice lines

Use the **Sound Recorder** app that comes with Windows 11 (Start menu, type "Sound Recorder").

1. In Sound Recorder, pick your microphone (the small menu at the bottom left). A headset mic sounds better than the laptop's own.
2. Find a quiet room and keep the mic about a hand's width from your mouth.
3. Record **one file per scene**, reading the words in PLAN.md Section 14. Leave about half a second of silence before you start talking. If you stumble, record that scene again; only the last good take matters.
4. Put them in **`video\public\voice\`** as they are. A phone's names work: `scene 1.m4a` … `scene 10.m4a` (`scene1.m4a` too). A scene recorded in two parts is `scene 3.m4a` (part 1) plus a file starting with `scene 3 second part` (part 2).
5. Run **`npm run voice`**. It never changes your files. It makes the copies the video uses, in `public\voice-ready\scene1.wav` … `scene10.wav`:
   - silence at the start and end trimmed (anything quieter than -45 dB), keeping 0.2 s on each side; the tap of the phone's record and stop button is left out too
   - a two-part scene joined: part 1, a 0.3 s pause, part 2
   - every line made equally loud: -16 LUFS, the usual speech level for online video, with peaks held under -1.5 dBTP so nothing clips (ffmpeg's loudnorm, in up to 3 rounds until each line is within 0.5 LU)
   - then a report, also saved as `public\voice-ready\report.md`: each line's length against its scene's time in PLAN.md Section 13, the loudness before and after, and anything wrong it can spot (a missing or silent file, clipping, a very quiet recording, a pause over 1.2 s, or a speed in words a second that doesn't fit the line in PLAN.md Section 14)

Run `npm run voice` again after re-recording any line. Your recordings and the processed copies are git-ignored.

**How long each line can be.** A scene grows to fit its voice line (the line starts 0.25 s in, and 0.8 s of quiet follows it), so nothing is cut off. But the whole video must stay under 2:55, and the render stops if it won't. As a guide, keep each line about 1 second shorter than its time in PLAN.md Section 13. Scenes 3 and 6 have the most room: their screen recordings are about 29 s and 32 s long.

Check the timing any time: `node scripts/timeline.mjs` prints every scene's length and the total (with the last recording's clips), and `npm run draft` does the same before it renders.

## 2. Add your phone clip (scene 8, pickup scan)

1. On your phone, open https://chatching.onrender.com/ through **Open on my phone** (or Load demo, Read orders, Send invoices on the phone itself).
2. Turn on Do Not Disturb, so no messages pop up while you film.
3. Film the phone's screen: **Pickup scan** → scan a buyer's invoice QR → the result shows Paid → tap **Collected**. Hold the phone upright. Aim for 15 to 20 seconds.
4. Copy the video to the laptop (USB cable, Google Drive or email to yourself) and save it as **`video\public\phone\pickup.mp4`**. A `.mov` from an iPhone also works (`pickup.mov`): the render turns it into a normal MP4 by itself and drops the phone's sound.

Until the clip is there, the draft shows a "Phone clip goes here" card in its place.

## 3. Render the final video (Mon 9 Nov, after the design polish)

First deploy the polished app as usual (CLAUDE.md Deploy steps), so Render shows the new version. Then run the **one command**:

```
cd video
npm run final
```

It does three things in a row:

1. It checks that all ten processed voice lines (`npm run voice`) and the phone clip are there. If any are missing, it stops before recording anything.
2. It **records the live site again** (about 4 minutes), so the video shows the new design. If Render isn't on the new version yet, it stops.
3. It renders **`video\out\chatching-final.mp4`** and prints its length.

Then open the video and watch it once all the way through, with the sound on.

Options:
- `npm run final -- --no-record` reuses the last recording, for when you only changed a voice line.
- `npm run final -- --judge=2` pays with the README's second judge login.

**The PayPal pages' language.** Judge 1's sandbox account is set to Malay, so PayPal's checkout page shows Malay text (the PayPal login and "Payment successful" pages are in English). PLAN.md has "test paying with an English-language sandbox buyer account" for Mon 9. Change judge 1's language in that sandbox account's settings, or use `--judge=2` if judge 2 is in English.

## Other commands

| Command | What it does |
|---|---|
| `npm run voice` | Trims and evens out your voice lines into `public/voice-ready/`, and reports their lengths and problems |
| `npm run record` | Records the live site again; the clips go to `public/clips/` |
| `npm run clips` | Re-cuts the clips from the last recording (no new recording) |
| `npm run draft` | Renders `out/chatching-draft.mp4` with a DRAFT badge; missing voice lines and the phone clip become silent placeholders |
| `npm run frames` | Saves still frames of the draft to `out/frames/` for checking by eye |
| `npm run studio` | Opens Remotion Studio in the browser to scrub through the video |

## Files

| Path | What |
|---|---|
| `scripts/record.mjs` | The live-site recording (the storyboard steps, the Gemini guard, the login guard) |
| `scripts/lib/human.mjs` | Slow, human-like mouse moves, the cursor highlight, the blur on PayPal's login |
| `scripts/lib/stream.mjs` | Sharp frames straight from Chrome (no browser bars) |
| `scripts/clips.mjs` | Frames → one 30 fps clip per scene, with the waits cut out |
| `scripts/voice.mjs` | Your recordings → trimmed, equally loud copies, and the voice report |
| `scripts/timeline.mjs` | Captions from PLAN.md, voice lengths, scene lengths, the 2:55 check |
| `src/Demo.jsx` | The video itself (Remotion) |

## Licence

Remotion is free for individuals, companies with up to 3 employees, non-profits, and evaluation. That covers a solo hackathon entry, including a commercial one (`node_modules/remotion/LICENSE.md`). A paid company licence is only needed for bigger for-profit companies. The video uses no music and no third-party logos. The font is Inter (SIL Open Font License), the same one the app uses.
