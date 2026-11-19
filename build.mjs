#!/usr/bin/env node
/**
 * Build the site: catalog.json + src/ → dist/, a folder of plain files that
 * works on any static host and straight from disk.
 *
 *   dist/index.html        the whole site: styles, script and catalog inlined,
 *                          first 40 plugins already rendered in the HTML
 *   dist/favicon.svg, og.jpg
 *
 * Makes no network calls; refresh the catalog with `npm run fetch`.
 * Set SITE_URL (https://example.com/racklist) to emit the share-card image tag,
 * which needs an absolute URL.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as render from "./src/render.js";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(at(path), "utf8");

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(read("catalog.json"));
} catch (err) {
  fail(`cannot read catalog.json (${err.message}) — run "npm run fetch" first.`);
}
if (!Array.isArray(catalog?.plugins) || catalog.plugins.length === 0) {
  fail("the catalog has no plugins — refusing to build an empty site.");
}

const state = render.initialState();
const view = render.listView(catalog, state);
const siteUrl = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");

// Scrapers want an absolute og:image; without SITE_URL a relative one still
// resolves against the page URL in most modern link unfurlers.
const ogImage = siteUrl ? `${siteUrl}/og.jpg` : "og.jpg";

// Safe inside <script>: "<" and every non-ASCII character become \uXXXX escapes,
// so nothing in the data can end the block early.
const data = JSON.stringify(catalog).replace(
  /[^ -~]|</g,
  (char) => "\\" + "u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
);
const script = [
  `let catalog = ${data};`,
  read("src/render.js").replace(/^export /gm, ""),
  read("src/app.js"),
].join("\n");

const slots = {
  "/*style*/": read("src/style.css"),
  "/*script*/": script,
  "<!--og-image-->":
    `<meta property="og:image" content="${render.esc(ogImage)}">` +
    `<meta name="twitter:image" content="${render.esc(ogImage)}">` +
    (siteUrl
      ? `<meta property="og:url" content="${render.esc(siteUrl)}/"><link rel="canonical" href="${render.esc(siteUrl)}/">`
      : ""),
  "<!--stats-->": render.statsHtml(catalog),
  "<!--kinds-->": render.kindChipsHtml(state),
  "<!--sources-->": render.sourceChipsHtml(state),
  "<!--blogs-->": view.blogs,
  "<!--count-->": view.count,
  "<!--list-->": view.list,
  "<!--more-->": view.more,
  "<!--detail-->": render.DETAIL_PLACEHOLDER,
  "<!--footer-->": render.footerHtml(catalog),
};

let html = read("src/page.html");
for (const [slot, value] of Object.entries(slots)) {
  const parts = html.split(slot);
  if (parts.length !== 2) fail(`src/page.html must contain ${slot} exactly once.`);
  html = parts.join(value);
}

rmSync(at("dist"), { recursive: true, force: true });
mkdirSync(at("dist"));
cpSync(at("static"), at("dist"), { recursive: true });
writeFileSync(at("dist/index.html"), html);

const size = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
console.log(`[build] dist/ is ready — ${catalog.plugins.length} plugins, index.html ${size} MB`);
