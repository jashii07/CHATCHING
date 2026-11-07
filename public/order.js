// The buyer's "Your order" page (src/order-links.js and src/order-page.js have the why). The private key is in the
// address after the #, which browsers never send to a server; this page sends it in a POST body. It stays in
// the address bar, so the buyer can reload the page or open the link from the chat again.
// Everything the server sends is shown with textContent, never as HTML: a buyer's note or message with
// <script> in it stays plain characters.
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });

const POLL_MS = 20_000;
const POLL_FOR_MS = 30 * 60_000; // like the seller's page: auto-check stops after 30 minutes
const STATUS_TAGS = { unpaid: "badge-sent", "part-paid": "badge-part-paid", paid: "badge-paid", collected: "badge-collected", cancelled: "badge-cancelled" };
const MARK_NAMES = { item: "menu item", qty: "quantity", day: "day", fulfilment: "pickup or delivery", change: "change", price: "price", "price-check": "price to check" };

// A chat app can stick a full stop or a bracket to the end of a link: keep only the key's own characters.
const token = (location.hash.slice(1).match(/^[A-Za-z0-9_-]+/) ?? [""])[0];
if (location.hash && location.hash.slice(1) !== token) history.replaceState(null, "", `${location.pathname}#${token}`);

let order = null;
let pollStarted = Date.now();
let timer = null;
let sending = false;

// The free host sleeps when nobody uses it, and answers 502/503/504 (or not at all) for a moment while it wakes up
// or a new version starts. The page's FIRST request then waits and tries again by itself, about 30 s in all, and
// says so (8 Nov polish). Later checks just keep the order on screen and try again at the next one.
const WAKE_WAITS_MS = [2000, 3000, 5000, 8000, 12000];
const WAKING = "Waking up the server... It sleeps when nobody is using it, so this can take up to a minute.";
const NO_SERVER = "Couldn't reach ChatChing. Please check your connection, then reload this page.";
const busy = (reply) => !reply || [502, 503, 504].includes(reply.status);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -> { ok, status, body }. A reply that isn't JSON (a host's own error page) has an empty body.
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  const json = (res.headers.get("Content-Type") ?? "").includes("application/json");
  return { ok: res.ok, status: res.status, body: json ? await res.json() : {} };
}

function say(words) {
  $("order-words").textContent = words;
}

function gone(words) {
  order = null;
  stopPolling();
  $("order-content").hidden = true;
  say(words);
}

function render() {
  const o = order;
  $("order-content").hidden = false;
  say(`Hi ${o.buyer}! Please check what the seller got from your messages.`);

  const tag = el("span", `badge ${STATUS_TAGS[o.status] ?? "badge-sent"}`, o.statusLabel);
  $("order-status").replaceChildren(tag);
  $("order-items").replaceChildren(...o.items.map((item) => {
    const line = el("li", "order-item");
    line.append(el("span", "", `${item.qty} × ${item.name}`), el("span", "money", item.lineTotal));
    return line;
  }));
  $("order-total").textContent = o.total;
  const when = [o.fulfilment, o.dates.join(", ")].filter(Boolean).join(", ");
  $("order-when").textContent = when;
  $("order-when").hidden = !when;
  $("order-check-failed").hidden = !o.checkFailed;

  $("order-pay").hidden = !o.payLink;
  if (o.payLink) {
    $("pay-link").href = o.payLink;
    $("pay-link").textContent = `Pay ${o.total} with PayPal`;
  }
  const paid = o.status === "paid" || o.status === "collected";
  $("order-paid").hidden = !paid;
  $("paid-title").textContent = o.status === "collected" ? "Collected. Thank you!" : "Paid. Thank you!";
  renderQr(o);
  renderAnswer(o);
  renderMessages(o);
}

function renderQr(o) {
  const box = $("order-qr");
  if (!o.qr) return box.replaceChildren(...(o.status === "collected" ? [el("p", "hint", "You have your order. Enjoy!")] : []));
  if (o.qr.notice) return box.replaceChildren(el("p", "hint", o.qr.notice));
  const label = o.fulfilment === "Pickup" ? "Show this QR when you pick up your order." : "Show this QR when you get your order.";
  box.replaceChildren(
    Object.assign(document.createElement("img"), { className: "qr-image", id: "order-qr-image", src: `data:image/png;base64,${o.qr.png}`, width: 180, height: 180, alt: "Your order's QR code, for the seller to scan" }),
    el("p", "pair-help", label),
  );
}

