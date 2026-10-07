import { renderMarkdown } from "./markdown.js";

const labels = { user: "You", assistant: "Agent", reasoning: "Thinking", action: "Action", plan: "Plan", event: "Activity" };

/** @param {HTMLElement} container @param {{project:string, session:string}} selection */
export function transcriptRenderer(container, selection) {
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  /** @param {import('../types').Entry} entry */
  function create(entry) {
    const doc = container.ownerDocument;
    const article = doc.createElement("article");
    article.className = `entry ${entry.kind}${entry.outcome === "failed" ? " failed" : ""}`;
    article.dataset.id = entry.id;
    const inlineMessage = ["user", "assistant", "reasoning"].includes(entry.kind);
    const compactAction = entry.kind === "action";
    const headerLabels = new Set(["Shell", "Exit code", "Duration"]);
    const heading = doc.createElement(inlineMessage ? "span" : "div");
    heading.className = "entry-heading";
    const name = doc.createElement("span");
    name.className = "entry-label";
    name.textContent = compactAction ? entry.text || labels.action :
      entry.kind === "assistant" && entry.phase === "final_answer" ? "Agent · Response" : labels[entry.kind];
    heading.append(name);
    if (entry.outcome) {
      const outcome = doc.createElement("span");
      outcome.className = "outcome";
      outcome.textContent = entry.outcome === "completed" ? "Done" : entry.outcome === "failed" ? "Failed" : "Running";
      heading.append(outcome);
    }
    if (compactAction) {
      for (const section of entry.sections ?? []) {
        if (!headerLabels.has(section.label)) continue;
        const detail = doc.createElement("span");
        detail.className = "header-detail";
        detail.title = section.label;
        detail.textContent = section.label === "Exit code" ? `exit ${section.text}` : section.text;
        heading.append(detail);
      }
    }
    const time = doc.createElement("time");
    time.dateTime = entry.timestamp;
    time.textContent = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    heading.append(time);
    const body = doc.createElement("div");
    body.className = "entry-body";
    if (entry.kind === "event") {
      const title = doc.createElement("p");
      title.textContent = entry.text;
      title.className = "action-title";
      body.append(title);
    } else if (!compactAction) renderMarkdown(body, entry.text);
    for (const section of entry.sections ?? []) {
      if (section.label === "Working directory") continue;
      if (compactAction && headerLabels.has(section.label)) continue;
      if (!(compactAction && entry.text === "Command" && section.label === "Command")) {
        const label = doc.createElement("div");
        label.className = "section-label";
        label.textContent = section.label;
        body.append(label);
      }
      const content = doc.createElement(section.format === "text" ? "p" : "pre");
      content.className = `section-content ${section.format}`;
      if (section.format === "diff") {
        for (const line of section.text.split("\n")) {
          const span = doc.createElement("span");
          span.className = line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : line.startsWith("@@") ? "hunk" : "";
          span.textContent = `${line}\n`;
          content.append(span);
        }
      } else content.textContent = section.text;
      body.append(content);
    }
    for (const attachment of entry.attachments ?? []) {
      const figure = doc.createElement("figure");
      const caption = doc.createElement("figcaption");
      caption.textContent = attachment.label;
      figure.append(caption);
      if (attachment.kind !== "file") {
        const src = `/api/media?${new URLSearchParams({ project: selection.project, session: selection.session, asset: attachment.id })}`;
        if (attachment.kind === "image") {
          const img = doc.createElement("img");
          img.src = src;
          img.alt = attachment.label;
          img.loading = "lazy";
          img.addEventListener("error", () => { caption.textContent = `${attachment.label} · Image unavailable`; });
          figure.prepend(img);
        } else {
          const audio = doc.createElement("audio");
          audio.src = src;
          audio.controls = true;
          audio.preload = "none";
          figure.prepend(audio);
        }
      }
      body.append(figure);
    }
    const first = body.firstElementChild;
    if (inlineMessage && first && ["P", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"].includes(first.tagName)) {
      heading.classList.add("message-heading");
      name.textContent += ":";
      first.prepend(heading, doc.createTextNode(" "));
      article.classList.add("inline-message");
      article.append(body, time);
    } else article.append(heading, body);
    return article;
  }
  return {
    /** @param {import('../types').Entry[]} entries @param {boolean} reset */
    apply(entries, reset) {
      if (reset) { elements.clear(); container.replaceChildren(); }
      const fragment = container.ownerDocument.createDocumentFragment();
      for (const entry of entries) {
        const node = create(entry);
        const previous = elements.get(entry.id);
        if (previous) previous.replaceWith(node);
        else fragment.append(node);
        elements.set(entry.id, node);
      }
      container.append(fragment);
    },
  };
}

/** @param {import('../types').SessionInfo} info */
export function infoText(info) {
  return [info.model, info.effort, typeof info.totalTokens === "number" ? `${info.totalTokens.toLocaleString()} tokens` : undefined]
    .filter(Boolean).join(" · ");
}

/** @param {import('../types').Snapshot} snapshot @param {number} [now] */
export function statusText(snapshot, now = Date.now()) {
  if (snapshot.status === "unavailable") return "Unavailable · Showing last known activity";
  if (!snapshot.session) return "Waiting for activity in this project…";
  const label = { waiting: "Waiting", working: "Working", idle: "Idle", interrupted: "Interrupted", "needs-input": "Waiting for input" }[snapshot.status];
  const seconds = snapshot.lastActivity ? Math.max(0, Math.floor((now - Date.parse(snapshot.lastActivity)) / 1000)) : 0;
  return `${label} · ${seconds < 10 ? "Just now" : seconds < 60 ? `${seconds}s ago` :
    seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`}`;
}
