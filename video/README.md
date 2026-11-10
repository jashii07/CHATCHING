# ChatChing demo video

This folder makes the 3-minute demo video. It is separate from the app: it has its own `package.json`, so Render never installs it, and everything it makes (clips, renders, your recordings) is git-ignored. Only the source is in git.

How it works, in two halves:

1. **Recording** (`npm run record`): a Playwright script drives the **live site** at 1920 × 1080 and follows the storyboard (PLAN.md Section 13), with a visible cursor and short pauses. It saves one clip per scene in `public/clips/`. It sends 7 real sandbox invoices. In scene 6 it copies Lina's message, opens her order page from it, taps **Looks right**, pays with the judge 1 login from the main README, and comes back to ChatChing for the Paid moment (the tag pops, the row flashes, the Paid card counts up). The login is blurred on PayPal's pages, and a guard cuts any moment where it isn't. Page loads and the login are **sped up**, not cut, so scene 6 stays quick. After scene 7 it records a cash payment for Aisyah and takes a still of her paid order page in a phone-sized window, for scene 8. It makes **no Gemini call**: only the demo chats can reach the app's AI route (the server answers them from its saved reply), and the run fails if "AI calls left" changes.
2. **Editing** (`npm run draft` / `npm run final`): Remotion builds the video. It adds the title card, the chats scene, the recorded scenes with gentle zooms on each key moment, your phone clip, the tech scene and the closing logo. Every scene has its caption, read straight from PLAN.md Section 13, plus your voice line. There is no music. The screen recording has no sound, so the edit adds the app's own cha-ching (the same two Web Audio notes, `scripts/lib/chime.mjs`) at the moment Lina turns Paid, and again on the title card as the logo appears (same file, same level). Voice lines 3, 6 and 8 are split at their pauses, so each part plays over its moment ("taps Looks right" on the click, "Paid?" when the phone shows Paid).

**Voice (Tue 10 Nov, afternoon).** Every scene's line comes from Jasper's read-through of the whole new script (`scene 1 hook.mp3`, 107 s), cut into the 10 scenes at the pauses between them. The 7 Nov lines are the fallback (`npm run voice -- --7nov`); their processed copies, as used in the 2:49.3 cut, are kept in `public/voice-ready-7nov/`.

**Sync (Tue 10 Nov).** The picture shows what the voice says, within about 0.3 s:
- Scene 1 (the new hook): the day's chats scroll by fast; "Who wants what?", "Who changed their mind?" and "Who actually paid?" appear in the captions' dark pill as each is said; on "My friend sorts this out by hand..." they go and the scroll slows down.
- Scene 3 is re-cut into shots that follow the voice: Lina's row, Aisyah's row and Danish's crossed-out row each get a soft blue ring while their name is said, the Expected RM 366.00 card on "the AI never sets a price", Jun Wei's amber row on "So when Jun Wei...", then a zoom on its price check.
- Scene 4: Priya's row is clicked on "Priya's", Copy question on "One tap". Scene 5: the click on "One click", the second click on "click again", then a zoom on "All invoices sent" and "7 of 7 sent". Scene 9: each name and number appears as it is said, and the friend's words as they are quoted.
- Scene 6: "taps 'Looks right'" on the tap, "and pays with PayPal" on the Pay click, the cha-ching and Lina's Paid tag in the short pause after "A moment later,". Scene 8: "scan" as the scanner opens, "Paid?" as the phone shows Paid, then a wait while the finger moves, and "Great, it's collected" just before the tap on Collected.
- Scenes 2, 7 and 10 play straight and are in sync: the chats appear on "paste", the Kitchen list opens on "the kitchen list".

These edits (`EDITS`, `HOOK`, `TECH` and the `VOICE_PARTS` splits in `scripts/timeline.mjs`) were measured on the 9 Nov recording and the lines cut from the 10 Nov read-through: word starts with Windows' own speech recognizer and the loudness in 20 ms steps, moments on the recording's frames (the 7 Nov lines' times are in git, commit 280a584). If the recording or a voice line changes, that scene's edit switches off with a warning and the scene plays straight, as before.

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
4. Put them in **`video\public\voice\`** as they are. A phone's names work: `scene 1.m4a` … `scene 10.m4a` (`scene1.m4a` too). A scene recorded in two parts is `scene 3.m4a` (part 1) plus a file starting with `scene 3 second part` (part 2). **Since 10 Nov (afternoon), `scene 1 hook.mp3` is used for every scene:** it is one read-through of the whole new script, and `npm run voice` cuts it at one point inside the pause between each two scenes (`READ_THROUGH.cuts` in `scripts/voice.mjs`, found with the speech recognizer against PLAN.md Section 14). A new take of that file needs new cut points (the report warns when its length changes). `npm run voice -- --7nov` goes back to one file per scene (the 7 Nov lines, with only the first 12.95 s of the read-through, the hook, as scene 1).
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
3. Film the phone's screen: **Pickup scan** → scan a buyer's invoice QR → the result shows Paid → tap **Collected**. Hold the phone upright. Aim for 15 to 18 seconds (scene 8's time in PLAN.md Section 13; a longer clip makes the whole video longer).
4. Copy the video to the laptop (USB cable, Google Drive or email to yourself) and save it in **`video\public\phone\`**. The phone's own file name works (the newest video there is used; `pickup.mp4` wins if it exists). A `.mov` from an iPhone also works: the render turns it into a normal MP4 by itself and drops the phone's sound.

The 9 Nov clip is a 12.7 s screen recording (576 x 1280). The render crops off the phone's status bar (notification icons), Chrome's address bar and the navigation bar, so only ChatChing shows. Before it, scene 8 shows a 1.5 s still of the paid buyer's order page ("Aisyah shows the QR from her order page"). If you film a new clip, update `PHONE_PAID_AT` (when it shows Paid) and `PHONE_CROPS` in `scripts/timeline.mjs`.

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
- `npm run final -- --no-record` reuses the last recording, for when you only changed a voice line. **Since 10 Nov this is the one to use:** the sync edits belong to the 9 Nov recording, so a new recording turns them off (the render says so) until they are measured again.
- `npm run final -- --judge=2` pays with the README's second judge login.

**The PayPal pages' language.** The recorder asks for English (locale en-US, `Accept-Language: en-US,en`, Chrome's `--lang=en-US`). Checked on Mon 9 Nov: with that, every PayPal page in the recording is in English with judge 1 (it was Malay on 4 Nov without the header).

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
| `scripts/lib/chime.mjs` | The app's cha-ching as a WAV file, for the edit |
| `scripts/clips.mjs` | Frames → one 30 fps clip per scene, waits cut out or sped up |
| `scripts/voice.mjs` | Your recordings → trimmed, equally loud copies, and the voice report |
| `scripts/timeline.mjs` | Captions from PLAN.md, voice lengths, scene lengths, the 2:55 check |
| `src/Demo.jsx` | The video itself (Remotion) |

## Licence

Remotion is free for individuals, companies with up to 3 employees, non-profits, and evaluation. That covers a solo hackathon entry, including a commercial one (`node_modules/remotion/LICENSE.md`). A paid company licence is only needed for bigger for-profit companies. The video uses no music and no third-party logos. The font is Inter (SIL Open Font License), the same one the app uses.
