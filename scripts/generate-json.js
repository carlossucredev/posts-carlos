#!/usr/bin/env node

/**
 * generate-json.js
 * Reads all Markdown posts, extracts front matter,
 * converts content to HTML, and outputs dist/posts.json
 */

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Front matter parser
// ---------------------------------------------------------------------------

function parseFrontMatter(raw) {
  const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = raw.match(FM_REGEX);
  if (!match) return { data: {}, content: raw };

  const yamlBlock       = match[1];
  const markdownContent = match[2];

  const data  = {};
  const lines = yamlBlock.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line     = lines[i];
    const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const key  = keyMatch[1];
    const rest = keyMatch[2].trim();

    // Array value — next lines start with "- "
    if (rest === "") {
      const arr = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+-\s+/)) {
        arr.push(lines[i].replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, ""));
        i++;
      }
      data[key] = arr;
      continue;
    }

    // Inline array: ["a", "b"]
    if (rest.startsWith("[")) {
      try { data[key] = JSON.parse(rest.replace(/'/g, '"')); }
      catch { data[key] = rest; }
      i++;
      continue;
    }

    if (rest === "true")  { data[key] = true;  i++; continue; }
    if (rest === "false") { data[key] = false; i++; continue; }

    if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) { data[key] = rest; i++; continue; }

    data[key] = rest.replace(/^["']|["']$/g, "");
    i++;
  }

  return { data, content: markdownContent };
}

// ---------------------------------------------------------------------------
// Markdown to HTML converter
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Extracts a URL from inside ( ) supporting nested parentheses.
// Example: https://cdn.com/filters:cover()/img.jpg
function extractUrl(str, startIndex) {
  let depth = 0;
  let i     = startIndex;
  let url   = "";
  while (i < str.length) {
    const ch = str[i];
    if (ch === "(")      { depth++; url += ch; }
    else if (ch === ")") {
      if (depth === 0) break; // end of Markdown link syntax
      depth--;
      url += ch;
    } else {
      url += ch;
    }
    i++;
  }
  return { url, end: i };
}

// Replaces ![alt](url) and [text](url) handling URLs with parentheses inside.
function replaceMarkdownLinks(html) {
  let result = "";
  let i      = 0;

  while (i < html.length) {
    // Image: ![alt](url)
    if (html[i] === "!" && html[i + 1] === "[") {
      const altStart = i + 2;
      const altEnd   = html.indexOf("]", altStart);
      if (altEnd !== -1 && html[altEnd + 1] === "(") {
        const alt        = html.slice(altStart, altEnd);
        const { url, end } = extractUrl(html, altEnd + 2);
        result += `<img src="${url}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;margin:16px 0;">`;
        i = end + 1;
        continue;
      }
    }

    // Link: [text](url) — skip if preceded by ! (already handled as image)
    if (html[i] === "[" && (i === 0 || html[i - 1] !== "!")) {
      const textStart = i + 1;
      const textEnd   = html.indexOf("]", textStart);
      if (textEnd !== -1 && html[textEnd + 1] === "(") {
        const text       = html.slice(textStart, textEnd);
        const { url, end } = extractUrl(html, textEnd + 2);
        result += `<a href="${url}">${text}</a>`;
        i = end + 1;
        continue;
      }
    }

    result += html[i];
    i++;
  }

  return result;
}

function markdownToHtml(md) {
  let html = md
    // Fenced code blocks — processed first to protect inner content
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.trim())}</code></pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`)
    // Headings
    .replace(/^#{4}\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^#{3}\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^#{2}\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#{1}\s+(.+)$/gm,  "<h1>$1</h1>")
    // Bold & italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g,     "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,         "<em>$1</em>")
    // Unordered list items
    .replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>")
    // Horizontal rule
    .replace(/^---$/gm, "<hr>");

  // Images and links — separate pass to support URLs with nested parentheses
  html = replaceMarkdownLinks(html);

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, block => `<ul>${block}</ul>`);

  // Wrap plain text blocks in <p>
  html = html
    .split(/\n{2,}/)
    .map(block => {
      block = block.trim();
      if (!block) return "";
      if (/^<(h[1-6]|ul|ol|li|pre|hr|blockquote|img)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");

  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const POSTS_DIR   = path.join(__dirname, "../content/posts");
const DIST_DIR    = path.join(__dirname, "../dist");
const OUTPUT_FILE = path.join(DIST_DIR, "posts.json");

function generateJson() {
  console.log("Reading posts from:", POSTS_DIR);

  if (!fs.existsSync(POSTS_DIR)) {
    console.error("Posts directory not found:", POSTS_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith(".md"));
  console.log(`Found ${files.length} post(s)`);

  const posts = files
    .map(filename => {
      const raw             = fs.readFileSync(path.join(POSTS_DIR, filename), "utf-8");
      const { data, content } = parseFrontMatter(raw);

      if (data.draft === true) {
        console.log(`  Skipping draft: ${filename}`);
        return null;
      }

      const post = {
        title:    data.title    || "",
        slug:     data.slug     || filename.replace(".md", ""),
        date:     data.date     || "",
        summary:  data.summary  || "",
        tags:     Array.isArray(data.tags) ? data.tags : [],
        featured: data.featured === true,
        content:  markdownToHtml(content),
      };

      console.log(`  Processed: ${post.slug}`);
      return post;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(posts, null, 2), "utf-8");
  console.log(`Generated: ${OUTPUT_FILE} (${posts.length} posts)`);
}

generateJson();
