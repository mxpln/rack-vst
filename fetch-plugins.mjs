#!/usr/bin/env node
/**
 * Fetch the plugin catalog and write catalog.json, which build.mjs turns into
 * the site. The fetching itself lives in src/fetch.js. Run by the update-catalog
 * GitHub Action.
 *
 * Usage: npm run fetch [-- --dry-run]   (GITHUB_TOKEN raises the GitHub rate limit)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchCatalog } from "./src/fetch.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--dry-run")) {
  console.error("Usage: npm run fetch [-- --dry-run]");
  process.exit(2);
}

try {
  // No `previous` catalog: here a source that cannot be reached fails the run.
  const { catalog } = await fetchCatalog({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    userAgent: "racklist-vst-catalog",
    log: console.log,
  });
  const { counts } = catalog;
  if (args[0] === "--dry-run") {
    console.log("Dry run complete. catalog.json was not written.");
    console.table(counts);
  } else {
    writeFileSync(fileURLToPath(new URL("catalog.json", import.meta.url)), `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(
      `wrote ${counts.total} plugins (${counts.vst3} VST3, ${counts.clap} CLAP, ${counts.lv2} LV2, ${counts.blog} from blogs)`,
    );
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
