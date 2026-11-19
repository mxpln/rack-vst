/**
 * Build a normalized list of DAW plugins (VST, VST3, CLAP, AU, AAX).
 *
 * Sources
 *   1. Open Audio Stack registry (StudioRack index) — installable packages
 *   2. GitHub topics vst, vst3, vst3-plugin, audio-plugin, clap-plugin
 *   3. Bedroom Producers Blog, Splice Blog, and LANDR Blog — newly covered plugins
 *
 * LV2-only projects and JUCE templates are left out. There is no star minimum.
 *
 * Uses nothing but fetch(). Run from Node by fetch-plugins.mjs (the update-catalog
 * GitHub Action).
 */

const BATCH_SIZE = 100;
const STUDIORACK_URL =
  "https://open-audio-stack.github.io/open-audio-stack-registry/index.json";
const GITHUB_TOPICS = [
  "topic:vst3",
  "topic:vst",
  "topic:vst3-plugin",
  "topic:audio-plugin",
  "topic:clap-plugin",
];
const PAGES_PER_QUERY = 8;
const PER_PAGE = 50;
const BLOG_PAGES = 2;
const BLOG_PER_PAGE = 20;
const BLOG_SOURCES = [
  {
    id: "bedroomproducersblog",
    name: "Bedroom Producers Blog",
    url: "https://bedroomproducersblog.com/wp-json/wp/v2/posts",
    category: 9,
  },
  {
    id: "splice",
    name: "Splice Blog",
    url: "https://splice.com/blog/wp-json/wp/v2/posts",
    searches: ["plugin", "vst", "synth", "instrument"],
  },
  {
    id: "landr",
    name: "LANDR Blog",
    pages: ["https://blog.landr.com/", "https://blog.landr.com/category/best-plugins/"],
  },
];

const REQUEST_TIMEOUT_MS = 25_000;

const DAW_FORMATS = new Set(["vst3", "vst", "clap", "au", "aax"]);
const KINDS = new Set(["instrument", "effect", "tool", "generator", "sampler"]);

/** Settings of the run in progress; set by fetchCatalog(). */
let run = { token: "", log: () => {}, signal: undefined, userAgent: "" };

function requestSignal() {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return run.signal ? AbortSignal.any([run.signal, timeout]) : timeout;
}

/**
 * A browser sends its own User-Agent, and any header beyond Accept would turn
 * these into preflighted requests that the registry and the blogs refuse.
 */
function requestHeaders(accept, extra = {}) {
  return { ...(run.userAgent ? { "User-Agent": run.userAgent } : {}), Accept: accept, ...extra };
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const signal = run.signal;
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    signal: requestSignal(),
    headers: requestHeaders("application/json", headers),
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`${response.status} ${url} ${body.slice(0, 180)}`);
    error.status = response.status;
    error.headers = response.headers;
    if (response.status === 400 && response.headers.get("content-type")?.includes("application/json")) {
      try {
        error.body = JSON.parse(body);
      } catch {
        // Keep the original HTTP error when the error body is malformed.
      }
    }
    throw error;
  }
  return { json: await response.json(), headers: response.headers };
}

async function loadRegistry() {
  const { json } = await fetchJson(STUDIORACK_URL);
  if (!json?.plugins || typeof json.plugins !== "object" || Array.isArray(json.plugins) ||
      Object.keys(json.plugins).length === 0) {
    throw new Error("Open Audio Stack registry returned no plugin table");
  }
  return json;
}

