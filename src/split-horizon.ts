import { detectModernSubject, sanitizeRawQuery, TemporalDorkEngine } from "./dorks.js";
import { CommunityRouter } from "./router.js";
import type {
  DifferentialStatus,
  DorkOptions,
  FilterBatchReport,
  HorizonDifferential,
  HorizonDivergenceSignal,
  SplitHorizonQueryPlan,
  SplitHorizonSearchReport
} from "./types.js";

export const CANONICAL_HEADING = "[HORIZONTE CANÔNICO: PRÉ-2023]" as const;
export const CONTEMPORARY_HEADING = "[HORIZONTE CONTEMPORÂNEO: PÓS-2023]" as const;
export const DIFFERENTIAL_HEADING = "[DIFERENCIAL E CONFLITOS]" as const;

const CANONICAL_PRIORITY_SITES: readonly string[] = [
  "reddit.com",
  "stackoverflow.com",
  "github.com",
  "news.ycombinator.com",
  "lobste.rs",
  "danluu.com",
  "jvns.ca",
  "aphyr.com",
  "martinfowler.com"
];

const BREAKING_OR_DEPRECATION_RE =
  /\b(?:deprecated|deprecation|obsolete|removed\s+in|replaced\s+by|breaking\s+change|breaking\s+changes|end-of-life|eol|superseded|no\s+longer\s+recommended|anti-pattern|vulnerable|vulnerability|cve-202[3-9]-\d+|descontinuado|obsoleto|substitu[íi]do\s+por|vulnerabilidade)\b/gi;

const VERSION_OR_STANDARD_RE =
  /\b(?:CVE-\d{4}-\d{4,7}|RFC\s?\d{3,5}|ES20\d{2}|HTTP\/[123]|v\d+\.\d+(?:\.\d+)?|(?:React|Python|Node(?:\.js)?|Next(?:\.js)?|TypeScript|Tailwind|Go|Rust|PostgreSQL|Postgres|Linux)\s+v?\d+(?:\.\d+)?)\b/gi;

const TECHNICAL_IDENTIFIER_RE =
  /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z]+(?:[A-Z][a-z0-9]+)+|--[a-z0-9][a-z0-9-]{1,28})\b/g;

const STOP_IDENTIFIERS = new Set([
  "http",
  "https",
  "html",
  "json",
  "true",
  "false",
  "null",
  "undefined"
]);

function extractSalientTerms(texts: readonly string[], maxTerms = 8): string[] {
  const counts = new Map<string, { display: string; count: number }>();

  for (const raw of texts) {
    const versionMatches = raw.match(VERSION_OR_STANDARD_RE) ?? [];
    const idMatches = raw.match(TECHNICAL_IDENTIFIER_RE) ?? [];
    for (const token of [...versionMatches, ...idMatches]) {
      const cleaned = token.trim().replace(/\s+/g, " ");
      const key = cleaned.toLowerCase();
      if (key.length < 3 || STOP_IDENTIFIERS.has(key)) {
        continue;
      }
      const prev = counts.get(key);
      if (prev !== undefined) {
        prev.count += 1;
      } else {
        counts.set(key, { display: cleaned, count: 1 });
      }
    }
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, maxTerms)
    .map((entry) => entry.display);
}

export function buildArchivedGithubUrl(cleanQuery: string, cutoffYear = 2023): string {
  const q = `${cleanQuery} archived:true created:<${cutoffYear}-01-01`;
  return `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`;
}

