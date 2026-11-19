/**
 * Everything that turns the catalog into HTML. Pure functions, no DOM.
 *
 * build.mjs imports this file to prerender the first screen, and inlines the
 * same source into the page so the browser re-renders with identical code.
 */

export const PAGE = 40;

export const FORMATS = ["vst3", "clap", "lv2", "au", "vst", "aax"];
export const FORMAT_LABEL = { vst3: "VST3", vst: "VST", clap: "CLAP", lv2: "LV2", au: "AU", aax: "AAX" };
export const KIND_LABEL = {
  instrument: "Instrument",
  effect: "Effect",
  tool: "Tool",
  generator: "Generator",
  sampler: "Sampler",
  plugin: "Plugin",
};
export const SYSTEM_LABEL = { mac: "macOS", win: "Windows", linux: "Linux" };

export const KIND_FILTERS = [
  ["all", "All"],
  ["instrument", "Instruments"],
  ["effect", "Effects"],
  ["tool", "Tools"],
];
export const SOURCE_FILTERS = [
  ["all", "Any source"],
  ["registry", "Registry"],
  ["github", "GitHub"],
  ["blog", "Blogs"],
];

export const ICON_STAR =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 4 1.8 4.6 5 .4-3.8 3.2 1.2 4.8L12 14.8 7.8 17l1.2-4.8L5.2 9l5-.4Z" stroke-linejoin="round"/></svg>';
export const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function initialState() {
  return { query: "", kind: "all", source: "all", formats: [], sort: "stars", visible: PAGE, selectedId: null };
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** The catalog comes from third parties: only http(s) links reach the page. */
export function safeUrl(url) {
  return /^https?:\/\//i.test(url || "") ? esc(url) : "#";
}

export function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function bytes(size) {
  if (!size) return "";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function when(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  // UTC, so the prerendered HTML and the visitor's browser agree on the day.
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function kindGroup(kind) {
  if (kind === "instrument" || kind === "sampler" || kind === "generator") return "instrument";
  return kind === "effect" || kind === "tool" ? kind : "other";
}

function sourceLabel(plugin) {
  if (plugin.source === "blog") return plugin.mentions?.[0]?.blog || "Blog";
  if (plugin.source === "both") return "Registry + GitHub";
  return plugin.source === "registry" ? "Registry" : "GitHub";
}

function matchesQuery(plugin, query) {
  if (!query) return true;
  const haystack = [
    plugin.name,
    plugin.author,
    plugin.description,
    plugin.repo,
    plugin.license,
    plugin.language,
    ...(plugin.tags || []),
    ...(plugin.topics || []),
    ...(plugin.formats || []),
    ...(plugin.mentions || []).flatMap((mention) => [mention.blog, mention.title]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part));
}

function comparePlugins(sort) {
  return (a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "downloads") return b.downloads - a.downloads || a.name.localeCompare(b.name);
    if (sort === "updated") {
      return (b.updated || b.date || "").localeCompare(a.updated || a.date || "") || a.name.localeCompare(b.name);
    }
    return (b.stars ?? -1) - (a.stars ?? -1) || b.downloads - a.downloads || a.name.localeCompare(b.name);
  };
}

export function filterPlugins(plugins, state) {
  const query = state.query.trim();
  return plugins
    .filter((plugin) => {
      const mentions = plugin.mentions || [];
      if (state.kind !== "all" && kindGroup(plugin.kind) !== state.kind) return false;
      if (state.source === "registry" && plugin.source !== "registry" && plugin.source !== "both") return false;
      if (state.source === "github" && plugin.source !== "github" && plugin.source !== "both") return false;
      if (state.source === "blog" && plugin.source !== "blog" && mentions.length === 0) return false;
      if (state.formats.length && !state.formats.some((format) => (plugin.formats || []).includes(format))) return false;
      return matchesQuery(plugin, query);
    })
    .sort(comparePlugins(state.sort));
}

function chip(filter, value, label, on) {
  return `<button type="button" class="arcade chip" data-filter="${filter}" data-value="${value}" aria-pressed="${on}">${label}</button>`;
}

export function kindChipsHtml(state) {
  return [
    ...KIND_FILTERS.map(([id, label]) => chip("kind", id, label, state.kind === id)),
    '<span class="divider" aria-hidden="true"></span>',
    ...FORMATS.map((format) => chip("format", format, FORMAT_LABEL[format], state.formats.includes(format))),
  ].join("");
}

export function sourceChipsHtml(state) {
  return SOURCE_FILTERS.map(([id, label]) => chip("source", id, label, state.source === id)).join("");
}

export function statsHtml(catalog) {
  return [
    ["In the list", catalog.counts.total],
    ["VST3", catalog.counts.vst3],
    ["CLAP", catalog.counts.clap],
    ["From the blogs", catalog.counts.blog],
  ]
    .map(([label, value]) => `<div class="panel stat"><dt>${label}</dt><dd>${compact(value)}</dd></div>`)
    .join("");
}

export function footerHtml(catalog) {
  const { blogs = [], pagesPerQuery, perPage, batchSize } = catalog.criteria;
  return esc(
    `Built from the Open Audio Registry, GitHub, and ${blogs.join(", ")}. GitHub has no star minimum. ` +
      `LV2-only projects and JUCE templates are left out. ${pagesPerQuery} pages of ${perPage} per topic, ` +
      `normalized in batches of ${batchSize}.`,
  );
}

function formatTags(plugin) {
  if (!plugin.formats?.length) return '<span class="small faint">Format not listed</span>';
  return plugin.formats
    .map((format) => `<span class="tag format-tag" data-format="${esc(format)}">${esc(FORMAT_LABEL[format] || format)}</span>`)
    .join("");
}

function rowHtml(plugin, selectedId) {
  const score =
    plugin.source === "blog"
      ? `<span class="small muted">${esc(sourceLabel(plugin))}</span>`
      : `<span class="faint">${ICON_STAR}</span>${plugin.stars == null ? "—" : compact(plugin.stars)}`;
  return (
    `<li class="plugin-row"><button type="button" class="card hit" data-plugin="${esc(plugin.id)}" data-selected="${plugin.id === selectedId}">` +
    `<span class="top"><span class="who"><span class="name">${esc(plugin.name)}</span>` +
    `<span class="by muted">${esc(plugin.author)}<span class="faint"> · ${esc(KIND_LABEL[plugin.kind] || plugin.kind)}</span></span></span>` +
    `<span class="stars">${score}</span></span>` +
    (plugin.description ? `<span class="desc">${esc(plugin.description)}</span>` : "") +
    `<span class="chips">${formatTags(plugin)}</span></button></li>`
  );
}

function blogCardHtml(plugin, selectedId) {
  return (
    `<li><button type="button" class="featured hit" data-plugin="${esc(plugin.id)}" data-selected="${plugin.id === selectedId}">` +
    `<span class="small muted">${esc(sourceLabel(plugin))}</span><span class="name">${esc(plugin.name)}</span>` +
    `<span class="by muted">${when(plugin.date)}</span></button></li>`
  );
}

/** The parts of the list that change with the filters. */
export function listView(catalog, state) {
  const rows = filterPlugins(catalog.plugins, state);
  const finds =
    state.source === "blog"
      ? []
      : rows
          .filter((plugin) => plugin.source === "blog")
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
          .slice(0, 4);
  const left = Math.max(0, rows.length - state.visible);
  return {
    blogs: finds.length
      ? `<p class="label muted">New from the blogs</p><ul class="blog-grid">${finds.map((plugin) => blogCardHtml(plugin, state.selectedId)).join("")}</ul>`
      : "",
    count: `${rows.length} ${rows.length === 1 ? "plugin" : "plugins"}<span class="faint"> · list built ${when(catalog.generatedAt)}</span>`,
    list: rows.length
      ? rows
          .slice(0, state.visible)
          .map((plugin) => rowHtml(plugin, state.selectedId))
          .join("")
      : '<li class="panel empty"><p class="title">Nothing on this shelf</p><p class="muted">Try another format, or clear the search.</p></li>',
    left,
    more: `Show more · ${left} left`,
  };
}

export const DETAIL_PLACEHOLDER =
  '<div class="panel placeholder"><p class="title">Pick a plugin</p><p class="muted">Formats, downloads and the repo sit in this panel.</p></div>';

export function detailHtml(plugin) {
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const labels = plugin.tags?.length ? plugin.tags : plugin.topics || [];
  const notes = [plugin.verified ? "Verified package" : "", plugin.archived ? "Archived repo" : "", plugin.language || ""].filter(Boolean);
  const mentions = plugin.source === "blog" ? [] : plugin.mentions || [];
  const files = (plugin.files || []).slice(0, 6).map((file) => {
    const formats = file.formats?.length ? file.formats.map((format) => FORMAT_LABEL[format] || format) : ["File"];
    const systems = (file.systems || []).map((system) => SYSTEM_LABEL[system] || system);
    return (
      `<a class="file" href="${safeUrl(file.url)}" target="_blank" rel="noreferrer">` +
      `<span class="clip">${esc(formats.join(" / ") + (systems.length ? ` · ${systems.join(", ")}` : ""))}</span>` +
      `<span class="muted">${bytes(file.size)}</span></a>`
    );
  });
  return (
    '<article class="featured detail">' +
    '<button type="button" class="close" data-close>Close</button>' +
    (plugin.image ? `<img class="shot" alt="" src="${safeUrl(plugin.image)}">` : "") +
    `<p class="muted">${esc(sourceLabel(plugin))}</p>` +
    `<h2>${esc(plugin.name)}</h2><p class="muted">${esc(plugin.author)}</p>` +
    (plugin.description ? `<p class="about">${esc(plugin.description)}</p>` : "") +
    '<dl class="facts">' +
    fact("Kind", KIND_LABEL[plugin.kind] || plugin.kind) +
    fact("Version", plugin.version || "—") +
    fact("Stars", plugin.stars == null ? "—" : compact(plugin.stars)) +
    fact("Downloads", plugin.downloads ? compact(plugin.downloads) : "—") +
    fact("License", plugin.license || "—") +
    fact("Updated", when(plugin.updated || plugin.date)) +
    "</dl>" +
    (plugin.systems?.length
      ? `<p class="muted note">${esc(plugin.systems.map((system) => SYSTEM_LABEL[system] || system).join(" · "))}</p>`
      : "") +
    (notes.length ? `<p class="muted note">${esc(notes.join(" · "))}</p>` : "") +
    (labels.length ? `<ul class="chips">${labels.map((tag) => `<li class="tag">${esc(tag)}</li>`).join("")}</ul>` : "") +
    (mentions.length
      ? `<ul class="mentions">${mentions
          .map((mention) => `<li><a href="${safeUrl(mention.url)}" target="_blank" rel="noreferrer">Also covered by ${esc(mention.blog)}</a></li>`)
          .join("")}</ul>`
      : "") +
    '<div class="stack">' +
    `<a class="arcade blue" href="${safeUrl(plugin.url)}" target="_blank" rel="noreferrer">Open ${plugin.source === "blog" ? "the post" : "project"}${ICON_EXTERNAL}</a>` +
    files.join("") +
    "</div>" +
    (plugin.audio ? `<audio controls preload="none" src="${safeUrl(plugin.audio)}">Preview</audio>` : "") +
    "</article>"
  );
}
