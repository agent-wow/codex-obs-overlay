import { renderEntries, statusText } from "./render.js";

const messages = /** @type {HTMLElement} */ (document.getElementById("messages"));
const title = /** @type {HTMLElement} */ (document.getElementById("session"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const project = new URLSearchParams(location.search).get("project");
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

function connect() {
  if (suspended) return;
  const query = new URLSearchParams({ project: project ?? "" });
  const connection = new EventSource(`/api/activity/stream?${query}`);
  stream = connection;
  connection.addEventListener("snapshot", (event) => {
    try {
      const value = /** @type {import('../types').Snapshot} */ (JSON.parse(event.data));
      renderEntries(messages, value.entries);
      snapshot = value;
      title.textContent = value.session?.title ?? "Codex";
      document.title = `${value.session?.title ?? "Codex"} — Agent activity`;
      status.textContent = statusText(value);
      connected = true;
      failures = 0;
    } catch {
      status.textContent = "Unavailable · Invalid activity update";
    }
  });
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
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) { suspended = false; start(); }
});
start();
