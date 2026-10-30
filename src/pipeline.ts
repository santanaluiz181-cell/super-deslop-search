import { SlopClassifier } from "./classifier.js";
import { sanitizeRawQuery, TemporalDorkEngine } from "./dorks.js";
import { CommunityRouter } from "./router.js";
import {
  analyzeHorizonDifferential,
  buildArchivedGithubUrl,
  buildSplitHorizonQueryPlan,
  CANONICAL_HEADING,
  CONTEMPORARY_HEADING,
  formatSplitHorizonSearchReport
} from "./split-horizon.js";
import type {
  ClassifyInput,
  CompiledQuery,
  DorkOptions,
  FilterBatchReport,
  FilteredSearchResult,
  RawSearchResult,
  SlopClassification,
  SplitHorizonQueryPlan,
  SplitHorizonSearchReport,
  VerticalRoute
} from "./types.js";

export interface FilterOptions {
  maxSlopScore?: number;
  dropSuspicious?: boolean;
}

export interface LiveArchiveOptions {
  beforeYear?: number;
  limitPerSource?: number;
  timeoutMs?: number;
  sources?: readonly ("hackernews" | "stackoverflow" | "github" | "reddit")[];
}

export interface SplitHorizonLiveOptions extends FilterOptions {
  cutoffYear?: number;
  limitPerSource?: number;
  timeoutMs?: number;
  dorkOptions?: DorkOptions;
  laneAFetcher?: (query: string, cutoffYear: number) => Promise<RawSearchResult[]>;
  laneBFetcher?: (query: string, cutoffYear: number) => Promise<RawSearchResult[]>;
}

interface HnAlgoliaHit {
  title?: string;
  url?: string;
  objectID?: string;
  story_text?: string;
  created_at?: string;
  points?: number;
}

interface HnAlgoliaResponse {
  hits?: HnAlgoliaHit[];
}

interface StackOverflowItem {
  title?: string;
  link?: string;
  creation_date?: number;
  score?: number;
  tags?: string[];
}

interface StackOverflowResponse {
  items?: StackOverflowItem[];
}

interface GitHubIssueItem {
  title?: string;
  html_url?: string;
  body?: string | null;
  created_at?: string;
}

interface GitHubSearchResponse {
  items?: GitHubIssueItem[];
}

interface RedditChildData {
  title?: string;
  permalink?: string;
  selftext?: string;
  created_utc?: number;
  subreddit?: string;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{ data?: RedditChildData }>;
  };
}

export class DeslopSearch {
  public readonly dorks: TemporalDorkEngine;
  public readonly router: CommunityRouter;
  public readonly classifier: SlopClassifier;

  public constructor() {
    this.dorks = new TemporalDorkEngine();
    this.router = new CommunityRouter(this.dorks);
    this.classifier = new SlopClassifier();
  }

  public compileQuery(query: string, options: DorkOptions = {}): CompiledQuery {
    return this.dorks.compile(query, options);
  }

  public compileSplitHorizon(
    query: string,
    options: DorkOptions = {},
    cutoffYear = 2023
  ): SplitHorizonQueryPlan {
    return buildSplitHorizonQueryPlan(query, this.dorks, this.router, options, cutoffYear);
  }

  public buildRoutes(query: string, options: DorkOptions = {}): VerticalRoute[] {
    return this.router.buildVerticalRoutes(query, options);
  }

  public classifyText(input: ClassifyInput): SlopClassification {
    return this.classifier.classify(input);
  }