export function analyzeHorizonDifferential(
  cleanQuery: string,
  laneA: FilterBatchReport,
  laneB: FilterBatchReport,
  cutoffYear = 2023
): HorizonDifferential {
  const laneATexts = laneA.kept.map((r) => `${r.title} ${r.content ?? r.snippet ?? ""}`);
  const laneBTexts = laneB.kept.map((r) => `${r.title} ${r.content ?? r.snippet ?? ""}`);

  const termsA = extractSalientTerms(laneATexts, 12);
  const termsB = extractSalientTerms(laneBTexts, 12);

  const lowerB = new Set(termsB.map((t) => t.toLowerCase()));
  const lowerA = new Set(termsA.map((t) => t.toLowerCase()));

  const canonicalOnlyTerms = termsA.filter((t) => !lowerB.has(t.toLowerCase())).slice(0, 6);
  const contemporaryOnlyTerms = termsB.filter((t) => !lowerA.has(t.toLowerCase())).slice(0, 6);

  const signals: HorizonDivergenceSignal[] = [];

  // 1. Check breaking/deprecation/CVE signals in Lane B
  const breakingMatches = new Set<string>();
  for (const txt of laneBTexts) {
    const found = txt.match(BREAKING_OR_DEPRECATION_RE) ?? [];
    for (const m of found) {
      breakingMatches.add(m.toLowerCase().replace(/\s+/g, " "));
    }
  }
  if (breakingMatches.size > 0) {
    const list = Array.from(breakingMatches).slice(0, 5).join(", ");
    signals.push({
      kind: "deprecation_or_breaking_shift",
      severity: "HIGH",
      summary: `Post-${cutoffYear} sources flag breaking shifts, deprecations, or advisories (${list}) that may invalidate pre-${cutoffYear} patterns.`
    });
  }

  // 2. Check version/standard drift
  const versionLike = (t: string): boolean => /\d/.test(t);
  const versionsA = canonicalOnlyTerms.filter(versionLike);
  const versionsB = contemporaryOnlyTerms.filter(versionLike);
  if (versionsA.length > 0 && versionsB.length > 0) {
    signals.push({
      kind: "version_drift",
      severity: "MEDIUM",
      summary: `Version/standard shift detected: pre-${cutoffYear} references [${versionsA.join(", ")}] vs post-${cutoffYear} [${versionsB.join(", ")}].`
    });
  }

  // 3. Check emergent terminology in Lane B
  if (contemporaryOnlyTerms.length > 0) {
    signals.push({
      kind: "emergent_terminology",
      severity: "INFO",
      summary: `Emergent post-${cutoffYear} identifiers absent from canonical baseline: ${contemporaryOnlyTerms.join(", ")}.`
    });
  }

  // 4. Check anachronism (empty Lane A vs active Lane B)
  if (laneA.stats.keptCount === 0 && laneB.stats.keptCount > 0) {
    signals.push({
      kind: "anachronism_warning",
      severity: "HIGH",
      summary: `Zero canonical hits before ${cutoffYear} vs ${laneB.stats.keptCount} audited contemporary hit(s). Subject likely originated post-${cutoffYear}; relying on before:${cutoffYear} alone would miss all primary facts.`
    });
  }

  // 5. Check post-2023 slop contamination in Lane B
  if (laneB.stats.discardedCount > 0) {
    const severity =
      laneB.stats.keptCount === 0 || laneB.stats.discardedCount >= laneB.stats.keptCount
        ? "HIGH"
        : "MEDIUM";
    signals.push({
      kind: "slop_saturation_warning",
      severity,
      summary: `Post-${cutoffYear} firewall purged ${laneB.stats.discardedCount}/${laneB.stats.total} contemporary result(s) (${laneB.stats.blockedDomainCount} blocked spam domain(s), ${laneB.stats.slopCount} synthetic slop hit(s)).`
    });
  }

  let status: DifferentialStatus = "CONVERGENT";
  if (laneA.stats.keptCount === 0 && laneB.stats.keptCount > 0) {
    status = "ANACHRONISTIC";
  } else if (breakingMatches.size > 0 || (versionsA.length > 0 && versionsB.length > 0)) {
    status = "DIVERGENT";
  } else if (laneB.stats.keptCount === 0 && laneB.stats.discardedCount > 0) {
    status = "SLOP_CONTAMINATED";
  }

  let synthesis: string;
  switch (status) {
    case "ANACHRONISTIC":
      synthesis = `Topic '${cleanQuery}' appears post-${cutoffYear} in origin; prioritize audited Contemporary Lane B while verifying against primary specs.`;
      break;
    case "DIVERGENT":
      synthesis = `Conceptual divergence detected between pre-${cutoffYear} human consensus (${laneA.stats.keptCount} hit(s)) and post-${cutoffYear} audited updates (${laneB.stats.keptCount} hit(s)); reconcile deprecations/CVEs before adopting legacy recipes.`;
      break;
    case "SLOP_CONTAMINATED":
      synthesis = `Contemporary post-${cutoffYear} SERP is heavily saturated with synthetic SEO filler; anchor reasoning on Canonical Pre-${cutoffYear} Lane A (${laneA.stats.keptCount} authentic hit(s)).`;
      break;
    default:
      synthesis = `Pre-${cutoffYear} canonical literature (${laneA.stats.keptCount} hit(s)) and post-${cutoffYear} audited reality (${laneB.stats.keptCount} hit(s)) remain aligned with no breaking contradictions detected.`;
      break;
  }

  return {
    status,
    canonicalOnlyTerms,
    contemporaryOnlyTerms,
    conflictSignals: signals,
    synthesis
  };
}

