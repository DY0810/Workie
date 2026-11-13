import { createServer } from "node:http";

// A local stand-in for the LinkedIn pages the worker touches, built with the class names read from the real site.
// Every name here is invented. It cannot show that the real pages still look like this.
const PEOPLE = {
  "sam-fixture": "Sam Fixture, MBA", other: "Other Person", threaded: "Thread Fixture", "late-thread": "Late Fixture",
  "wrong-link": "Wrong Fixture", bare: "Bare Fixture", silent: "Silent Fixture", clipped: "Clipped Fixture",
};
const composeHref = (recipient) => `/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3A${recipient}&recipient=${recipient}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;
const profile = (handle) => `<!doctype html><title>(3) ${PEOPLE[handle]} | LinkedIn</title>
<header><a href="${composeHref("other")}">Message</a></header>
<main><section><h2>${PEOPLE[handle]}</h2>
${handle === "bare" ? "" : `<a href="${composeHref(handle === "wrong-link" ? "other" : handle)}">Message</a>`}</section>
${handle === "bare" ? "" : `<section><a aria-label="Message Other Person" href="${composeHref("other")}">Message</a></section>`}</main>`;
const earlier = `<li class="msg-s-message-list__event"><div class="msg-s-event-listitem"><p class="msg-s-event-listitem__body">An earlier message.</p></div></li>`;
const compose = (recipient) => `<!doctype html><title>Messaging | LinkedIn</title><main>
<div class="msg-connections-typeahead__added-recipients"><button class="artdeco-pill"><span class="artdeco-pill__text">${PEOPLE[recipient]}</span></button></div>
<div class="msg-s-message-list"><div class="msg-s-message-list__loader hidden"></div>
<ul class="msg-s-message-list-content">${recipient === "threaded" ? earlier : ""}</ul></div>
${recipient === "threaded" ? "" : `<form class="msg-form">${recipient === "silent" ? "" : `<input name="subject" placeholder="Subject (optional)">`}
<div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…"><p><br></p></div>
<button class="msg-form__send-button" type="submit" disabled>Send</button></form>`}</main>
<script>
const recipient = ${JSON.stringify(recipient)}, list = document.querySelector(".msg-s-message-list-content");
const show = (text) => {
  const item = document.createElement("li"), bubble = document.createElement("div"), body = document.createElement("p");
  bubble.className = "msg-s-event-listitem"; body.className = "msg-s-event-listitem__body"; body.textContent = text;
  bubble.append(body); item.append(bubble); list.append(item);
};
if (recipient === "late-thread") setTimeout(() => show("An earlier message."), 800);
const form = document.querySelector("form.msg-form");
if (form) {
  const editor = form.querySelector(".msg-form__contenteditable"), button = form.querySelector("button");
  editor.addEventListener("input", () => { button.disabled = !editor.textContent.trim(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const lines = [...editor.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
    await fetch("/sent", { method: "POST", body: JSON.stringify({ recipient, subject: form.subject ? form.subject.value : null, lines }) });
    if (recipient === "silent") return;
    history.pushState(null, "", "/messaging/thread/2-" + recipient + "/");
    show(recipient === "clipped" ? lines[0] : lines.join("\\n"));
  });
}
</script>`;
// The sign-in page itself "signs in" after a moment; the one a signed-out profile redirects to (it has a query) never does.
const login = (search) => `<!doctype html><title>LinkedIn Login</title><main>Sign in</main>
${search ? "" : `<script>setTimeout(() => { location.href = "/feed/"; }, 1200);</script>`}`;

/**
 * Starts the stand-in on a loopback port. `sent` collects what its Send button posted. With `session`, profiles and
 * messages need the cookie the feed sets, as on the real site: a sign-in has to carry into the window that sends.
 */
export async function linkedinStandIn({ session = false } = {}) {
  const sent = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), handle = url.pathname.match(/^\/in\/([^/]+)\/$/)?.[1];
    const html = (body) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    const signedOut = session && !/(?:^|;\s*)li_at=/.test(request.headers.cookie ?? "") && (handle || url.pathname.startsWith("/messaging/"));
    if (signedOut) return response.writeHead(302, { location: "/login?session_redirect=x" }).end();
    if (request.method === "POST" && url.pathname === "/sent") {
      let body = "";
      for await (const chunk of request) body += chunk;
      sent.push(JSON.parse(body));
      return response.writeHead(204).end();
    }
    if (handle === "signed-out") return response.writeHead(302, { location: "/login?session_redirect=x" }).end();
    if (handle === "moved") return response.writeHead(302, { location: "/in/sam-fixture/" }).end();
    if (handle && PEOPLE[handle]) return html(profile(handle));
    if (url.pathname === "/messaging/compose/" && PEOPLE[url.searchParams.get("recipient")]) return html(compose(url.searchParams.get("recipient")));
    if (url.pathname === "/login") return html(login(url.search));
    if (url.pathname === "/feed/") {
      response.setHeader("set-cookie", "li_at=stand-in; Path=/; Max-Age=3600; HttpOnly");
      return html("<!doctype html><title>Feed | LinkedIn</title><main>Feed</main>");
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, sent, close: () => server.close() };
}
