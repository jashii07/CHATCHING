# Deploy ChatChing to Render (free plan)

A step-by-step guide for Jasper. It takes about 15 minutes. You do the clicks; Claude never sees your keys.

**Render** is a hosting company: it copies the code from GitHub, installs it, and runs it on a public
web address (a URL like `https://chatching.onrender.com`), so judges can open the app without your laptop.

## Before you start

- You need: your GitHub login, and your `.env` file open in Notepad (you will copy 3 key values from it).
- Never paste a key into the chat with Claude, and never into GitHub. Keys only go into Render's own form.
- **STOP rule: if Render asks for a card (credit or debit card) at ANY point, stop. Don't enter it.**
  Close the tab and tell Claude. The plan is the free plan only.
- Render changes its screens now and then. If a button has a slightly different name, pick the closest
  match. If something looks very different, stop and tell Claude what you see.

## 1. Sign in to Render

1. Open https://dashboard.render.com in your browser.
2. Click **GitHub** to sign up or sign in with your GitHub account.
3. If GitHub asks "Authorize Render?", click **Authorize**.

Done when: you see Render's dashboard.

## 2. Create the web service

1. In the top-right corner, click **+ New**, then **Web Service**.
2. Under "Source Code", pick **GitHub**. If no repositories are listed, click **Connect GitHub**
   (or **Configure account** / **Configure GitHub App**).
3. GitHub opens a page "Install Render". Give Render access to **this repo only**:
   1. Choose your account **jashii07**.
   2. Pick **Only select repositories** (NOT "All repositories").
   3. In the list, pick **CHATCHING**.
   4. Click **Install** (or **Save**).
4. Back in Render, click **jashii07 / CHATCHING** in the list.

Done when: Render shows a form to set up the service.

## 3. Fill in the form

Type exactly what the right-hand column says. Leave anything not listed here as it is.

| Field | What to choose or type |
|---|---|
| Name | `chatching` (it becomes part of the URL; if the name is taken, Render adds a few letters) |
| Language (some screens say Runtime) | **Node** |
| Branch | **main** |
| Region | **Singapore (Southeast Asia)**: closest to Malaysia |
| Root Directory | leave empty |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Instance Type | **Free** ($0/month). Not Starter, not any paid type |

Why these commands:
- `npm ci --omit=dev` installs exactly the package versions in `package-lock.json` (so Render runs the same
  code as your laptop), and skips the test-only packages (the browser checks).
- `npm start` starts the server. On Render there is no `.env` file; the app reads the keys from Render's
  environment settings (next step) instead.
- Node version: nothing to set. `package.json` says Node 24 (`"engines": { "node": "24.x" }`), and
  Render follows that.

## 4. Add the environment variables

An **environment variable** is a named setting the app reads when it starts, like a label on a box:
the app asks for "GEMINI_API_KEY", and Render hands it the value you typed. This is how keys stay out of GitHub.

On the same form, find **Environment Variables** and click **Add Environment Variable** once per row.
Type the NAME exactly (capital letters, underscores). For the VALUE, copy it from your `.env` in Notepad.

| NAME | What it is for | VALUE to use |
|---|---|---|
| `PAYPAL_CLIENT_ID` | Lets the app log in to your PayPal **sandbox** app (to send invoices) | Copy from your `.env` |
| `PAYPAL_CLIENT_SECRET` | The password that goes with the client id. Secret | Copy from your `.env` |
| `GEMINI_API_KEY` | Lets the app ask Gemini to read new chats. Secret | Copy from your `.env` |
| `AI_MODE` | How the app reads chats: `mock` (saved demo answers only), `real` (Gemini reads new chats), `off` (read without AI) | Type `real` |

Notes:
- `AI_MODE=real` is what judges should get: the demo chats still come from the saved answer (0 AI calls),
  and only chats a judge pastes themselves use Gemini, with the daily counter as a limit.
- Do NOT add `PORT`. Render sets it by itself, and the app listens on it.
- Copy values with no spaces or quote marks around them.

## 5. Health check (optional)

If you see an **Advanced** section with **Health Check Path**, type `/api/health`.
Render then checks that address to see the app is up. It only answers `ok` and the version, never keys.
If you don't see this field, skip this step.

## 6. Deploy

1. Click **Deploy Web Service** (or **Create Web Service**) at the bottom.
2. Render shows a log (lines of text). It takes a few minutes. Wait until you see these lines:
   - `Build successful`
   - `ChatChing is running at ...`
   - `AI mode: real. Keys present: PAYPAL_CLIENT_ID=yes, PAYPAL_CLIENT_SECRET=yes, GEMINI_API_KEY=yes`
   - `Your service is live`
3. If a key says `=no`, the NAME is probably misspelled. Go to **Environment** in the left menu, fix the
   name, click **Save Changes**, and Render restarts the app by itself.

## 7. Check it worked

At the top of the page, Render shows your URL (for example `https://chatching.onrender.com`).

1. Open `<your URL>/api/health`. Done when you see: `{"ok":true,"version":"1.0.0"}`
2. Open `<your URL>`. Done when you see the demo orders table, and the quiet footer at the bottom says
   **PayPal keys: set** and **Gemini key: set**.
3. Send Claude the URL (the URL is not a secret; the keys are). Claude then runs the end-to-end check
   with you (Step 11, part 2).

## If something goes wrong

- **Render asks for a card:** stop, don't enter it, tell Claude.
- **The build fails (red text in the log):** copy the last 20 lines of the log and send them to Claude.
  The log never prints your keys (the app only prints `yes` / `no` for each one).
- **The first load takes up to a minute:** that is normal on the free plan (see below), not a bug.

## What the free plan means for the demo

- The app **sleeps after 15 minutes** without visitors. The next visitor waits **up to about 1 minute**
  while it wakes up.
- **Every sleep or restart resets the orders** to the demo (Render's free disk is wiped). Invoices are safe:
  they live in PayPal. The app's own "AI calls left" count also starts again; Google still enforces its
  real daily limit, and the app then shows "Today's free AI reads are used up..." instead of an error.
- Everyone who opens the link shares **one** table (one shared demo seller).
- The free plan gives 750 hours a month, enough for one app running all month.