export function buildQueryPlanDifferential(
  cleanQuery: string,
  cutoffYear = 2023
): HorizonDifferential {
  const signals: HorizonDivergenceSignal[] = [
    {
      kind: "routing_asymmetry",
      severity: "INFO",
      summary: `Lane A restricts before:${cutoffYear} to high-trust human communities (Reddit, Stack Overflow, GitHub, HN, Indie Blogs); Lane B opens after:${cutoffYear} across the live web guarded by blocklist.json + heuristic anti-slop scoring.`
    }
  ];

  if (detectModernSubject(cleanQuery)) {
    signals.push({
      kind: "anachronism_warning",
      severity: "HIGH",
      summary: `Query '${cleanQuery}' references a post-2022 artifact/year: expect foundational precursors in Lane A and primary release/advisory facts in Lane B.`
    });
  }

  return {
    status: "QUERY_PLAN",
    canonicalOnlyTerms: [],
    contemporaryOnlyTerms: [],
    conflictSignals: signals,
    synthesis: `Dual-horizon plan armed at ${cutoffYear} boundary: cross-check foundational human architecture (Lane A) against contemporary breaking changes, CVEs, and releases purged of SEO farms (Lane B).`
  };
}

export function formatSplitHorizonQueryPlan(plan: SplitHorizonQueryPlan): string {
  const divider = "=".repeat(72);
  const lines: string[] = [
    divider,
    plan.canonicalPre2023.heading,
    divider,
    `Dork       : ${plan.canonicalPre2023.query.compiledQuery}`,
    `Engine URL : ${plan.canonicalPre2023.query.searchUrl}`,
    `GitHub Arc : ${plan.canonicalPre2023.archivedGithubUrl}`,
    `Operators  : ${plan.canonicalPre2023.query.operatorCount}/${plan.canonicalPre2023.query.operatorBudget} (${plan.canonicalPre2023.query.engine})`,
    "",
    divider,
    plan.contemporaryPost2023.heading,
    divider,
    `Dork       : ${plan.contemporaryPost2023.query.compiledQuery}`,
    `Engine URL : ${plan.contemporaryPost2023.query.searchUrl}`,
    `Blocked    : ${plan.contemporaryPost2023.query.excludedSitesInline.length} inline spam domains + 60+ post-fetch blocklist & SlopClassifier`,
    `Operators  : ${plan.contemporaryPost2023.query.operatorCount}/${plan.contemporaryPost2023.query.operatorBudget} (${plan.contemporaryPost2023.query.engine})`,
    "",
    divider,
    DIFFERENTIAL_HEADING,
    divider,
    `Status     : ${plan.differential.status}`,
    `Synthesis  : ${plan.differential.synthesis}`
  ];

  for (const sig of plan.differential.conflictSignals) {
    lines.push(`  - [${sig.severity} | ${sig.kind}] ${sig.summary}`);
  }

  return lines.join("\n");
}

