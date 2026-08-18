import assert from "node:assert/strict";
import test from "node:test";
import { markdownToTelegramHtmlChunks } from "../src/telegram-markdown.js";

const allowedTags = new Set([
  "a",
  "b",
  "blockquote",
  "code",
  "i",
  "pre",
  "s",
  "tg-spoiler",
]);

function assertBalancedTelegramHtml(html: string, limit: number): void {
  assert.ok(html.length <= limit, `HTML chunk is ${html.length} characters`);
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
    const tag = match[1]?.toLowerCase() ?? "";
    assert.ok(allowedTags.has(tag), `unsupported Telegram HTML tag: ${tag}`);
    if (match[0].startsWith("</")) {
      assert.equal(stack.pop(), tag, `unbalanced closing tag: ${tag}`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, []);
}

test("renders common agent Markdown as safe Telegram HTML", () => {
  const markdown = [
    "# Результат",
    "",
    "**Готово**: *проверил* `src/runtime.ts` и [документацию](https://example.com?a=1&b=2).",
    "",
    "- первый пункт",
    "- [x] второй пункт",
    "",
    "> Важное примечание",
    "",
    "~~старое~~ и ||секрет||",
  ].join("\n");

  assert.deepEqual(markdownToTelegramHtmlChunks(markdown), [
    [
      "<b>Результат</b>",
      "",
      "<b>Готово</b>: <i>проверил</i> <code>src/runtime.ts</code> и " +
        '<a href="https://example.com?a=1&amp;b=2">документацию</a>.',
      "",
      "• первый пункт",
      "☑ второй пункт",
      "",
      "<blockquote>Важное примечание</blockquote>",
      "",
      "<s>старое</s> и <tg-spoiler>секрет</tg-spoiler>",
    ].join("\n"),
  ]);
});

test("escapes raw HTML, code and unsafe link destinations", () => {
  const markdown = [
    "сырой <b>HTML</b> & текст",
    "",
    "[не открывать](javascript:alert)",
    "",
    "```ts",
    "const value = `<script>&`;",
    "```",
  ].join("\n");

  const [html] = markdownToTelegramHtmlChunks(markdown);
  assert.ok(html);
  assert.match(html, /сырой &lt;b&gt;HTML&lt;\/b&gt; &amp; текст/);
  assert.match(html, /не открывать \(javascript:alert\)/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(
    html,
    /<pre><code class="language-ts">const value = `&lt;script&gt;&amp;`;<\/code><\/pre>/,
  );
  assertBalancedTelegramHtml(html, 3_900);
});

test("renders GitHub-style tables as readable preformatted text", () => {
  const markdown = [
    "| Project | Owner |",
    "| --- | --- |",
    "| summing | Anton |",
  ].join("\n");
  assert.deepEqual(markdownToTelegramHtmlChunks(markdown), [
    "<pre>Project │ Owner\n───────────────\nsumming │ Anton</pre>",
  ]);
});

test("renders an escaped expandable transcript before the response", () => {
  assert.deepEqual(
    markdownToTelegramHtmlChunks("**Ответ**", 3_900, {
      title: "🎙 Транскрипция «voice.ogg»",
      text: "Слышно <плохо> & неточно",
    }),
    [
      "<blockquote expandable><b>🎙 Транскрипция «voice.ogg»</b>\n" +
        "Слышно &lt;плохо&gt; &amp; неточно\n</blockquote>\n\n<b>Ответ</b>",
    ],
  );
});

test("renders multiple expandable sections in their declared order", () => {
  assert.deepEqual(
    markdownToTelegramHtmlChunks("Финал", 3_900, [
      { title: "Ход работы · 2 мин 5 сек", text: "Проверил сборку" },
      { title: "🎙 Транскрипция", text: "Текст аудио" },
    ]),
    [
      "<blockquote expandable><b>Ход работы · 2 мин 5 сек</b>\n" +
        "Проверил сборку\n</blockquote>\n\n" +
        "<blockquote expandable><b>🎙 Транскрипция</b>\n" +
        "Текст аудио\n</blockquote>\n\nФинал",
    ],
  );
});

test("renders a trailing expandable section after the response", () => {
  assert.deepEqual(
    markdownToTelegramHtmlChunks(
      "**Финал**",
      3_900,
      { title: "🎙 Транскрипция", text: "Текст аудио" },
      { title: "Ход работы · 2 мин 5 сек", text: "Проверил сборку" },
    ),
    [
      "<blockquote expandable><b>🎙 Транскрипция</b>\n" +
        "Текст аудио\n</blockquote>\n\n" +
        "<b>Финал</b>\n\n" +
        "<blockquote expandable><b>Ход работы · 2 мин 5 сек</b>\n" +
        "Проверил сборку\n</blockquote>",
    ],
  );
});

test("long formatted answers are split into independently balanced chunks", () => {
  const limit = 180;
  const markdown = [
    `**${"важный текст ".repeat(120)}**`,
    "",
    "```typescript",
    "const escaped = '<tag>&';\n".repeat(80),
    "```",
    "",
    "😀".repeat(200),
  ].join("\n");
  const chunks = markdownToTelegramHtmlChunks(markdown, limit);

  assert.ok(chunks.length > 3);
  for (const chunk of chunks) assertBalancedTelegramHtml(chunk, limit);
  assert.ok(chunks.some((chunk) => chunk.startsWith("<b>") && chunk.endsWith("</b>")));
  assert.ok(chunks.some((chunk) => (
    chunk.startsWith('<pre><code class="language-typescript">')
    && chunk.endsWith("</code></pre>")
  )));
  assert.doesNotMatch(chunks.join(""), /<tag>/);
});

test("rejects an unusably small or non-integer chunk limit", () => {
  assert.throws(() => markdownToTelegramHtmlChunks("ok", 127), /at least 128/);
  assert.throws(() => markdownToTelegramHtmlChunks("ok", 180.5), /at least 128/);
});