async function githubSearch(query, page) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    `${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`;
  const headers = {
    Accept: "application/vnd.github+json",
    ...(run.token ? { Authorization: `Bearer ${run.token}` } : {}),
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { json, headers: responseHeaders } = await fetchJson(url, headers);
      if (!Array.isArray(json?.items) || json.incomplete_results === true) {
        throw new Error(`GitHub returned incomplete or invalid results: ${query} page ${page}`);
      }
      return {
        json,
        remaining: Number(responseHeaders.get("x-ratelimit-remaining") ?? NaN),
      };
    } catch (error) {
      const rateLimited = error.status === 429 || (error.status === 403 && (
        error.headers?.get("x-ratelimit-remaining") === "0" || error.headers?.has("retry-after")
      ));
      if (!rateLimited || attempt === 4) throw error;
      const reset = Number(error.headers?.get?.("x-ratelimit-reset") || 0);
      const retryAfter = error.headers?.get("retry-after");
      const retryDelay = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? "") - Date.now();
      const resetDelay = reset * 1000 - Date.now() + 1000;
      const wait = Math.max(8000 * (attempt + 1), retryDelay || 0, resetDelay);
      if (wait > 70_000) throw new Error("GitHub rate limit requires waiting more than 70 seconds; retry later", { cause: error });
      run.log(`GitHub rate limit, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw new Error(`GitHub search failed after retries: ${query} page ${page}`);
}

function repoKeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

function mapFormat(value) {
  const name = String(value || "").toLowerCase();
  if (name === "vst3") return "vst3";
  if (name === "vst" || name === "dll") return "vst";
  if (name === "clap") return "clap";
  if (name === "lv2") return "lv2";
  if (name === "au" || name === "component") return "au";
  if (name === "aax") return "aax";
  return null;
}

function mapKind(value) {
  const name = String(value || "").toLowerCase();
  if (KINDS.has(name)) return name;
  return "plugin";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectFiles(files) {
  const formats = [];
  const systems = [];
  const slim = [];
  for (const file of files || []) {
    const fileFormats = unique((file.contains || []).map(mapFormat));
    const fileSystems = unique(
      (file.systems || []).map((system) =>
        typeof system === "string" ? system : system?.type,
      ),
    );
    formats.push(...fileFormats);
    systems.push(...fileSystems);
    if (!file.url) continue;
    slim.push({
      url: file.url,
      systems: fileSystems,
      formats: fileFormats,
      size: Number.isFinite(file.size) ? file.size : null,
      type: file.type || null,
    });
  }
  return {
    formats: unique(formats).filter((format) => DAW_FORMATS.has(format) || format === "lv2"),
    systems: unique(systems),
    files: slim.slice(0, 12),
  };
}

function latestVersion(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  if (pkg.version && pkg.versions?.[pkg.version]) return pkg.versions[pkg.version];
  const versions = Object.values(pkg.versions || {});
  return versions[versions.length - 1] || null;
}

function fromRegistry(slug, pkg) {
  const version = latestVersion(pkg);
  if (!version) return null;
  const files = collectFiles(version.files);
  const url = version.url || "";
  const repo = repoKeyFromUrl(url);
  return {
    id: String(slug).toLowerCase(),
    name: cleanText(version.name) || slug,
    author: cleanText(version.author) || repo?.split("/")[0] || "Unknown",
    description: cleanText(version.description),
    kind: mapKind(version.type),
    license: version.license ? String(version.license).toLowerCase() : null,
    tags: unique((version.tags || []).map((tag) => cleanText(tag))).slice(0, 16),
    formats: files.formats,
    systems: files.systems,
    version: pkg.version || null,
    url: url || STUDIORACK_URL,
    repo,
    image: version.image || null,
    audio: version.audio || null,
    downloads: Number(pkg.downloads || version.downloads || 0),
    stars: null,
    forks: null,
    source: "registry",
    verified: Boolean(version.verified),
    archived: false,
    date: version.date || null,
    updated: version.date || null,
    language: null,
    topics: [],
    files: files.files,
    mentions: [],
  };
}

function formatsFromRepo(repo) {
  const blob = `${(repo.topics || []).join(" ")} ${repo.name} ${repo.description || ""}`.toLowerCase();
  const formats = [];
  if (blob.includes("vst3")) formats.push("vst3");
  if (blob.includes("clap")) formats.push("clap");
  if (blob.includes("lv2")) formats.push("lv2");
  if (blob.includes("audio-unit") || /\bau-plugin\b/.test(blob)) formats.push("au");
  if (/\baax\b/.test(blob)) formats.push("aax");
  if (/\bvst2\b|\bvst\b/.test(blob)) formats.push("vst");
  if (
    !formats.some((format) => DAW_FORMATS.has(format)) &&
    blob.includes("juce") &&
    /\bplugin\b/.test(blob) &&
    !/\b(template|course|tutorial|boilerplate)\b/.test(blob)
  ) {
    formats.push("vst3");
  }
  return unique(formats);
}

function kindFromRepo(repo) {
  const blob = `${(repo.topics || []).join(" ")} ${repo.description || ""} ${repo.name}`.toLowerCase();
  if (/\b(sampler|sfz|soundfont)\b/.test(blob)) return "sampler";
  if (/\b(synth|synthesizer|instrument|piano|organ|drum)\b/.test(blob)) return "instrument";
  if (/\b(reverb|delay|compressor|equalizer|distortion|saturat|limiter|chorus|phaser|flanger|effect|eq)\b/.test(blob)) {
    return "effect";
  }
  if (/\b(tool|utility|analyzer|analyser|meter)\b/.test(blob)) return "tool";
  return "plugin";
}

function isListRepo(repo) {
  const name = repo.name.toLowerCase();
  const topics = new Set(repo.topics || []);
  if (topics.has("awesome-list") || topics.has("awesome")) return true;
  return name === "awesome" || name.startsWith("awesome-") || name.startsWith("awesome_");
}

function pluginBlob(plugin) {
  return `${plugin.name} ${plugin.description || ""} ${(plugin.topics || []).join(" ")} ${(plugin.tags || []).join(" ")}`.toLowerCase();
}

function isJuceTemplate(plugin) {
  return /\b(templates?|boilerplate|skeleton|starter|course|tutorial|snippets?)\b/.test(pluginBlob(plugin));
}

function isLv2Only(plugin) {
  const formats = plugin.formats || [];
  if (formats.some((format) => DAW_FORMATS.has(format))) return false;
  if (formats.includes("lv2")) return true;
  const blob = pluginBlob(plugin);
  return /\blv2\b/.test(blob) && !/\b(vst3?|vsti|clap|aax|audio unit)\b/.test(blob);
}

function prose(plugin) {
  return `${plugin.name} ${plugin.description || ""}`.toLowerCase();
}

function isBlockedRepo(plugin) {
  const blob = prose(plugin).replace(/daw[- ]compatible/g, "");
  if (/bridge/.test(plugin.name.toLowerCase())) return true;
  return /\b(framework|sdk|toolkit|api implementation|\bbridge\b|plugin[- ]host|hosting|host application|video editor|list of|resources related|\bguide\b|stencils|registry|workshop|\bdriver\b|\basio\b|foobar2000|vcv rack|stream deck|\bgodot\b|\bunreal\b|\bjsfx\b|max for live|\bm4l\b|digital audio workstation|\bdaw\b|loop machine|plugin manager|sequencer|music player|music making app|sound i\/o|claude code|skill for|python library|\bservers?\b|\bbook\b|development system|create (?:vst|audio plugins)|make vst3?|build vst3?|\bwrapper\b|\bobs\b|node addon|host applications?)\b/.test(
    blob,
  );
}

function isDawPlugin(plugin) {
  if (isLv2Only(plugin) || isJuceTemplate(plugin)) return false;
  if (plugin.source !== "github") return true;
  if (isBlockedRepo(plugin)) return false;
  const hasDaw = (plugin.formats || []).some((format) => DAW_FORMATS.has(format));
  const text = prose(plugin);
  const saysPlugin = /\bplugins?\b/.test(text) || (/\bjuce\b/.test(text) && /\b(equalizer|compressor|reverb|delay|synth|instrument|effect)\b/.test(text));
  return hasDaw && saysPlugin;
}

function fromGithub(repo) {
  const repoName = repo.full_name?.toLowerCase();
  if (!repoName) return null;
  return {
    id: repoName,
    name: cleanText(repo.name),
    author: repo.owner?.login || repoName.split("/")[0],
    description: cleanText(repo.description),
    kind: kindFromRepo(repo),
    license: repo.license?.spdx_id ? String(repo.license.spdx_id).toLowerCase() : null,
    tags: [],
    formats: formatsFromRepo(repo),
    systems: [],
    version: null,
    url: repo.html_url,
    repo: repoName,
    image: null,
    audio: null,
    downloads: 0,
    stars: Number(repo.stargazers_count || 0),
    forks: Number(repo.forks_count || 0),
    source: "github",
    verified: false,
    archived: Boolean(repo.archived),
    date: null,
    updated: repo.pushed_at || repo.updated_at || null,
    language: repo.language || null,
    topics: unique(repo.topics || []).slice(0, 16),
    files: [],
    mentions: [],
  };
}

function mergePlugin(current, incoming) {
  if (!current) return incoming;
  return {
    ...current,
    description: current.description || incoming.description,
    license: current.license || incoming.license,
    formats: unique([...(current.formats || []), ...(incoming.formats || [])]),
    topics: unique([...(current.topics || []), ...(incoming.topics || [])]).slice(0, 16),
    stars: Math.max(current.stars || 0, incoming.stars || 0) || null,
    forks: Math.max(current.forks || 0, incoming.forks || 0) || null,
    updated: [current.updated, incoming.updated].filter(Boolean).sort().at(-1) || null,
  };
}

function attachGithub(plugin, github) {
  plugin.stars = github.stars;
  plugin.forks = github.forks;
  plugin.language = plugin.language || github.language;
  plugin.topics = unique([...(plugin.topics || []), ...(github.topics || [])]).slice(0, 16);
  plugin.archived = Boolean(plugin.archived || github.archived);
  plugin.formats = unique([...(plugin.formats || []), ...(github.formats || [])]);
  plugin.description = plugin.description || github.description;
  plugin.license = plugin.license || github.license;
  plugin.updated = [plugin.updated, github.updated].filter(Boolean).sort().at(-1) || null;
  plugin.source = "both";
}

function publicPlugin(plugin) {
  return { ...plugin };
}

const SKIP_POST =
  /\b(how to|guide to|walkthrough|contest|giveaway|what is a daw|studio setup|song contest|deals?|discount|% off|black friday|for sale)\b/i;
const PLUGIN_SIGNAL =
  /\b(plugins?|vsts?|vsti|synths?|synthesizers?|instruments?|effects?|compressors?|reverbs?|equalizers?|\beq\b|delays?|samplers?|drum machines?|\bclap\b|bundles?)\b/i;
const ROUNDUP = /\b(best|roundup|\d+\s+free|plugins (?:to|we|for)|favo[u]?rite plugins)\b/i;

function decodeHtml(value) {
  return cleanText(
    String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#8217;|&#039;|&rsquo;/g, "'")
      .replace(/&#8220;|&#8221;|"|&ldquo;|&rdquo;/g, '"')
      .replace(/&/g, "&")
      .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&[a-z]+;/gi, " "),
  );
}

function cleanupName(name) {
  return cleanText(
    String(name || "")
      .replace(/^["']|["']$/g, "")
      .replace(/^(a|an|the)\s+/i, "")
      .replace(/\bfree(?:ware)?\b/gi, "")
      .replace(/\s+(?:for|on)\s+(?:macos|windows|linux|pc|mac).*/i, "")
      .replace(/[.:]+$/g, ""),
  );
}

function looksLikeProduct(name) {
  const text = cleanupName(name);
  if (text.length < 2 || text.length > 52) return false;
  if (text.split(" ").length > 7) return false;
  if (/^(vocal|new|more|support|windows|macos|linux|four|their|this|these)\b/i.test(text)) return false;
  return /[A-Za-z]/.test(text);
}

function announcedPlugin(title) {
  const released = title.match(
    /^(.*?)\s+(?:releases|launches|announces|unveils|introduces|breaks down)\s+(.+)$/i,
  );
  if (released) {
    const name = cleanupName(released[2].split(/[,:]/)[0]);
    if (looksLikeProduct(name)) return { author: cleanupName(released[1]), name };
  }
  const intro = title.match(/^introducing\s+(.+)$/i);
  if (intro) {
    const name = cleanupName(intro[1].split(/[,:]/)[0]);
    if (looksLikeProduct(name)) return { author: "", name };
  }
  const added = title.match(/^(.*?)\s+adds\s+(.+?)\s+(?:to|into)\b/i);
  if (added) {
    const objectName = cleanupName(added[2].split(/[,:]/)[0]);
    const subjectName = cleanupName(added[1]);
    if (looksLikeProduct(objectName)) return { author: subjectName, name: objectName };
    if (looksLikeProduct(subjectName)) return { author: "", name: subjectName };
  }
  return null;
}

function pluginHeadings(html) {
  const names = [];
  for (const match of String(html || "").matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const raw = decodeHtml(match[1]);
    const numbered = /^\d+[\).\s:-]+/.test(raw);
    const labeled = /^(?:best|free)\b[^:]{0,40}:\s+\S/i.test(raw);
    if (!numbered && !labeled) continue;
    let text = raw.replace(/^\d+[\).\s:-]+/, "").trim();
    if (text.includes(":")) text = text.split(":").pop().trim();
    text = cleanupName(text.replace(/\s*\([^)]*\)/g, " "));
    if (!text || text.length > 60 || text.endsWith("?")) continue;
    if (/\b(terminology|legal|basics|mention|picks|to know|guide|tutorial|overview|faq)\b/i.test(text)) continue;
    if (/^(how to|what|why|when)\b/i.test(text)) continue;
    if (text.split(" ").length > 8) continue;
    if (!looksLikeProduct(text)) continue;
    names.push(text);
  }
  return unique(names).slice(0, 16);
}

function formatsFromText(blob) {
  return formatsFromRepo({ topics: [], name: blob, description: "" });
}

function kindFromText(blob) {
  return kindFromRepo({ topics: [], name: blob, description: blob });
}

function normName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const GENERIC_TOKENS = new Set([
  "free", "plugin", "plugins", "audio", "synth", "synthesizer", "vst", "vst3",
  "studios", "digital", "the", "and", "records", "music", "lab", "labs", "fx",
]);

function nameTokens(name) {
  return normName(name).split(" ").filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function namesMatch(left, right) {
  if (normName(left) === normName(right)) return true;
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.length || !b.length) return false;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  if (small.length === 1 && small[0].length < 4) return false;
  return small.every((token) => big.includes(token));
}

function findHost(plugins, name) {
  const exact = plugins.filter((plugin) => normName(plugin.name) === normName(name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const loose = plugins.filter((plugin) => namesMatch(plugin.name, name));
  return loose.length === 1 ? loose[0] : null;
}

function addMention(plugin, mention) {
  if (plugin.mentions.some((item) => item.url === mention.url && item.blog === mention.blog)) return;
  plugin.mentions.push(mention);
  if (plugin.mentions.length > 4) plugin.mentions.length = 4;
}

function makeBlogPlugin({ blog, name, author, description, mention, blob }) {
  const id = `blog:${blog.id}:${normName(name).replace(/ /g, "-")}`;
  return {
    id,
    name,
    author: author || blog.name,
    description: description || mention.title,
    kind: kindFromText(`${name} ${blob}`),
    license: null,
    tags: [blog.name],
    formats: formatsFromText(blob),
    systems: [],
    version: null,
    url: mention.url,
    repo: null,
    image: null,
    audio: null,
    downloads: 0,
    stars: null,
    forks: null,
    source: "blog",
    verified: false,
    archived: false,
    date: mention.date,
    updated: mention.date,
    language: null,
    topics: [],
    files: [],
    mentions: [mention],
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: requestSignal(),
    headers: requestHeaders("text/html,application/json"),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function wpPosts(base, { category, search, page }) {
  const params = new URLSearchParams({
    per_page: String(BLOG_PER_PAGE),
    page: String(page),
    _fields: "date,link,slug,title,excerpt,content",
  });
  if (category) params.set("categories", String(category));
  if (search) params.set("search", search);
  try {
    const { json } = await fetchJson(`${base}?${params}`);
    if (!Array.isArray(json)) throw new Error(`Expected a list of posts from ${base}`);
    return json;
  } catch (error) {
    if (page > 1 && error.status === 400 && error.body?.code === "rest_post_invalid_page_number") return [];
    throw error;
  }
}

function postRecord(post) {
  return {
    title: decodeHtml(post.title?.rendered || post.title || ""),
    excerpt: decodeHtml(post.excerpt?.rendered || post.excerpt || ""),
    content: post.content?.rendered || post.content || "",
    link: post.link,
    date: post.date || null,
    slug: post.slug || "",
  };
}

async function landrPosts(pages) {
  const posts = [];
  const seen = new Set();
  for (const pageUrl of pages) {
    const html = await fetchText(pageUrl);
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    const apollo = match && JSON.parse(match[1]).props?.pageProps?.__APOLLO_STATE__;
    if (!apollo || typeof apollo !== "object") throw new Error(`LANDR post data missing from ${pageUrl}`);
    for (const value of Object.values(apollo)) {
      if (!value || value.__typename !== "Post") continue;
      const title = decodeHtml(value['title({"format":"RENDERED"})'] || "");
      const slug = value.slug;
      if (!title || !slug || seen.has(slug)) continue;
      if (!PLUGIN_SIGNAL.test(title) || SKIP_POST.test(title)) continue;
      seen.add(slug);
      posts.push({ title, slug, link: `https://blog.landr.com/${slug}/`, excerpt: "", content: "", date: null });
    }
  }

  const roundups = posts.filter((post) => ROUNDUP.test(post.title)).slice(0, 8);
  for (const post of roundups) {
    const html = await fetchText(post.link);
    post.content = html;
    post.date =
      html.match(/property="article:published_time" content="([^"]+)"/)?.[1] ||
      html.match(/<time[^>]+datetime="([^"]+)"/)?.[1] ||
      null;
  }
  return posts;
}

