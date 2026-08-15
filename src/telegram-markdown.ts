const DEFAULT_TELEGRAM_HTML_LIMIT = 3_900;

type BlockKind =
  | "code"
  | "heading"
  | "list-item"
  | "paragraph"
  | "quote"
  | "rule"
  | "table";

interface MarkdownBlock {
  kind: BlockKind;
  text: string;
  compactBefore?: boolean;
  language?: string;
  prefix?: string;
}

interface RenderedBlock {
  html: string;
  separator: "\n" | "\n\n";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function safeLink(value: string): string | null {
  const candidate = value.trim();
  if (candidate.length > 2_048) return null;
  try {
    const protocol = new URL(candidate).protocol.toLowerCase();
    return ["http:", "https:", "mailto:", "tg:"].includes(protocol)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function replaceProtected(
  source: string,
  pattern: RegExp,
  protectedHtml: string[],
  replacement: (...matches: string[]) => string,
): string {
  return source.replace(pattern, (...args: unknown[]) => {
    const matches = args.slice(0, -2).map(String);
    const html = replacement(...matches);
    const index = protectedHtml.push(html) - 1;
    return `\uE000${index}\uE001`;
  });
}

function renderInline(markdown: string, allowLinks = true): string {
  const protectedHtml: string[] = [];
  let source = markdown
    .replaceAll("\uE000", "�")
    .replaceAll("\uE001", "�")
    .replaceAll("\0", "�");

  source = replaceProtected(
    source,
    /(`+)([\s\S]*?)\1/g,
    protectedHtml,
    (_match, _ticks, code) => `<code>${escapeHtml(code.replace(/^ | $/g, ""))}</code>`,
  );

  source = replaceProtected(
    source,
    /\\([\\`*_[\]{}()#+.!|>~-])/g,
    protectedHtml,
    (_match, character) => escapeHtml(character),
  );

  if (allowLinks) {
    source = replaceProtected(
      source,
      /!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
      protectedHtml,
      (_match, label, destination) => {
        const href = safeLink(destination);
        const renderedLabel = renderInline(label || "изображение", false);
        return href
          ? `🖼 <a href="${escapeAttribute(href)}">${renderedLabel}</a>`
          : `🖼 ${renderedLabel}`;
      },
    );
    source = replaceProtected(
      source,
      /\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
      protectedHtml,
      (_match, label, destination) => {
        const href = safeLink(destination);
        const renderedLabel = renderInline(label, false);
        return href
          ? `<a href="${escapeAttribute(href)}">${renderedLabel}</a>`
          : `${renderedLabel} (${escapeHtml(destination)})`;
      },
    );
    source = replaceProtected(
      source,
      /<(https?:\/\/[^>\s]+|tg:\/\/[^>\s]+|mailto:[^>\s]+)>/g,
      protectedHtml,
      (_match, destination) => {
        const href = safeLink(destination);
        return href
          ? `<a href="${escapeAttribute(href)}">${escapeHtml(destination)}</a>`
          : escapeHtml(destination);
      },
    );
  }

  source = escapeHtml(source);
  const formats: Array<[RegExp, string, string]> = [
    [/\*\*([^\n*](?:[^\n]*?[^\n*])?)\*\*/g, "b", "b"],
    [/(?<!\w)__([^\n_](?:[^\n]*?[^\n_])?)__(?!\w)/g, "b", "b"],
    [/~~([^\n~](?:[^\n]*?[^\n~])?)~~/g, "s", "s"],
    [/\|\|([^\n|](?:[^\n]*?[^\n|])?)\|\|/g, "tg-spoiler", "tg-spoiler"],
    [/(?<!\*)\*([^\n*](?:[^\n]*?[^\n*])?)\*(?!\*)/g, "i", "i"],
    [/(?<!\w)_([^\n_](?:[^\n]*?[^\n_])?)_(?!\w)/g, "i", "i"],
  ];
  for (const [pattern, opening, closing] of formats) {
    source = replaceProtected(
      source,
      pattern,
      protectedHtml,
      (_match, body) => `<${opening}>${body}</${closing}>`,
    );
  }

  const placeholder = /\uE000(\d+)\uE001/g;
  for (let pass = 0; pass <= protectedHtml.length && source.includes("\uE000"); pass += 1) {
    source = source.replace(placeholder, (_match, index: string) => (
      protectedHtml[Number(index)] ?? "�"
    ));
  }
  return source;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isFence(line: string): RegExpMatchArray | null {
  return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
}

function listItem(line: string): { prefix: string; text: string } | null {
  const unordered = line.match(/^(\s*)[-+*]\s+(.*)$/);
  if (unordered) {
    const indent = "  ".repeat(Math.floor((unordered[1]?.length ?? 0) / 2));
    let text = unordered[2] ?? "";
    let marker = "•";
    const checkbox = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (checkbox) {
      marker = checkbox[1]?.toLowerCase() === "x" ? "☑" : "☐";
      text = checkbox[2] ?? "";
    }
    return { prefix: `${indent}${marker} `, text };
  }
  const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (!ordered) return null;
  const indent = "  ".repeat(Math.floor((ordered[1]?.length ?? 0) / 2));
  return { prefix: `${indent}${ordered[2]}. `, text: ordered[3] ?? "" };
}

function isRule(line: string): boolean {
  const compact = line.trim().replaceAll(" ", "");
  return /^(?:\*{3,}|-{3,}|_{3,})$/.test(compact);
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    !line.trim()
    || isFence(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || listItem(line)
    || isRule(line)
    || (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")),
  );
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  let separated = true;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      separated = true;
      index += 1;
      continue;
    }

    const fence = isFence(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const language = fence[2] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").match(
        new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`),
      )) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: body.join("\n"), language });
      separated = false;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const table: string[] = [line, lines[index + 1] ?? ""];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        table.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "table", text: table.join("\n") });
      separated = false;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] ?? "" });
      separated = false;
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      separated = false;
      continue;
    }

    const item = listItem(line);
    if (item) {
      blocks.push({
        kind: "list-item",
        text: item.text,
        prefix: item.prefix,
        compactBefore: !separated && blocks.at(-1)?.kind === "list-item",
      });
      separated = false;
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: "rule", text: "" });
      separated = false;
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    separated = false;
  }
  return blocks;
}

function renderTable(source: string): string {
  const rows = source.split("\n");
  const rendered = rows
    .filter((_row, index) => index !== 1)
    .map((row) => tableCells(row).join(" │ "));
  if (rendered.length > 1) {
    rendered.splice(1, 0, "─".repeat(Math.max(3, [...(rendered[0] ?? "")].length)));
  }
  return `<pre>${escapeHtml(rendered.join("\n"))}</pre>`;
}

function renderBlock(block: MarkdownBlock): string {
  switch (block.kind) {
    case "code": {
      const language = (block.language ?? "").match(/^[A-Za-z0-9_+.-]{1,40}$/)?.[0];
      const code = escapeHtml(block.text);
      return language
        ? `<pre><code class="language-${escapeAttribute(language)}">${code}</code></pre>`
        : `<pre>${code}</pre>`;
    }
    case "heading":
      return `<b>${renderInline(block.text)}</b>`;
    case "list-item":
      return `${escapeHtml(block.prefix ?? "• ")}${renderInline(block.text)}`;
    case "quote":
      return `<blockquote>${renderInline(block.text)}</blockquote>`;
    case "rule":
      return "────────";
    case "table":
      return renderTable(block.text);
    case "paragraph":
      return renderInline(block.text);
  }
}

interface OpenHtmlTag {
  name: string;
  opening: string;
  closing: string;
}

function closingTags(tags: OpenHtmlTag[]): string {
  return [...tags].reverse().map((tag) => tag.closing).join("");
}

function splitBalancedHtml(html: string, limit: number): string[] {
  if (html.length <= limit) return [html];
  const tokens = html.match(/<[^>]+>|&(?:lt|gt|amp|quot|#\d+|#x[\dA-Fa-f]+);|[\s\S]/gu) ?? [];
  const chunks: string[] = [];
  const openTags: OpenHtmlTag[] = [];
  const suppressedTags: string[] = [];
  let current = "";

  for (const token of tokens) {
    const opening = token.match(/^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>$/i);
    const closing = token.match(/^<\/([a-z][a-z0-9-]*)>$/i);
    const openingName = opening?.[1]?.toLowerCase() ?? "";
    const closingName = closing?.[1]?.toLowerCase() ?? "";
    if (opening && token.length + `</${openingName}>`.length > limit) {
      suppressedTags.push(openingName);
      continue;
    }
    if (closing && suppressedTags.at(-1) === closingName) {
      suppressedTags.pop();
      continue;
    }
    const prospective = [...openTags];
    if (opening) {
      prospective.push({
        name: openingName,
        opening: token,
        closing: `</${openingName}>`,
      });
    } else if (closing) {
      const position = prospective.findLastIndex((tag) => tag.name === closingName);
      if (position >= 0) prospective.splice(position, 1);
    }

    if (
      current
      && current.length + token.length + closingTags(prospective).length > limit
    ) {
      current += closingTags(openTags);
      chunks.push(current);
      current = openTags.map((tag) => tag.opening).join("");
    }

    current += token;
    if (opening) {
      openTags.push({
        name: openingName,
        opening: token,
        closing: `</${openingName}>`,
      });
    } else if (closing) {
      const position = openTags.findLastIndex((tag) => tag.name === closingName);
      if (position >= 0) openTags.splice(position, 1);
    }
  }
  if (current) chunks.push(`${current}${closingTags(openTags)}`);
  return chunks;
}

/**
 * Converts the GitHub-flavoured Markdown commonly produced by Codex into the
 * safe HTML subset supported by Telegram. Every returned chunk is independently
 * balanced and stays below Telegram's raw payload safety margin.
 */
export function markdownToTelegramHtmlChunks(
  markdown: string,
  limit = DEFAULT_TELEGRAM_HTML_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 128) {
    throw new RangeError("Telegram HTML chunk limit must be an integer of at least 128");
  }
  const source = markdown.trim();
  if (!source) return ["Готово."];
  const rendered: RenderedBlock[] = [];
  for (const block of parseBlocks(source)) {
    const pieces = splitBalancedHtml(renderBlock(block), limit);
    for (const [index, html] of pieces.entries()) {
      rendered.push({
        html,
        separator: index > 0 || block.compactBefore ? "\n" : "\n\n",
      });
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const block of rendered) {
    const separator = current ? block.separator : "";
    if (current && current.length + separator.length + block.html.length > limit) {
      chunks.push(current);
      current = block.html;
    } else {
      current += `${separator}${block.html}`;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["Готово."];
}