function renderAnswer(o) {
  const said = $("answer-said");
  said.hidden = !o.answer;
  if (o.answer?.answer === "ok") said.textContent = "You said this looks right. Thank you!";
  if (o.answer?.answer === "wrong") said.textContent = o.answer.note ? `You told the seller something's wrong: "${o.answer.note}"` : "You told the seller something's wrong.";
  said.classList.toggle("is-wrong", o.answer?.answer === "wrong");
  $("answer-ok").textContent = o.answer?.answer === "ok" ? "Looks right (sent)" : "Looks right";
  // One main (filled) button at a time (8 Nov polish): Looks right until the buyer answers; once they say it looks
  // right, Pay. After "Something's wrong" both stay pale: the seller has to fix the order first. Pay always works.
  $("answer-ok").classList.toggle("ghost", Boolean(o.answer));
  $("pay-link").classList.toggle("is-quiet", o.answer?.answer !== "ok");
}

function renderMessages(o) {
  $("order-chat").hidden = !o.messages.length;
  $("order-messages").replaceChildren(...o.messages.map((msg) => {
    const item = el("li", "chat-msg");
    item.append(el("span", "chat-when", msg.when));
    const text = el("p", "chat-text");
    for (const part of msg.parts) {
      if (!part.mark) text.append(part.text);
      else text.append(Object.assign(el("mark", `hl hl-${part.mark}`, part.text), { title: MARK_NAMES[part.mark] ?? "" }));
    }
    item.append(text);
    return item;
  }));
}

function showReply(body) {
  if (body.gone) return gone(body.notice);
  if (body.notice) return say(body.notice); // e.g. going a bit fast: the order stays on screen
  if (!body.order) return;
  order = body.order;
  render();
  if (order.status === "collected" || order.status === "cancelled") stopPolling();
}

async function load() {
  if (!token) return gone("This link is missing its key. Please open the link the seller sent you again.");
  for (let attempt = 0; ; attempt++) {
    let reply = null;
    try {
      reply = await post("/api/order/view", {});
    } catch {
      // no answer at all: the server is asleep, starting, or the connection dropped
    }
    if (!busy(reply)) return showReply(reply.body);
    if (order) return; // a later check: the order stays as it is, the next check tries again
    if (attempt >= WAKE_WAITS_MS.length) return say(NO_SERVER);
    say(WAKING);
    await pause(WAKE_WAITS_MS[attempt]);
  }
}

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

function schedule() {
  stopPolling();
  if (Date.now() - pollStarted > POLL_FOR_MS) return;
  timer = setTimeout(async () => {
    if (!document.hidden) await load();
    if (order && order.status !== "collected" && order.status !== "cancelled") schedule();
  }, POLL_MS);
}

async function answer(kind, note) {
  if (sending) return;
  sending = true;
  $("answer-error").hidden = true;
  for (const id of ["answer-ok", "answer-wrong", "answer-send"]) $(id).disabled = true;
  try {
    const { ok, body } = await post("/api/order/answer", kind === "wrong" ? { answer: kind, note } : { answer: kind });
    if (!ok) {
      $("answer-error").textContent = `Error: ${body.error ?? "your answer couldn't be saved."}`;
      $("answer-error").hidden = false;
      return;
    }
    $("answer-form").hidden = true;
    showReply(body);
  } catch {
    $("answer-error").textContent = "Error: couldn't reach ChatChing. Check your connection and try again.";
    $("answer-error").hidden = false;
  } finally {
    sending = false;
    for (const id of ["answer-ok", "answer-wrong", "answer-send"]) $(id).disabled = false;
  }
}

$("answer-ok").addEventListener("click", () => answer("ok"));
$("answer-wrong").addEventListener("click", () => {
  $("answer-form").hidden = false;
  $("answer-note").value = order?.answer?.answer === "wrong" ? order.answer.note : "";
  $("answer-count").textContent = String($("answer-note").value.length);
  $("answer-note").focus();
});
$("answer-cancel").addEventListener("click", () => ($("answer-form").hidden = true));
$("answer-note").addEventListener("input", () => ($("answer-count").textContent = String($("answer-note").value.length)));
$("answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  answer("wrong", $("answer-note").value);
});

// Back from PayPal's tab: ask at once, so Paid shows without waiting for the next check.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !order) return;
  pollStarted = Date.now();
  load().then(() => order && order.status !== "collected" && order.status !== "cancelled" && schedule());
});
window.addEventListener("hashchange", () => location.reload()); // another order's link opened in this tab

load().then(() => order && schedule());