  public filterResults(
    results: readonly RawSearchResult[],
    options: FilterOptions = {}
  ): FilterBatchReport {
    const maxSlopScore = options.maxSlopScore ?? 0.59;
    const kept: FilteredSearchResult[] = [];
    const discarded: FilteredSearchResult[] = [];
    let blockedDomainCount = 0;
    let slopCount = 0;

    for (const item of results) {
      const bodyToInspect = item.content ?? item.snippet ?? "";
      const classification = this.classifier.classify({
        text: bodyToInspect,
        title: item.title,
        url: item.url
      });

      const communityBonus = classification.trustedCommunityDomain ? 0.15 : 0;
      const techBonus = classification.technicalDensity * 0.2;
      const rankScore = Number(
        Math.max(0, Math.min(1, 1 - classification.score + communityBonus + techBonus)).toFixed(3)
      );

      const enriched: FilteredSearchResult = {
        ...item,
        classification,
        rankScore
      };

      if (classification.blockedDomain) {
        blockedDomainCount += 1;
      }
      if (classification.verdict === "SLOP") {
        slopCount += 1;
      }

      const shouldDrop =
        classification.blockedDomain ||
        classification.score > maxSlopScore ||
        classification.verdict === "SLOP" ||
        (options.dropSuspicious === true && classification.verdict === "SUSPICIOUS");

      if (shouldDrop) {
        discarded.push(enriched);
      } else {
        kept.push(enriched);
      }
    }

    kept.sort((a, b) => b.rankScore - a.rankScore);

    return {
      kept,
      discarded,
      stats: {
        total: results.length,
        keptCount: kept.length,
        discardedCount: discarded.length,
        blockedDomainCount,
        slopCount
      }
    };
  }

  public compareHorizons(
    rawQuery: string,
    canonicalRawResults: readonly RawSearchResult[],
    contemporaryRawResults: readonly RawSearchResult[],
    options: SplitHorizonLiveOptions = {}
  ): SplitHorizonSearchReport {
    const cleanQuery = sanitizeRawQuery(rawQuery);
    if (cleanQuery.length === 0) {
      throw new Error("Query cannot be empty or whitespace-only.");
    }
    const cutoffYear = options.cutoffYear ?? 2023;
    const plan = this.compileSplitHorizon(cleanQuery, options.dorkOptions ?? {}, cutoffYear);

    const filterOpts: FilterOptions = {};
    if (options.maxSlopScore !== undefined) {
      filterOpts.maxSlopScore = options.maxSlopScore;
    }
    if (options.dropSuspicious !== undefined) {
      filterOpts.dropSuspicious = options.dropSuspicious;
    }

    const filteredCanonical = this.filterResults(canonicalRawResults, filterOpts);
    const filteredContemporary = this.filterResults(contemporaryRawResults, filterOpts);
    const differential = analyzeHorizonDifferential(
      cleanQuery,
      filteredCanonical,
      filteredContemporary,
      cutoffYear
    );

    const report: SplitHorizonSearchReport = {
      rawQuery,
      cleanQuery,
      splitHorizon: true,
      cutoffYear,
      canonicalPre2023: {
        heading: CANONICAL_HEADING,
        query: plan.canonicalPre2023.query,
        archivedGithubUrl: buildArchivedGithubUrl(cleanQuery, cutoffYear),
        results: filteredCanonical
      },
      contemporaryPost2023: {
        heading: CONTEMPORARY_HEADING,
        query: plan.contemporaryPost2023.query,
        results: filteredContemporary
      },
      differential,
      formattedReport: ""
    };

    report.formattedReport = formatSplitHorizonSearchReport(report);
    return report;
  }

  public async liveArchiveSearch(
    rawQuery: string,
    options: LiveArchiveOptions = {}
  ): Promise<FilterBatchReport> {
    const clean = sanitizeRawQuery(rawQuery);
    if (clean.length === 0) {
      throw new Error("Query cannot be empty.");
    }
    const beforeYear = options.beforeYear ?? 2023;
    const limit = Math.max(1, Math.min(20, options.limitPerSource ?? 5));
    const timeoutMs = options.timeoutMs ?? 8000;
    const enabledSources = options.sources ?? ["hackernews", "stackoverflow", "github"];

    const rawItems = await this.fetchCanonicalPreCutoff(
      clean,
      beforeYear,
      limit,
      timeoutMs,
      enabledSources
    );
    return this.filterResults(rawItems);
  }