function findsFromPost(post, blog) {
  if (!post.title || !post.link) return [];
  if (SKIP_POST.test(post.title)) return [];
  if (!PLUGIN_SIGNAL.test(`${post.title} ${post.excerpt}`)) return [];
  const mention = { blog: blog.name, url: post.link, date: post.date, title: post.title };
  if (ROUNDUP.test(post.title)) {
    return pluginHeadings(post.content).map((name) =>
      makeBlogPlugin({
        blog,
        name,
        author: blog.name,
        description: post.excerpt || post.title,
        mention,
        blob: `${name} ${post.title} ${post.excerpt}`,
      }),
    );
  }
  const parsed = announcedPlugin(post.title);
  if (!parsed) return [];
  return [
    makeBlogPlugin({
      blog,
      name: parsed.name,
      author: parsed.author,
      description: post.excerpt || post.title,
      mention,
      blob: `${post.title} ${post.excerpt}`,
    }),
  ];
}

async function loadBlogPosts(blog) {
  if (blog.pages) return landrPosts(blog.pages);
  const posts = [];
  if (blog.searches) {
    for (const search of blog.searches) {
      const page = await wpPosts(blog.url, { search, page: 1 });
      posts.push(...page.map(postRecord));
    }
    return posts;
  }
  for (let page = 1; page <= BLOG_PAGES; page++) {
    const batch = await wpPosts(blog.url, { category: blog.category, page });
    posts.push(...batch.map(postRecord));
    if (batch.length < BLOG_PER_PAGE) break;
  }
  return posts;
}

