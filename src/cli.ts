#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DeslopSearch } from "./pipeline.js";
import type {
  CommunityChannelName,
  CommunityProfile,
  DorkOptions,
  RawSearchResult,
  SearchEngine,
  TemporalEra
} from "./types.js";

const HELP_TEXT = `
deslop — Clean Human-Era Search, Split-Horizon & Anti-Slop Utility

USAGE:
  deslop query "<search terms>" [--split | --split-horizon] [options]
  deslop live "<search terms>" [--split | --split-horizon] [--before-year <YYYY>] [--limit <N>] [--json]
  deslop split "<search terms>" [--plan] [--before-year <YYYY>] [--limit <N>] [--json]
  deslop routes "<search terms>" [options]
  deslop classify [--text "<body|snippet>"] [--file <path>] [--title "<title>"] [--url "<url>"] [--json]
  deslop filter --file <results.json> [--max-slop <0..1>] [--json]

OPTIONS:
  --split, --split-horizon  Enable Dual Temporal Horizon (Lane A: Pre-2023 Canonical vs Lane B: Post-2023 Audited)
  --era <preset>            human-classic (default: after:2010 before:2023) | pre-gpt4 | archival | modern-curated | none
  --profile <name>          none (default) | all_community | discussions | qa | code | blogs | forums
  --channel <list>          Comma-separated channels: reddit,stackoverflow,github,hackernews,indie_forums,engineering_blogs
  --engine <name>           google (default, udm=14) | duckduckgo | brave | kagi | searxng | bing
  --before <date>           Custom before:YYYY or YYYY-MM-DD override
  --after <date>            Custom after:YYYY or YYYY-MM-DD override
  --exclude <domains>       Comma-separated extra domains to exclude (-site:...)
  --include <domains>       Comma-separated custom domains to target (site:...)
  --no-blocklist            Disable default inline spam domain exclusions
  --smart                   Auto-shift to modern-curated if post-2022 versions/years are detected
  --plan                    With 'deslop split', emit dual dork query plan without live HTTP calls
  --json                    Emit structured JSON output
  -h, --help                Show this help message
`.trim();

