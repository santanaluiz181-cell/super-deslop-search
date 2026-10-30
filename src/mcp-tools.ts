import { DeslopSearch } from "./pipeline.js";
import type {
  CommunityProfile,
  DorkOptions,
  RawSearchResult,
  SearchEngine,
  TemporalEra
} from "./types.js";

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const DESLOP_AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "deslop_build_query",
    description:
      "Compiles a raw web search query into a clean, operator-budgeted dork with temporal bounds (default after:2010 before:2023), spam farm exclusions (-site:...), community routing, clean engine URLs (Google udm=14), or a Dual Temporal Split-Horizon plan when split_horizon=true.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Raw search query." },
        split_horizon: {
          type: "boolean",
          default: false,
          description:
            "When true, emits parallel Lane A ([HORIZONTE CANÔNICO: PRÉ-2023]) and Lane B ([HORIZONTE CONTEMPORÂNEO: PÓS-2023]) dorks plus [DIFERENCIAL E CONFLITOS]."
        },
        era: {
          type: "string",
          enum: ["human-classic", "pre-gpt4", "archival", "modern-curated", "none"],
          default: "human-classic"
        },
        profile: {
          type: "string",
          enum: ["none", "all_community", "discussions", "qa", "code", "blogs", "forums"],
          default: "none"
        },
        engine: {
          type: "string",
          enum: ["google", "duckduckgo", "brave", "kagi", "searxng", "bing"],
          default: "google"
        },
        smartTemporal: {
          type: "boolean",
          default: true,
          description: "Auto-shifts to modern-curated when post-2022 versions/years appear in query."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "deslop_split_horizon",
    description:
      "Runs Dual Temporal Split-Horizon comparative search confronting [HORIZONTE CANÔNICO: PRÉ-2023] human literature with [HORIZONTE CONTEMPORÂNEO: PÓS-2023] audited data and generating a [DIFERENCIAL E CONFLITOS] divergence synthesis.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        split_horizon: { type: "boolean", default: true },
        live: { type: "boolean", default: true },
        cutoff_year: { type: "number", default: 2023 },
        limit_per_source: { type: "number", default: 4 },
        canonical_results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              content: { type: "string" }
            },
            required: ["title", "url"]
          }
        },
        contemporary_results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              content: { type: "string" }
            },
            required: ["title", "url"]
          }
        }
      },
      required: ["query"]
    }
  },
  {
    name: "deslop_classify_text",
    description:
      "Scores webpage text or snippets (0.0 to 1.0) for synthetic AI SEO slop using EN/PT-BR corporate jargon, Bold-Colon symmetry, paragraph uniformity, sentence burstiness, and technical density.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        title: { type: "string" },
        url: { type: "string" }
      },
      required: ["text"]
    }
  },
  {
    name: "deslop_filter_results",
    description:
      "Filters and re-ranks raw search hits, dropping blocked scraper clones and high-slop pages while boosting authentic community threads.",
    inputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              content: { type: "string" }
            },
            required: ["title", "url"]
          }
        },
        maxSlopScore: { type: "number", default: 0.59 }
      },
      required: ["results"]
    }
  }
];

const engineInstance = new DeslopSearch();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawResultsList(raw: unknown): RawSearchResult[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: RawSearchResult[] = [];
  for (const entry of raw) {
    if (isRecord(entry) && typeof entry["title"] === "string" && typeof entry["url"] === "string") {
      const item: RawSearchResult = {
        title: entry["title"],
        url: entry["url"]
      };
      if (typeof entry["snippet"] === "string") {
        item.snippet = entry["snippet"];
      }
      if (typeof entry["content"] === "string") {
        item.content = entry["content"];
      }
      if (typeof entry["source"] === "string") {
        item.source = entry["source"];
      }
      parsed.push(item);
    }
  }
  return parsed;
}

