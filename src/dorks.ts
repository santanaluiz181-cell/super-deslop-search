import { loadRules } from "./rules.js";
import type {
  CommunityChannelName,
  CommunityProfile,
  CompiledQuery,
  DorkOptions,
  SearchEngine,
  TemporalEra
} from "./types.js";

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;
const EXISTING_BEFORE_RE = /\bbefore:\d{4}(?:-\d{2}(?:-\d{2})?)?\b/i;
const EXISTING_AFTER_RE = /\bafter:\d{4}(?:-\d{2}(?:-\d{2})?)?\b/i;
const EXISTING_SITE_TOKEN_RE = /(-?site:[^\s)]+)/gi;

const MODERN_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /\b202[3-9]\b/,
  /\breact\s*19\b/i,
  /\bnext\.?js\s*1[4-9]\b/i,
  /\bpython\s*3\.1[2-9]\b/i,
  /\btailwind(?:\s*css)?\s*v?4\b/i,
  /\bnode(?:\.?js)?\s*2[2-9]\b/i,
  /\btypescript\s*5\.[4-9]\b/i,
  /\bcve-202[3-9]-\d+/i
];

export function sanitizeRawQuery(input: string): string {
  const stripped = input.replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();
  if (stripped.length === 0) {
    return "";
  }
  const unescapedQuotes = stripped.match(/(?<!\\)"/g);
  if (unescapedQuotes !== null && unescapedQuotes.length % 2 !== 0) {
    return `${stripped}"`;
  }
  return stripped;
}

export function detectModernSubject(query: string): boolean {
  return MODERN_ARTIFACT_PATTERNS.some((pattern) => pattern.test(query));
}

export function countQueryOperatorsAndTerms(query: string): number {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const tokens = trimmed
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tokens.length;
}

function resolveTemporalBounds(
  era: TemporalEra,
  customAfter: string | undefined,
  customBefore: string | undefined
): { after?: string; before?: string } {
  if (customAfter !== undefined || customBefore !== undefined) {
    const bounds: { after?: string; before?: string } = {};
    if (customAfter !== undefined && customAfter.trim().length > 0) {
      bounds.after = customAfter.trim();
    }
    if (customBefore !== undefined && customBefore.trim().length > 0) {
      bounds.before = customBefore.trim();
    }
    return bounds;
  }

  switch (era) {
    case "human-classic":
      return { after: "2010", before: "2023" };
    case "pre-gpt4":
      return { after: "2015", before: "2023-03-14" };
    case "archival":
      return { after: "2005", before: "2020" };
    case "modern-curated":
      return { after: "2023" };
    case "none":
      return {};
  }
}

function collectIncludedSites(
  profile: CommunityProfile,
  channels: readonly CommunityChannelName[] | undefined,
  includeSites: readonly string[] | undefined
): string[] {
  const rules = loadRules();
  const siteSet = new Set<string>();

  if (profile !== "none") {
    const profileSites = rules.sources.profiles[profile];
    for (const s of profileSites) {
      siteSet.add(s.trim().toLowerCase());
    }
  }

  if (channels !== undefined) {
    for (const channelName of channels) {
      const channel = rules.sources.channels[channelName];
      for (const s of channel.sites) {
        siteSet.add(s.trim().toLowerCase());
      }
    }
  }

  if (includeSites !== undefined) {
    for (const s of includeSites) {
      const clean = s.trim().toLowerCase().replace(/^site:/i, "");
      if (clean.length > 0) {
        siteSet.add(clean);
      }
    }
  }

  return Array.from(siteSet);
}

export function buildEngineSearchUrl(
  compiledQuery: string,
  engine: SearchEngine,
  searxngBaseUrl = "https://searx.be"
): string {
  const encoded = encodeURIComponent(compiledQuery);
  switch (engine) {
    case "google":
      // udm=14 forces Google's clean Web-only tab, stripping synthetic AI Overviews and widget clutter
      return `https://www.google.com/search?q=${encoded}&udm=14`;
    case "duckduckgo":
      return `https://duckduckgo.com/?q=${encoded}&kp=-2&k1=-1`;
    case "brave":
      return `https://search.brave.com/search?q=${encoded}&source=web`;
    case "kagi":
      return `https://kagi.com/search?q=${encoded}`;
    case "bing":
      return `https://www.bing.com/search?q=${encoded}`;
    case "searxng": {
      const base = searxngBaseUrl.replace(/\/+$/, "");
      return `${base}/search?q=${encoded}&categories=general`;
    }
  }
}

export class TemporalDorkEngine {
  public compile(rawQuery: string, options: DorkOptions = {}): CompiledQuery {
    const rules = loadRules();
    const cleanQuery = sanitizeRawQuery(rawQuery);
    if (cleanQuery.length === 0) {
      throw new Error("Query cannot be empty or whitespace-only.");
    }

    const engine: SearchEngine = options.engine ?? "google";
    const operatorBudget = rules.blocklist.engineOperatorLimits[engine];
    const warnings: string[] = [];

    let era: TemporalEra = options.era ?? "human-classic";
    let profile: CommunityProfile = options.profile ?? "none";

    const hasModernSubject = detectModernSubject(cleanQuery);
    if (hasModernSubject && (era === "human-classic" || era === "pre-gpt4" || era === "archival")) {
      if (options.smartTemporal === true) {
        era = "modern-curated";
        if (profile === "none" && options.channels === undefined && options.includeSites === undefined) {
          profile = "all_community";
        }
        warnings.push(
          "Detected post-2022 version/year in query; auto-shifted era to 'modern-curated' with community routing."
        );
      } else {
        warnings.push(
          "Query references a post-2022 version/year while 'before:2023' is active. Pass --era modern-curated or smartTemporal: true if results are empty."
        );
      }
    }

    let baseQuery = cleanQuery;
    if (options.overrideTemporal === true) {
      baseQuery = baseQuery
        .replace(/\bbefore:\d{4}(?:-\d{2}(?:-\d{2})?)?\b/gi, "")
        .replace(/\bafter:\d{4}(?:-\d{2}(?:-\d{2})?)?\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const existingBefore = EXISTING_BEFORE_RE.test(baseQuery);
    const existingAfter = EXISTING_AFTER_RE.test(baseQuery);

    const existingPositiveSites = new Set<string>();
    const existingNegativeSites = new Set<string>();
    const siteMatches = baseQuery.match(EXISTING_SITE_TOKEN_RE) ?? [];
    for (const token of siteMatches) {
      const lower = token.toLowerCase();
      if (lower.startsWith("-site:")) {
        existingNegativeSites.add(lower.slice(6));
      } else if (lower.startsWith("site:")) {
        existingPositiveSites.add(lower.slice(5));
      }
    }

    const bounds = resolveTemporalBounds(era, options.after, options.before);
    const temporalOperators: string[] = [];
    if (bounds.after !== undefined && !existingAfter) {
      temporalOperators.push(`after:${bounds.after}`);
    }
    if (bounds.before !== undefined && !existingBefore) {
      temporalOperators.push(`before:${bounds.before}`);
    }

    const requestedSites = collectIncludedSites(profile, options.channels, options.includeSites).filter(
      (s) => !existingPositiveSites.has(s)
    );

    const parts: string[] = [baseQuery];
    for (const op of temporalOperators) {
      parts.push(op);
    }

    const includedSites: string[] = Array.from(existingPositiveSites);
    if (requestedSites.length === 1) {
      const single = requestedSites[0];
      if (single !== undefined) {
        parts.push(`site:${single}`);
        includedSites.push(single);
      }
    } else if (requestedSites.length > 1) {
      // Reserve tokens so site:(A OR B) never overflows engine operator cap
      const currentTokens = countQueryOperatorsAndTerms(parts.join(" "));
      const availableForPositive = Math.max(0, Math.floor((operatorBudget - currentTokens) / 2));
      const cappedSites = requestedSites.slice(0, Math.max(1, availableForPositive));
      if (cappedSites.length < requestedSites.length) {
        warnings.push(
          `Trimmed positive site routing from ${requestedSites.length} to ${cappedSites.length} domains to fit ${engine} ${operatorBudget}-token limit.`
        );
      }
      parts.push(`(${cappedSites.map((s) => `site:${s}`).join(" OR ")})`);
      includedSites.push(...cappedSites);
    }

    const excludedSitesInline: string[] = Array.from(existingNegativeSites);
    const positiveLookup = new Set(includedSites);

    // Only inject -site: exclusions when no strict positive site: whitelist is already constraining all results,
    // or when user explicitly supplied excludeSites.
    const shouldInjectDefaultBlocklist =
      options.disableBlocklist !== true && includedSites.length === 0;

    const candidateExclusions: string[] = [];
    if (options.excludeSites !== undefined) {
      for (const s of options.excludeSites) {
        const clean = s.trim().toLowerCase().replace(/^-?site:/i, "");
        if (clean.length > 0) {
          candidateExclusions.push(clean);
        }
      }
    }
    if (shouldInjectDefaultBlocklist) {
      for (const s of rules.blocklist.defaultInlineExclusions) {
        candidateExclusions.push(s.toLowerCase());
      }
    }

    const maxInline = options.maxInlineExclusions ?? 12;
    let addedInlineCount = 0;

    for (const domain of candidateExclusions) {
      if (addedInlineCount >= maxInline) {
        break;
      }
      if (existingNegativeSites.has(domain) || positiveLookup.has(domain)) {
        continue;
      }
      const currentCount = countQueryOperatorsAndTerms(parts.join(" "));
      if (currentCount + 1 > operatorBudget) {
        warnings.push(
          `Stopped inline -site: injection at ${addedInlineCount} domains to respect ${engine} ${operatorBudget}-operator cap.`
        );
        break;
      }
      parts.push(`-site:${domain}`);
      existingNegativeSites.add(domain);
      excludedSitesInline.push(domain);
      addedInlineCount += 1;
    }

    const compiledQuery = parts.join(" ");
    const operatorCount = countQueryOperatorsAndTerms(compiledQuery);
    const searchUrl = buildEngineSearchUrl(compiledQuery, engine, options.searxngBaseUrl);

    return {
      rawQuery,
      cleanQuery,
      compiledQuery,
      engine,
      searchUrl,
      eraApplied: era,
      temporalOperators,
      includedSites,
      excludedSitesInline,
      operatorCount,
      operatorBudget,
      warnings
    };
  }
}
