// The phone's side of "Open on my phone" (src/pairing.js has the why). The code is in the address after the #,
// which browsers never send to a server. It leaves the address bar first, so it can't stay in the phone's
// history or be shared by accident, and then goes in a POST. The server answers with the cookie alone.
// A browser that already has orders is asked first. "No" keeps its own table, and the link is simply not used.
function say(words) {
  document.getElementById("pair-words").textContent = words;
  document.getElementById("pair-home").hidden = false;
}

async function openOrders() {
  const code = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  try {
    let reply = await post({ code });
    if (reply.confirm) {
      if (!window.confirm(reply.confirm)) return location.replace("/");
      reply = await post({ code, replace: true });
    }
    if (reply.paired) return location.replace("/"); // replace: the Back button doesn't come back to this page
    say(reply.notice ?? reply.error);
  } catch {
    say("Couldn't reach the server. Check the connection, then scan the QR again.");
  }
}

async function post(body) {
  const res = await fetch("/api/pair/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// A new link opened on a phone already showing this page only changes the part after the #: no page load.
window.addEventListener("hashchange", () => {
  if (location.hash) openOrders();
});
openOrders();