function extractDorkOptions(rawArgs: Record<string, unknown>): DorkOptions {
  const splitFlag =
    rawArgs["split_horizon"] === true || rawArgs["splitHorizon"] === true;
  const options: DorkOptions = {
    smartTemporal: typeof rawArgs["smartTemporal"] === "boolean" ? rawArgs["smartTemporal"] : true,
    splitHorizon: splitFlag
  };
  if (typeof rawArgs["era"] === "string") {
    options.era = rawArgs["era"] as TemporalEra;
  }
  if (typeof rawArgs["profile"] === "string") {
    options.profile = rawArgs["profile"] as CommunityProfile;
  }
  if (typeof rawArgs["engine"] === "string") {
    options.engine = rawArgs["engine"] as SearchEngine;
  }
  return options;
}

export function executeDeslopTool(toolName: string, rawArgs: unknown): unknown {
  if (!isRecord(rawArgs)) {
    throw new Error(`Invalid arguments for tool ${toolName}: expected an object.`);
  }

  switch (toolName) {
    case "deslop_build_query": {
      const query = typeof rawArgs["query"] === "string" ? rawArgs["query"] : "";
      const options = extractDorkOptions(rawArgs);
      const cutoffYear =
        typeof rawArgs["cutoff_year"] === "number" ? rawArgs["cutoff_year"] : 2023;
      if (options.splitHorizon === true) {
        return engineInstance.compileSplitHorizon(query, options, cutoffYear);
      }
      return engineInstance.compileQuery(query, options);
    }

    case "deslop_split_horizon": {
      const query = typeof rawArgs["query"] === "string" ? rawArgs["query"] : "";
      const cutoffYear =
        typeof rawArgs["cutoff_year"] === "number" ? rawArgs["cutoff_year"] : 2023;
      const options = extractDorkOptions(rawArgs);

      if (
        Array.isArray(rawArgs["canonical_results"]) ||
        Array.isArray(rawArgs["contemporary_results"])
      ) {
        const laneA = parseRawResultsList(rawArgs["canonical_results"]);
        const laneB = parseRawResultsList(rawArgs["contemporary_results"]);
        return engineInstance.compareHorizons(query, laneA, laneB, {
          cutoffYear,
          dorkOptions: options
        });
      }
      return engineInstance.compileSplitHorizon(query, options, cutoffYear);
    }

    case "deslop_classify_text": {
      const text = typeof rawArgs["text"] === "string" ? rawArgs["text"] : "";
      const input: { text: string; title?: string; url?: string } = { text };
      if (typeof rawArgs["title"] === "string") {
        input.title = rawArgs["title"];
      }
      if (typeof rawArgs["url"] === "string") {
        input.url = rawArgs["url"];
      }
      return engineInstance.classifyText(input);
    }

    case "deslop_filter_results": {
      const parsedResults = parseRawResultsList(rawArgs["results"]);
      const maxSlopScore =
        typeof rawArgs["maxSlopScore"] === "number" ? rawArgs["maxSlopScore"] : 0.59;
      return engineInstance.filterResults(parsedResults, { maxSlopScore });
    }

    default:
      throw new Error(`Unknown Deslop tool: ${toolName}`);
  }
}

export async function executeDeslopToolAsync(
  toolName: string,
  rawArgs: unknown
): Promise<unknown> {
  if (!isRecord(rawArgs)) {
    throw new Error(`Invalid arguments for tool ${toolName}: expected an object.`);
  }

  if (toolName === "deslop_split_horizon") {
    const hasOfflineBatches =
      Array.isArray(rawArgs["canonical_results"]) ||
      Array.isArray(rawArgs["contemporary_results"]);
    const wantLive = rawArgs["live"] !== false && !hasOfflineBatches;
    if (wantLive) {
      const query = typeof rawArgs["query"] === "string" ? rawArgs["query"] : "";
      const cutoffYear =
        typeof rawArgs["cutoff_year"] === "number" ? rawArgs["cutoff_year"] : 2023;
      const limitPerSource =
        typeof rawArgs["limit_per_source"] === "number" ? rawArgs["limit_per_source"] : 4;
      const options = extractDorkOptions(rawArgs);
      return engineInstance.liveSplitHorizonSearch(query, {
        cutoffYear,
        limitPerSource,
        dorkOptions: options
      });
    }
  }

  return executeDeslopTool(toolName, rawArgs);
}
