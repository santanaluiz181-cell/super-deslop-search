import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { BlocklistData, SlopLexiconData, SourcesData } from "./types.js";

export interface LoadedRules {
  blocklist: BlocklistData;
  sources: SourcesData;
  slopLexicon: SlopLexiconData;
  allBlockedDomains: string[];
  allTrustedDomains: string[];
}

let cachedRules: LoadedRules | undefined;

function resolveDataDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..", "data");
}

function readJsonFile<T>(filePath: string): T {
  const raw = readFileSync(filePath, { encoding: "utf-8" });
  return JSON.parse(raw) as T;
}

export function loadRules(forceReload = false): LoadedRules {
  if (cachedRules !== undefined && !forceReload) {
    return cachedRules;
  }

  const dataDir = resolveDataDir();
  const blocklist = readJsonFile<BlocklistData>(resolve(dataDir, "blocklist.json"));
  const sources = readJsonFile<SourcesData>(resolve(dataDir, "sources.json"));
  const slopLexicon = readJsonFile<SlopLexiconData>(resolve(dataDir, "slop-lexicon.json"));

  const blockedSet = new Set<string>();
  for (const category of Object.values(blocklist.categories)) {
    for (const domain of category.domains) {
      blockedSet.add(domain.trim().toLowerCase());
    }
  }
  for (const domain of blocklist.defaultInlineExclusions) {
    blockedSet.add(domain.trim().toLowerCase());
  }

  const trustedSet = new Set<string>();
  for (const channel of Object.values(sources.channels)) {
    for (const site of channel.sites) {
      trustedSet.add(site.trim().toLowerCase());
    }
  }

  cachedRules = {
    blocklist,
    sources,
    slopLexicon,
    allBlockedDomains: Array.from(blockedSet),
    allTrustedDomains: Array.from(trustedSet)
  };

  return cachedRules;
}

export function extractDomainOrPathPrefix(urlString: string): string {
  const trimmed = urlString.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    return pathname.length > 0 && pathname !== "/" ? `${host}${pathname}` : host;
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

export function matchDomainAgainstList(
  urlString: string,
  candidates: readonly string[]
): string | undefined {
  const normalized = extractDomainOrPathPrefix(urlString);
  if (normalized.length === 0) {
    return undefined;
  }
  const slashIndex = normalized.indexOf("/");
  const hostOnly = slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);

  for (const candidate of candidates) {
    const cleanCandidate = candidate.toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
    if (cleanCandidate.includes("/")) {
      if (normalized === cleanCandidate || normalized.startsWith(`${cleanCandidate}/`)) {
        return cleanCandidate;
      }
    } else if (hostOnly === cleanCandidate || hostOnly.endsWith(`.${cleanCandidate}`)) {
      return cleanCandidate;
    }
  }
  return undefined;
}