  public async liveSplitHorizonSearch(
    rawQuery: string,
    options: SplitHorizonLiveOptions = {}
  ): Promise<SplitHorizonSearchReport> {
    const clean = sanitizeRawQuery(rawQuery);
    if (clean.length === 0) {
      throw new Error("Query cannot be empty or whitespace-only.");
    }
    const cutoffYear = options.cutoffYear ?? 2023;
    const limit = Math.max(1, Math.min(20, options.limitPerSource ?? 4));
    const timeoutMs = options.timeoutMs ?? 8000;

    const laneAPromise =
      options.laneAFetcher !== undefined
        ? options.laneAFetcher(clean, cutoffYear)
        : this.fetchCanonicalPreCutoff(
            clean,
            cutoffYear,
            limit,
            timeoutMs,
            ["hackernews", "stackoverflow", "github", "reddit"]
          );

    const laneBPromise =
      options.laneBFetcher !== undefined
        ? options.laneBFetcher(clean, cutoffYear)
        : this.fetchContemporaryPostCutoff(clean, cutoffYear, limit, timeoutMs);

    // Parallel execution of Lane A (Pre-2023 Canonical) and Lane B (Post-2023 Contemporary)
    const [canonicalRaw, contemporaryRaw] = await Promise.all([laneAPromise, laneBPromise]);

    return this.compareHorizons(rawQuery, canonicalRaw, contemporaryRaw, options);
  }

