import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const relativeHtml = renderMarkdown("[file](components/MarkdownBody.tsx)");
  const fileUrlHtml = renderMarkdown("[report](file:///home/me/project/report.html)");

  assert.match(relativeHtml, /<a href="components\/MarkdownBody\.tsx"[^>]*>file<\/a>/);
  assert.doesNotMatch(relativeHtml, /target=|rel=|\snode=/);
  assert.match(fileUrlHtml, /<a href="file:\/\/\/home\/me\/project\/report\.html"[^>]*>report<\/a>/);
  assert.doesNotMatch(fileUrlHtml, /target=|rel=|\snode=/);
});

test("opens Windows drive markdown links in the app with URL-safe hrefs", () => {
  const html = renderMarkdown("[耦合逻辑.json](C:/Users/WJZN/Downloads/耦合逻辑.json)");
  const spacedHtml = renderMarkdown("[项目 文档](<C:/Users/WJZN/Downloads/项目 文档#1?.json>)");
  const backslashHtml = renderMarkdown(String.raw`[report](<C:\Users\WJZN\Downloads\report.json>)`);

  assert.match(html, /<a href="file:\/\/\/C:\/Users\/WJZN\/Downloads\/%E8%80%A6%E5%90%88%E9%80%BB%E8%BE%91\.json"[^>]*>耦合逻辑\.json<\/a>/);
  assert.doesNotMatch(html, /target=|rel=/);
  assert.match(spacedHtml, /<a href="file:\/\/\/C:\/Users\/WJZN\/Downloads\/%E9%A1%B9%E7%9B%AE%20%E6%96%87%E6%A1%A3%231%3F\.json"[^>]*>项目 文档<\/a>/);
  assert.doesNotMatch(spacedHtml, /target=|rel=/);
  assert.match(backslashHtml, /<a href="file:\/\/\/C:\/Users\/WJZN\/Downloads\/report\.json"[^>]*>report<\/a>/);
  assert.doesNotMatch(backslashHtml, /target=|rel=/);
});

test("does not double-encode spaces, Chinese or literal percent escapes in Windows hrefs", () => {
  const cases = [
    ["C:/Users/WJZN/Desktop/Pi%20Desktop%20添加%20GPT-6.1%20Sol%20模型教程.md", "Pi%20Desktop%20%E6%B7%BB%E5%8A%A0%20GPT-6.1%20Sol%20%E6%A8%A1%E5%9E%8B%E6%95%99%E7%A8%8B.md"],
    ["C:/Users/me/%E4%B8%AD%E6%96%87%20report.md", "%E4%B8%AD%E6%96%87%20report.md"],
    ["C:/Users/me/literal%2520.md", "literal%2520.md"],
    ["C:/Users/me/bad%escape.md", "bad%25escape.md"],
  ];
  for (const [href, name] of cases) {
    const html = renderMarkdown(`[file](${href})`);
    assert.ok(html.includes(`/${name}\"`), html);
    assert.doesNotMatch(html, /target=|rel=/);
  }
});

test("keeps file URIs as in-app links", () => {
  const html = renderMarkdown("[report](file:///C:/Users/WJZN/Downloads/report.html)");

  assert.match(html, /<a href="file:\/\/\/C:\/Users\/WJZN\/Downloads\/report\.html"[^>]*>report<\/a>/);
  assert.doesNotMatch(html, /target=|rel=/);
});

test("keeps Windows drive links inert without an in-app file handler", () => {
  const html = renderMarkdown("[file](C:/Users/WJZN/Downloads/file.json)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">file<\/a>/);
});

test("does not allow unsafe schemes through the local-link transform", () => {
  const javascriptHtml = renderMarkdown("[run](javascript:alert(1))");
  const customHtml = renderMarkdown("[custom](custom:/C:/Users/WJZN/Downloads/file.json)");
  const httpHtml = renderMarkdown("[web](http://example.com/report.json)");

  assert.match(javascriptHtml, /<a target="_blank" rel="noopener noreferrer">run<\/a>/);
  assert.match(customHtml, /<a target="_blank" rel="noopener noreferrer">custom<\/a>/);
  assert.match(httpHtml, /<a href="http:\/\/example\.com\/report\.json" target="_blank" rel="noopener noreferrer">web<\/a>/);
});

test("keeps file URLs inert without an in-app file handler", () => {
  const html = renderMarkdown("[report](file:///home/me/project/report.html)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">report<\/a>/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders backslash-escaped backticks inside inline code", () => {
  const html = renderMarkdown("`AudioManager\\`1.cs`");

  assert.match(html, /<code[^>]*>AudioManager`1\.cs<\/code>/);
  assert.doesNotMatch(html, /<\/code>1\.cs`/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("renders model-emitted bracket-only formula lines as display math", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\sum/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("previews completed Mermaid diagrams by default", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");

  assert.match(html, /mermaid-block-loading/);
  assert.match(html, />Source</);
  assert.doesNotMatch(html, /A --&gt; B/);
});

test("keeps Mermaid source visible while the response is streaming", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", { isStreaming: true });

  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, />Preview</);
  assert.match(html, /A --&gt; B/);
});