/** What the previous catalog had from one blog: its own finds, and its mentions on other plugins. */
function keepFromPrevious(blog, previous, existing, fresh) {
  const byId = new Map(existing.map((plugin) => [plugin.id, plugin]));
  for (const old of previous?.plugins || []) {
    if (old.source === "blog") {
      if (old.id.startsWith(`blog:${blog.id}:`)) fresh.push(structuredClone(old));
      continue;
    }
    for (const mention of old.mentions || []) {
      if (mention.blog === blog.name && byId.has(old.id)) addMention(byId.get(old.id), mention);
    }
  }
}

async function collectBlogPlugins(existing, { previous, skipped }) {
  const fresh = [];
  const byKey = new Map();
  for (const blog of BLOG_SOURCES) {
    run.log(`blog ${blog.name}`);
    let posts;
    try {
      posts = await loadBlogPosts(blog);
    } catch (error) {
      if (!previous || run.signal?.aborted) throw error;
      keepFromPrevious(blog, previous, existing, fresh);
      skipped.push(blog.name);
      run.log(`blog ${blog.name} unreachable, kept from the previous list`);
      continue;
    }
    run.log(`blog ${blog.name}: ${posts.length} posts`);
    for (let offset = 0; offset < posts.length; offset += BATCH_SIZE) {
      for (const post of posts.slice(offset, offset + BATCH_SIZE)) {
        for (const plugin of findsFromPost(post, blog)) {
          const host = findHost(existing, plugin.name) || findHost(fresh, plugin.name);
          if (host && host.source !== "blog") {
            addMention(host, plugin.mentions[0]);
            continue;
          }
          const key = normName(plugin.name);
          const prior = byKey.get(key);
          if (prior) {
            addMention(prior, plugin.mentions[0]);
            if ((plugin.date || "") > (prior.date || "")) {
              prior.date = plugin.date;
              prior.updated = plugin.date;
              prior.description = plugin.description || prior.description;
              prior.url = plugin.url;
            }
            continue;
          }
          byKey.set(key, plugin);
          fresh.push(plugin);
        }
      }
    }
  }
  return fresh;
}