  private async fetchCanonicalPreCutoff(
    cleanQuery: string,
    cutoffYear: number,
    limit: number,
    timeoutMs: number,
    enabledSources: readonly ("hackernews" | "stackoverflow" | "github" | "reddit")[]
  ): Promise<RawSearchResult[]> {
    const cutoffUnix = Math.floor(Date.UTC(cutoffYear, 0, 1, 0, 0, 0) / 1000);
    const tasks: Promise<RawSearchResult[]>[] = [];

    if (enabledSources.includes("hackernews")) {
      tasks.push(this.fetchHackerNews(cleanQuery, `<${cutoffUnix}`, limit, timeoutMs));
    }
    if (enabledSources.includes("stackoverflow")) {
      tasks.push(this.fetchStackOverflow(cleanQuery, { todate: cutoffUnix - 1 }, limit, timeoutMs));
    }
    if (enabledSources.includes("github")) {
      tasks.push(
        this.fetchGitHubIssues(`${cleanQuery} created:<${cutoffYear}-01-01`, limit, timeoutMs)
      );
    }
    if (enabledSources.includes("reddit")) {
      tasks.push(this.fetchRedditPreCutoff(cleanQuery, cutoffUnix, limit, timeoutMs));
    }

    const settled = await Promise.allSettled(tasks);
    const aggregated: RawSearchResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        aggregated.push(...outcome.value);
      }
    }
    return aggregated;
  }

  private async fetchContemporaryPostCutoff(
    cleanQuery: string,
    cutoffYear: number,
    limit: number,
    timeoutMs: number
  ): Promise<RawSearchResult[]> {
    const cutoffUnix = Math.floor(Date.UTC(cutoffYear, 0, 1, 0, 0, 0) / 1000);
    const settled = await Promise.allSettled([
      this.fetchHackerNews(cleanQuery, `>=${cutoffUnix}`, limit, timeoutMs),
      this.fetchStackOverflow(cleanQuery, { fromdate: cutoffUnix }, limit, timeoutMs),
      this.fetchGitHubIssues(`${cleanQuery} created:>=${cutoffYear}-01-01`, limit, timeoutMs)
    ]);

    const aggregated: RawSearchResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        aggregated.push(...outcome.value);
      }
    }
    return aggregated;
  }

  private async fetchHackerNews(
    query: string,
    createdFilterOp: string,
    limit: number,
    timeoutMs: number
  ): Promise<RawSearchResult[]> {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&numericFilters=${encodeURIComponent(`created_at_i${createdFilterOp}`)}&hitsPerPage=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return [];
    }
    const payload = (await res.json()) as HnAlgoliaResponse;
    const hits = payload.hits ?? [];
    const mapped: RawSearchResult[] = [];

    for (const hit of hits) {
      const title = hit.title ?? "";
      const fallbackUrl =
        hit.objectID !== undefined
          ? `https://news.ycombinator.com/item?id=${hit.objectID}`
          : "";
      const targetUrl = hit.url && hit.url.length > 0 ? hit.url : fallbackUrl;
      if (title.length === 0 || targetUrl.length === 0) {
        continue;
      }
      const item: RawSearchResult = {
        title,
        url: targetUrl,
        source: "hackernews"
      };
      if (hit.story_text !== undefined && hit.story_text.length > 0) {
        item.snippet = hit.story_text;
      }
      if (hit.created_at !== undefined) {
        item.publishedAt = hit.created_at;
      }
      mapped.push(item);
    }
    return mapped;
  }

  private async fetchStackOverflow(
    query: string,
    bounds: { fromdate?: number; todate?: number },
    limit: number,
    timeoutMs: number
  ): Promise<RawSearchResult[]> {
    const dateParams: string[] = [];
    if (bounds.fromdate !== undefined) {
      dateParams.push(`fromdate=${bounds.fromdate}`);
    }
    if (bounds.todate !== undefined) {
      dateParams.push(`todate=${bounds.todate}`);
    }
    const dateQuery = dateParams.length > 0 ? `&${dateParams.join("&")}` : "";
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}${dateQuery}&pagesize=${limit}&site=stackoverflow`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return [];
    }
    const payload = (await res.json()) as StackOverflowResponse;
    const items = payload.items ?? [];
    const mapped: RawSearchResult[] = [];

    for (const entry of items) {
      if (!entry.title || !entry.link) {
        continue;
      }
      const item: RawSearchResult = {
        title: entry.title,
        url: entry.link,
        snippet: `Tags: ${(entry.tags ?? []).join(", ")} | Score: ${entry.score ?? 0}`,
        source: "stackoverflow"
      };
      if (entry.creation_date !== undefined) {
        item.publishedAt = new Date(entry.creation_date * 1000).toISOString();
      }
      mapped.push(item);
    }
    return mapped;
  }

  private async fetchGitHubIssues(
    qualifiedQuery: string,
    limit: number,
    timeoutMs: number
  ): Promise<RawSearchResult[]> {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(qualifiedQuery)}&per_page=${limit}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "deslop-search-cli/1.1"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return [];
    }
    const payload = (await res.json()) as GitHubSearchResponse;
    const items = payload.items ?? [];
    const mapped: RawSearchResult[] = [];

    for (const issue of items) {
      if (!issue.title || !issue.html_url) {
        continue;
      }
      const item: RawSearchResult = {
        title: issue.title,
        url: issue.html_url,
        source: "github"
      };
      if (issue.body !== undefined && issue.body !== null && issue.body.length > 0) {
        item.snippet = issue.body.slice(0, 600);
      }
      if (issue.created_at !== undefined) {
        item.publishedAt = issue.created_at;
      }
      mapped.push(item);
    }
    return mapped;
  }

  private async fetchRedditPreCutoff(
    query: string,
    cutoffUnix: number,
    limit: number,
    timeoutMs: number
  ): Promise<RawSearchResult[]> {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=all&limit=${Math.min(25, limit * 4)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "deslop-search-cli/1.1"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return [];
    }
    const payload = (await res.json()) as RedditListingResponse;
    const children = payload.data?.children ?? [];
    const mapped: RawSearchResult[] = [];

    for (const wrapper of children) {
      if (mapped.length >= limit) {
        break;
      }
      const post = wrapper.data;
      if (
        post === undefined ||
        !post.title ||
        !post.permalink ||
        post.created_utc === undefined ||
        post.created_utc >= cutoffUnix
      ) {
        continue;
      }
      const item: RawSearchResult = {
        title: post.title,
        url: `https://old.reddit.com${post.permalink}`,
        publishedAt: new Date(post.created_utc * 1000).toISOString(),
        source: "reddit"
      };
      if (post.selftext !== undefined && post.selftext.length > 0) {
        item.snippet = post.selftext.slice(0, 500);
      }
      mapped.push(item);
    }
    return mapped;
  }
}

const defaultInstance = new DeslopSearch();

export function deslopQuery(query: string, options: DorkOptions = {}): CompiledQuery {
  return defaultInstance.compileQuery(query, options);
}

export function deslopSplitHorizon(
  query: string,
  options: DorkOptions = {},
  cutoffYear = 2023
): SplitHorizonQueryPlan {
  return defaultInstance.compileSplitHorizon(query, options, cutoffYear);
}

export function classifySlop(input: ClassifyInput): SlopClassification {
  return defaultInstance.classifyText(input);
}

export function filterSearchResults(
  results: readonly RawSearchResult[],
  options: FilterOptions = {}
): FilterBatchReport {
  return defaultInstance.filterResults(results, options);
}