function splitCsv(val: string | undefined): string[] | undefined {
  if (val === undefined || val.trim().length === 0) {
    return undefined;
  }
  return val
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      split: { type: "boolean", default: false },
      "split-horizon": { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      era: { type: "string" },
      profile: { type: "string" },
      channel: { type: "string" },
      engine: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      exclude: { type: "string" },
      include: { type: "string" },
      "no-blocklist": { type: "boolean", default: false },
      smart: { type: "boolean", default: false },
      text: { type: "string" },
      file: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
      "max-slop": { type: "string" },
      "before-year": { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  const isSplitHorizon = values.split === true || values["split-horizon"] === true;
  const subcommand = positionals[0];
  const restQuery = positionals.slice(1).join(" ").trim();
  const deslop = new DeslopSearch();

  const buildDorkOptions = (): DorkOptions => {
    const opts: DorkOptions = {
      disableBlocklist: values["no-blocklist"] === true,
      smartTemporal: values.smart === true,
      splitHorizon: isSplitHorizon
    };
    if (values.era !== undefined) {
      opts.era = values.era as TemporalEra;
    }
    if (values.profile !== undefined) {
      opts.profile = values.profile as CommunityProfile;
    }
    const channels = splitCsv(values.channel);
    if (channels !== undefined) {
      opts.channels = channels as CommunityChannelName[];
    }
    if (values.engine !== undefined) {
      opts.engine = values.engine as SearchEngine;
    }
    if (values.before !== undefined) {
      opts.before = values.before;
    }
    if (values.after !== undefined) {
      opts.after = values.after;
    }
    const excludes = splitCsv(values.exclude);
    if (excludes !== undefined) {
      opts.excludeSites = excludes;
    }
    const includes = splitCsv(values.include);
    if (includes !== undefined) {
      opts.includeSites = includes;
    }
    return opts;
  };

  const cutoffYear =
    values["before-year"] !== undefined ? Number(values["before-year"]) : 2023;
  const limitPerSource =
    values.limit !== undefined ? Number(values.limit) : 4;
  const maxSlopScore =
    values["max-slop"] !== undefined ? Number(values["max-slop"]) : 0.59;

  if (subcommand === "query") {
    if (restQuery.length === 0) {
      throw new Error("Missing search query. Usage: deslop query \"<terms>\"");
    }
    if (isSplitHorizon) {
      const plan = deslop.compileSplitHorizon(restQuery, buildDorkOptions(), cutoffYear);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      } else {
        process.stdout.write(`${plan.formattedReport}\n`);
      }
      return 0;
    }

    const compiled = deslop.compileQuery(restQuery, buildDorkOptions());
    if (values.json) {
      process.stdout.write(`${JSON.stringify(compiled, null, 2)}\n`);
    } else {
      process.stdout.write(`Compiled Query : ${compiled.compiledQuery}\n`);
      process.stdout.write(`Engine URL     : ${compiled.searchUrl}\n`);
      process.stdout.write(
        `Operators      : ${compiled.operatorCount}/${compiled.operatorBudget} (${compiled.engine}, era=${compiled.eraApplied})\n`
      );
      for (const warning of compiled.warnings) {
        process.stderr.write(`[WARN] ${warning}\n`);
      }
    }
    return 0;
  }

  if (subcommand === "split") {
    if (restQuery.length === 0) {
      throw new Error("Missing search query. Usage: deslop split \"<terms>\"");
    }
    if (values.plan === true) {
      const plan = deslop.compileSplitHorizon(restQuery, buildDorkOptions(), cutoffYear);
      process.stdout.write(values.json ? `${JSON.stringify(plan, null, 2)}\n` : `${plan.formattedReport}\n`);
      return 0;
    }
    const report = await deslop.liveSplitHorizonSearch(restQuery, {
      cutoffYear,
      limitPerSource,
      maxSlopScore,
      dorkOptions: buildDorkOptions()
    });
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${report.formattedReport}\n`);
    return 0;
  }

  if (subcommand === "routes" || subcommand === "urls") {
    if (restQuery.length === 0) {
      throw new Error("Missing search query. Usage: deslop routes \"<terms>\"");
    }
    const routes = deslop.buildRoutes(restQuery, buildDorkOptions());
    if (values.json) {
      process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
    } else {
      for (const route of routes) {
        process.stdout.write(`\n[${route.channel}] ${route.label}\n`);
        process.stdout.write(`  Dork   : ${route.compiledQuery}\n`);
        process.stdout.write(`  Engine : ${route.engineUrl}\n`);
        if (route.nativeSearchUrl !== undefined) {
          process.stdout.write(`  Native : ${route.nativeSearchUrl}\n`);
        }
      }
    }
    return 0;
  }

  if (subcommand === "classify") {
    let body = values.text ?? restQuery;
    if (values.file !== undefined) {
      body = readFileSync(values.file, { encoding: "utf-8" });
    }
    const classifyArgs: { text: string; title?: string; url?: string } = { text: body };
    if (values.title !== undefined) {
      classifyArgs.title = values.title;
    }
    if (values.url !== undefined) {
      classifyArgs.url = values.url;
    }
    const report = deslop.classifyText(classifyArgs);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Verdict          : ${report.verdict} (score=${report.score})\n`);
      process.stdout.write(`Technical Density: ${report.technicalDensity}\n`);
      if (report.signals.length > 0) {
        process.stdout.write(`Signals:\n`);
        for (const sig of report.signals) {
          process.stdout.write(`  - [${sig.code}] (${sig.weight >= 0 ? "+" : ""}${sig.weight}): ${sig.detail}\n`);
        }
      }
    }
    return 0;
  }

  if (subcommand === "filter") {
    if (values.file === undefined) {
      throw new Error("Missing --file <results.json> for filter subcommand.");
    }
    const rawJson = readFileSync(values.file, { encoding: "utf-8" });
    const parsed = JSON.parse(rawJson) as RawSearchResult[];
    const filtered = deslop.filterResults(parsed, { maxSlopScore });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Filtered ${filtered.stats.total} results -> Kept ${filtered.stats.keptCount}, Discarded ${filtered.stats.discardedCount}\n`
      );
      for (const item of filtered.kept) {
        process.stdout.write(
          `  [KEEP rank=${item.rankScore} slop=${item.classification.score}] ${item.title} (${item.url})\n`
        );
      }
    }
    return 0;
  }

  if (subcommand === "live") {
    if (restQuery.length === 0) {
      throw new Error("Missing search query. Usage: deslop live \"<terms>\"");
    }
    if (isSplitHorizon) {
      const splitReport = await deslop.liveSplitHorizonSearch(restQuery, {
        cutoffYear,
        limitPerSource,
        maxSlopScore,
        dorkOptions: buildDorkOptions()
      });
      if (values.json) {
        process.stdout.write(`${JSON.stringify(splitReport, null, 2)}\n`);
      } else {
        process.stdout.write(`${splitReport.formattedReport}\n`);
      }
      return 0;
    }

    const report = await deslop.liveArchiveSearch(restQuery, {
      beforeYear: cutoffYear,
      limitPerSource: values.limit !== undefined ? Number(values.limit) : 5
    });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Live Human-Archive Results (before:${cutoffYear}) — Kept ${report.stats.keptCount}/${report.stats.total}:\n`
      );
      for (const hit of report.kept) {
        process.stdout.write(
          `\n- [${hit.source ?? "web"}] ${hit.title}\n  URL  : ${hit.url}\n  Score: rank=${hit.rankScore}, slop=${hit.classification.score} (${hit.classification.verdict})\n`
        );
      }
    }
    return 0;
  }

  // Fallback: treat entire positional input as a direct query
  const directQuery = positionals.join(" ").trim();
  if (isSplitHorizon) {
    const plan = deslop.compileSplitHorizon(directQuery, buildDorkOptions(), cutoffYear);
    process.stdout.write(values.json ? `${JSON.stringify(plan, null, 2)}\n` : `${plan.formattedReport}\n`);
    return 0;
  }

  const compiled = deslop.compileQuery(directQuery, buildDorkOptions());
  if (values.json) {
    process.stdout.write(`${JSON.stringify(compiled, null, 2)}\n`);
  } else {
    process.stdout.write(`${compiled.compiledQuery}\n`);
  }
  return 0;
}

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ERROR] ${msg}\n`);
    process.exitCode = 1;
  }
);
