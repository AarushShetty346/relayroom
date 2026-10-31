import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/components/ui";

const html = (text: string) =>
  renderToStaticMarkup(createElement(RichText, { text, agentHandles: new Set(["claude"]), userHandles: new Set(["aarush"]) }));

describe("RichText", () => {
  it("renders an agent's Markdown reply instead of literal asterisks", () => {
    const out = html(
      "`src/price.js` exports one function.\n\n- **What it does:** formats paise\n- **Tests:** one test\n\nI only read the files.",
    );
    expect(out).toBe(
      '<div class="msg-text"><p><code>src/price.js</code> exports one function.</p>' +
        "<ul><li><strong>What it does:</strong> formats paise</li><li><strong>Tests:</strong> one test</li></ul>" +
        "<p>I only read the files.</p></div>",
    );
  });

  it("handles numbered lists, headings, italics and https links", () => {
    expect(html("## Plan\n1. read\n2. *edit*\nSee [docs](https://example.com/a).")).toBe(
      '<div class="msg-text"><p class="md-h">Plan</p><ol start="1"><li>read</li><li><em>edit</em></li></ol>' +
        '<p>See <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>.</p></div>',
    );
  });

  it("leaves arithmetic, snake_case and code alone", () => {
    expect(html("2 * 3 * 4 and my_var_name and `a ** b`")).toBe(
      '<div class="msg-text"><p>2 * 3 * 4 and my_var_name and <code>a ** b</code></p></div>',
    );
  });

  it("never produces raw HTML or non-http links", () => {
    const out = html('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **<b>hi</b>**');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain('href="javascript');
    expect(out).toContain("&lt;img");
  });

  it("keeps code fences, mentions and line breaks", () => {
    expect(html("@claude run it\nthen @nobody\n```js\nconst a = **b**;\n```")).toBe(
      '<div class="msg-text"><p><span class="mention agent">@claude</span> run it\nthen @nobody</p>' +
        "<pre><code>const a = **b**;</code></pre></div>",
    );
  });
});
