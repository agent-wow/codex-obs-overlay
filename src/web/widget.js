import { transcriptRenderer, statusText, infoText } from "./render.js";

const messages = /** @type {HTMLElement} */ (document.getElementById("messages"));
const viewport = /** @type {HTMLElement} */ (document.getElementById("viewport"));
const title = /** @type {HTMLElement} */ (document.getElementById("session"));
const model = /** @type {HTMLElement} */ (document.getElementById("model"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const follow = /** @type {HTMLButtonElement} */ (document.getElementById("follow"));
const project = new URLSearchParams(location.search).get("project") ?? "";
const selection = { project, session: "" };
const renderer = transcriptRenderer(messages, selection);
/** @type {import('../types').Snapshot | undefined} */
let snapshot;
/** @type {EventSource | undefined} */
let stream;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retry;
/** @type {ReturnType<typeof setInterval> | undefined} */
let clock;
let failures = 0;
let connected = false;
let suspended = false;
let following = true;
let positioning = false;

function toBottom() {
  positioning = true;
  viewport.scrollTop = viewport.scrollHeight;
  follow.hidden = true;
  requestAnimationFrame(() => { positioning = false; });
}
viewport.addEventListener("scroll", () => {
  if (positioning) return;
  following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
  follow.hidden = following;
});
follow.addEventListener("click", () => { following = true; toBottom(); });
const resize = new ResizeObserver(() => { if (following && !suspended) toBottom(); });
resize.observe(messages);

function connect() {
  if (suspended) return;
  const connection = new EventSource(`/api/activity/stream?${new URLSearchParams({ project })}`);
  stream = connection;
  /** @param {MessageEvent<string>} event */
  const apply = (event) => {
    try {
      const value = /** @type {import('../types').FeedUpdate} */ (JSON.parse(event.data));
      const changed = value.epoch !== snapshot?.epoch || value.session?.id !== snapshot?.session?.id;
      // A reconnect supplies all entries. On the same session, preserve the reader's scroll position.
      const scrollTop = viewport.scrollTop;
      if (changed) following = true;
      selection.session = value.session?.id ?? "";
      renderer.apply(value.entries, value.reset || changed);
      snapshot = value;
      title.textContent = value.session?.title ?? "Codex";
      model.textContent = infoText(value.info);
      model.title = [value.info.contextWindow ? `Context window: ${value.info.contextWindow.toLocaleString()}` : "",
        value.info.contextTokens ? `Latest request: ${value.info.contextTokens.toLocaleString()} tokens` : ""].filter(Boolean).join(" · ");
      document.title = `${value.session?.title ?? "Codex"} — Agent activity`;
      status.textContent = statusText(value);
      connected = true;
      failures = 0;
      if (following) toBottom();
      else if (value.reset) viewport.scrollTop = scrollTop;
    } catch {
      status.textContent = "Unavailable · Invalid activity update";
    }
  };
  connection.addEventListener("snapshot", apply);
  connection.addEventListener("update", apply);
  connection.onerror = () => {
    connection.close();
    connected = false;
    status.textContent = "Reconnecting… · Showing last known activity";
    if (!suspended) retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000));
  };
}

function start() {
  clock = setInterval(() => { if (connected && snapshot) status.textContent = statusText(snapshot); }, 1000);
  connect();
}
window.addEventListener("pagehide", () => {
  suspended = true;
  connected = false;
  clearTimeout(retry);
  clearInterval(clock);
  stream?.close();
  resize.disconnect();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) { suspended = false; resize.observe(messages); start(); }
});
start();
