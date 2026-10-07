/** @typedef {{tag: string, text?: string, className?: string, title?: string, children?: MarkdownNode[]}} MarkdownNode */

/** Parse common Markdown into fixed, inert element types. Raw HTML is always text.
 * @param {string} text @param {number} [depth] @returns {MarkdownNode[]}
 */
export function inline(text, depth = 0) {
  if (depth > 6) return [{ tag: "span", text }];
  const pattern = /\\([\\`*_[\]{}()#+.!>-])|`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+)\*|!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)|\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g;
  /** @type {MarkdownNode[]} */
  const nodes = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > position) nodes.push({ tag: "span", text: text.slice(position, index) });
    if (match[1]) nodes.push({ tag: "span", text: match[1] });
    else if (match[2]) nodes.push({ tag: "code", text: match[2] });
    else if (match[3] || match[4]) nodes.push({ tag: "strong", children: inline(match[3] || match[4], depth + 1) });
    else if (match[5]) nodes.push({ tag: "del", children: inline(match[5], depth + 1) });
    else if (match[6]) nodes.push({ tag: "em", children: inline(match[6], depth + 1) });
    else if (match[7] !== undefined) nodes.push({ tag: "span", className: "reference", text: `Image: ${match[7] || "attachment"}` });
    else nodes.push({ tag: "span", className: "reference", title: match[11] || match[12], children: inline(match[10], depth + 1) });
    position = index + match[0].length;
  }
  if (position < text.length) nodes.push({ tag: "span", text: text.slice(position) });
  return nodes;
}

/** @param {string} text @returns {MarkdownNode[]} */
export function markdown(text) {
  const lines = text.split("\n");
  /** @type {MarkdownNode[]} */
  const nodes = [];
  const special = /^(?:\s*```|\s*~~~|#{1,6}\s|\s*>|\s*[-+*]\s|\s*\d+\.\s)/;
  const cells = (/** @type {string} */ line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const content = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) content.push(lines[i++]);
      if (i < lines.length) i++;
      nodes.push({ tag: "pre", children: [{ tag: "code", text: content.join("\n") }], title: fence[2].trim() });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { nodes.push({ tag: `h${Math.min(heading[1].length + 1, 6)}`, children: inline(heading[2]) }); i++; continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { nodes.push({ tag: "hr" }); i++; continue; }
    if (i + 1 < lines.length && line.includes("|") && cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const head = cells(line).map((cell) => ({ tag: "th", children: inline(cell) }));
      /** @type {MarkdownNode[]} */
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push({ tag: "tr", children: cells(lines[i++]).map((cell) => ({ tag: "td", children: inline(cell) })) });
      }
      nodes.push({ tag: "table", children: [{ tag: "thead", children: [{ tag: "tr", children: head }] }, { tag: "tbody", children: rows }] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const content = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) content.push(lines[i++].replace(/^\s*>\s?/, ""));
      nodes.push({ tag: "blockquote", children: inline(content.join("\n")) });
      continue;
    }
    const list = /^\s*([-+*]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      /** @type {MarkdownNode[]} */
      const children = [];
      while (i < lines.length) {
        const entry = /^\s*([-+*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!entry || /^\d/.test(entry[1]) !== ordered) break;
        children.push({ tag: "li", children: inline(entry[2]) });
        i++;
      }
      nodes.push({ tag: ordered ? "ol" : "ul", children });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !special.test(lines[i])) {
      if (i + 1 < lines.length && lines[i].includes("|") && cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) break;
      paragraph.push(lines[i++]);
    }
    nodes.push({ tag: "p", children: inline(paragraph.join("\n")) });
  }
  return nodes;
}

/** @param {Document} doc @param {MarkdownNode} node @returns {HTMLElement} */
function element(doc, node) {
  const el = doc.createElement(node.tag);
  if (node.text !== undefined) el.textContent = node.text;
  if (node.className) el.className = node.className;
  if (node.title) el.title = node.title;
  for (const child of node.children ?? []) el.append(element(doc, child));
  return el;
}

/** @param {HTMLElement} parent @param {string} text */
export function renderMarkdown(parent, text) {
  for (const node of markdown(text)) parent.append(element(parent.ownerDocument, node));
}