/**
 * Fetch every source and return the catalog.
 *
 *   token      GitHub token; without one GitHub allows 10 searches a minute
 *   log        called with one line per step
 *   signal     AbortSignal that cancels the run
 *   userAgent  sent by Node only
 *   previous   an earlier catalog: a blog that cannot be reached keeps its
 *              entries from it instead of failing the run (the names of such
 *              blogs are returned in `skipped`)
 */
export async function fetchCatalog({ token = "", log = () => {}, signal, userAgent = "", previous = null } = {}) {
  run = { token, log, signal, userAgent };
  const skipped = [];
  run.log("fetching Open Audio Registry…");
  const registry = await loadRegistry();
  const registryPlugins = [];
  const byRepo = new Map();

  const sections = [
    ["plugins", registry.plugins],
    ["apps", registry.apps],
  ];

  for (const [section, table] of sections) {
    const entries = Object.entries(table || {});
    for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
      const batch = entries.slice(offset, offset + BATCH_SIZE);
      for (const [slug, pkg] of batch) {
        const plugin = fromRegistry(slug, pkg);
        if (!plugin) continue;
        if (section === "apps" && plugin.formats.length === 0) continue;
        plugin.id = `${section === "apps" ? "app:" : ""}${String(slug).toLowerCase()}`;
        registryPlugins.push(plugin);
        if (!plugin.repo) continue;
        const group = byRepo.get(plugin.repo) || [];
        group.push(plugin);
        byRepo.set(plugin.repo, group);
      }
      run.log(
        `registry ${section}: ${Math.min(offset + BATCH_SIZE, entries.length)}/${entries.length}`,
      );
    }
  }

  const githubOnly = new Map();
  for (const query of GITHUB_TOPICS) {
    for (let page = 1; page <= PAGES_PER_QUERY; page++) {
      run.log(`GitHub ${query.replace("topic:", "")} page ${page}/${PAGES_PER_QUERY}`);
      const { json, remaining } = await githubSearch(query, page);
      const items = json.items || [];
      for (const repo of items) {
        if (repo.private || repo.fork) continue;
        if (isListRepo(repo)) continue;
        const plugin = fromGithub(repo);
        if (!plugin || !isDawPlugin(plugin)) continue;
        const matches = byRepo.get(plugin.id);
        if (matches?.length) {
          for (const existing of matches) attachGithub(existing, plugin);
          continue;
        }
        githubOnly.set(plugin.id, mergePlugin(githubOnly.get(plugin.id), plugin));
      }
      if (items.length < PER_PAGE) break;
      if (Number.isFinite(remaining) && remaining <= 1) {
        run.log("approaching GitHub search limit, pausing");
        await sleep(15_000);
      }
    }
  }

  const taken = new Set(registryPlugins.map((plugin) => plugin.id));
  const extras = [];
  for (const plugin of githubOnly.values()) {
    if (taken.has(plugin.id)) plugin.id = `${plugin.id}#github`;
    extras.push(plugin);
  }

  const blogPlugins = await collectBlogPlugins([...registryPlugins, ...extras], { previous, skipped });
  run.log(`blog discoveries: ${blogPlugins.length}`);
  extras.push(...blogPlugins);

  const merged = [...registryPlugins, ...extras].filter(isDawPlugin);
  const plugins = [];
  for (let offset = 0; offset < merged.length; offset += BATCH_SIZE) {
    plugins.push(...merged.slice(offset, offset + BATCH_SIZE).map(publicPlugin));
    run.log(`normalized ${Math.min(offset + BATCH_SIZE, merged.length)}/${merged.length}`);
  }

  plugins.sort((a, b) => {
    const stars = (b.stars ?? -1) - (a.stars ?? -1);
    if (stars) return stars;
    const downloads = (b.downloads || 0) - (a.downloads || 0);
    if (downloads) return downloads;
    return a.name.localeCompare(b.name);
  });

  const counts = {
    total: plugins.length,
    registry: plugins.filter((plugin) => plugin.source === "registry" || plugin.source === "both").length,
    githubOnly: plugins.filter((plugin) => plugin.source === "github").length,
    both: plugins.filter((plugin) => plugin.source === "both").length,
    blog: plugins.filter((plugin) => plugin.source === "blog").length,
    vst3: plugins.filter((plugin) => plugin.formats.includes("vst3")).length,
    clap: plugins.filter((plugin) => plugin.formats.includes("clap")).length,
    lv2: plugins.filter((plugin) => plugin.formats.includes("lv2")).length,
  };

  const catalog = {
    name: "Racklist VST catalog",
    generatedAt: new Date().toISOString(),
    criteria: {
      batchSize: BATCH_SIZE,
      studiorackUrl: STUDIORACK_URL,
      githubTopics: GITHUB_TOPICS,
      pagesPerQuery: PAGES_PER_QUERY,
      perPage: PER_PAGE,
      blogs: BLOG_SOURCES.map((blog) => blog.name),
    },
    counts,
    plugins,
  };

  if (!plugins.length) throw new Error("catalog is empty");
  return { catalog, skipped };
}
