const labels = { user: "You", assistant: "Agent", reasoning: "Thinking", action: "Action" };

/** @param {import('../types').Entry} entry */
export function lineText(entry) {
  const suffix = entry.kind === "action" ? entry.outcome === "failed" ? " · failed" :
    entry.outcome === "running" ? " · running" : " · done" : "";
  return `[${labels[entry.kind] ?? "Agent"}] ${entry.text}${suffix}`;
}

/** @param {HTMLElement} container @param {import('../types').Entry[]} entries */
export function renderEntries(container, entries) {
  const fragment = container.ownerDocument.createDocumentFragment();
  for (const entry of entries.slice(-100)) {
    const line = container.ownerDocument.createElement("p");
    line.className = `message ${entry.kind}${entry.outcome === "failed" ? " failed" : ""}`;
    line.dataset.id = entry.id;
    line.textContent = lineText(entry);
    fragment.append(line);
  }
  container.replaceChildren(fragment);
}

/** @param {import('../types').Snapshot} snapshot @param {number} [now] */
export function statusText(snapshot, now = Date.now()) {
  if (snapshot.status === "unavailable") return "Unavailable · Showing last known activity";
  if (!snapshot.session) return "Waiting for activity in this project…";
  const label = { waiting: "Waiting", working: "Working", idle: "Idle", interrupted: "Interrupted" }[snapshot.status];
  const seconds = snapshot.lastActivity ? Math.max(0, Math.floor((now - Date.parse(snapshot.lastActivity)) / 1000)) : 0;
  return `${label} · ${seconds < 10 ? "Just now" : seconds < 60 ? `${seconds}s ago` :
    seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`}`;
}
