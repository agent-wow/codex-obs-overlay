import { expect, test } from "bun:test";
import { inline, markdown } from "../src/web/markdown.js";

test("renders prose, lists, code and tables without losing command whitespace", () => {
  const nodes = markdown("## Route\n\n**Head east** and inspect `quest_id`.\n\n1. Move\n2. Inspect\n\n```python\nif ready:\n    move(1, 2)\n```\n\n| Name | State |\n| --- | --- |\n| Durokar | Ready |");
  expect(nodes.map((node) => node.tag)).toEqual(["h3", "p", "ol", "pre", "table"]);
  expect(nodes[3].children?.[0].text).toBe("if ready:\n    move(1, 2)");
  expect(nodes[1].children?.some((node) => node.tag === "strong")).toBe(true);
});

test("HTML and links remain inert, with no remote image loads or executable attributes", () => {
  const nodes = markdown('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[open](javascript:alert) ![image](https://example.com/image.png)');
  expect(nodes[0].children?.[0].text).toContain("<script>");
  const collect = (items: typeof nodes): string[] => items.flatMap((node) => [node.tag, ...collect(node.children ?? [])]);
  expect(collect(nodes)).not.toContain("script");
  expect(collect(nodes)).not.toContain("img");
  expect(collect(nodes)).not.toContain("a");
  expect(JSON.stringify(nodes)).not.toMatch(/"(?:src|href|onerror)":/);
});

test("large code blocks and plain messages are not shortened", () => {
  const text = "line\n".repeat(1000);
  expect(markdown(`\`\`\`\n${text}\`\`\``)[0].children?.[0].text).toBe(text.slice(0, -1));
  expect(inline("x".repeat(2000))[0].text).toHaveLength(2000);
});