export function formatSplitHorizonSearchReport(report: SplitHorizonSearchReport): string {
  const divider = "=".repeat(72);
  const lines: string[] = [
    divider,
    report.canonicalPre2023.heading,
    divider,
    `Dork    : ${report.canonicalPre2023.query.compiledQuery}`,
    `Archive : Kept ${report.canonicalPre2023.results.stats.keptCount}/${report.canonicalPre2023.results.stats.total} human canonical result(s)`
  ];

  if (report.canonicalPre2023.results.kept.length === 0) {
    lines.push("  (No canonical pre-cutoff results matched)");
  } else {
    for (const item of report.canonicalPre2023.results.kept) {
      lines.push(
        `  * [${item.source ?? "web"} | rank=${item.rankScore} | slop=${item.classification.score}] ${item.title}`,
        `    URL: ${item.url}`
      );
    }
  }

  lines.push(
    "",
    divider,
    report.contemporaryPost2023.heading,
    divider,
    `Dork    : ${report.contemporaryPost2023.query.compiledQuery}`,
    `Audited : Kept ${report.contemporaryPost2023.results.stats.keptCount}/${report.contemporaryPost2023.results.stats.total} | Purged ${report.contemporaryPost2023.results.stats.discardedCount} (${report.contemporaryPost2023.results.stats.blockedDomainCount} blocked domain(s), ${report.contemporaryPost2023.results.stats.slopCount} slop)`
  );

  if (report.contemporaryPost2023.results.kept.length === 0) {
    lines.push("  (No clean contemporary results survived anti-slop audit)");
  } else {
    for (const item of report.contemporaryPost2023.results.kept) {
      lines.push(
        `  * [${item.source ?? "web"} | rank=${item.rankScore} | slop=${item.classification.score}] ${item.title}`,
        `    URL: ${item.url}`
      );
    }
  }

  lines.push(
    "",
    divider,
    DIFFERENTIAL_HEADING,
    divider,
    `Status    : ${report.differential.status}`,
    `Synthesis : ${report.differential.synthesis}`
  );

  if (report.differential.canonicalOnlyTerms.length > 0) {
    lines.push(`Pre-${report.cutoffYear} Exclusive Terms  : ${report.differential.canonicalOnlyTerms.join(", ")}`);
  }
  if (report.differential.contemporaryOnlyTerms.length > 0) {
    lines.push(`Post-${report.cutoffYear} Exclusive Terms : ${report.differential.contemporaryOnlyTerms.join(", ")}`);
  }
  for (const sig of report.differential.conflictSignals) {
    lines.push(`  - [${sig.severity} | ${sig.kind}] ${sig.summary}`);
  }

  return lines.join("\n");
}

export function buildSplitHorizonQueryPlan(
  rawQuery: string,
  dorks: TemporalDorkEngine,
  router: CommunityRouter,
  options: DorkOptions = {},
  cutoffYear = 2023
): SplitHorizonQueryPlan {
  const cleanQuery = sanitizeRawQuery(rawQuery);
  if (cleanQuery.length === 0) {
    throw new Error("Query cannot be empty or whitespace-only.");
  }

  const baseEngine = options.engine ?? "google";
  const afterCanonical = options.after ?? "2010";
  const beforeCanonical = String(cutoffYear);

  const canonicalIncludeSites =
    options.includeSites !== undefined && options.includeSites.length > 0
      ? options.includeSites
      : CANONICAL_PRIORITY_SITES;

  const laneAOptions: DorkOptions = {
    era: "human-classic",
    after: afterCanonical,
    before: beforeCanonical,
    overrideTemporal: true,
    smartTemporal: false,
    includeSites: canonicalIncludeSites,
    engine: baseEngine
  };
  if (options.searxngBaseUrl !== undefined) {
    laneAOptions.searxngBaseUrl = options.searxngBaseUrl;
  }

  const canonicalQuery = dorks.compile(cleanQuery, laneAOptions);
  const verticalRoutes = router.buildVerticalRoutes(cleanQuery, {
    era: "human-classic",
    after: afterCanonical,
    before: beforeCanonical,
    overrideTemporal: true,
    smartTemporal: false,
    channels: ["reddit", "stackoverflow", "github", "engineering_blogs"],
    engine: baseEngine
  });

  const laneBOptions: DorkOptions = {
    era: "modern-curated",
    after: String(cutoffYear),
    overrideTemporal: true,
    smartTemporal: false,
    profile: "none",
    disableBlocklist: false,
    engine: baseEngine
  };
  if (options.excludeSites !== undefined) {
    laneBOptions.excludeSites = options.excludeSites;
  }
  if (options.maxInlineExclusions !== undefined) {
    laneBOptions.maxInlineExclusions = options.maxInlineExclusions;
  }
  if (options.searxngBaseUrl !== undefined) {
    laneBOptions.searxngBaseUrl = options.searxngBaseUrl;
  }

  const contemporaryQuery = dorks.compile(cleanQuery, laneBOptions);
  const differential = buildQueryPlanDifferential(cleanQuery, cutoffYear);

  const partialPlan: SplitHorizonQueryPlan = {
    rawQuery,
    cleanQuery,
    splitHorizon: true,
    cutoffYear,
    canonicalPre2023: {
      heading: CANONICAL_HEADING,
      query: canonicalQuery,
      archivedGithubUrl: buildArchivedGithubUrl(cleanQuery, cutoffYear),
      verticalRoutes
    },
    contemporaryPost2023: {
      heading: CONTEMPORARY_HEADING,
      query: contemporaryQuery
    },
    differential,
    formattedReport: ""
  };

  partialPlan.formattedReport = formatSplitHorizonQueryPlan(partialPlan);
  return partialPlan;
}
