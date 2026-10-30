export type SearchEngine =
  | "google"
  | "duckduckgo"
  | "brave"
  | "kagi"
  | "searxng"
  | "bing";

export type TemporalEra =
  | "human-classic"
  | "pre-gpt4"
  | "archival"
  | "modern-curated"
  | "none";

export type CommunityProfile =
  | "none"
  | "all_community"
  | "discussions"
  | "qa"
  | "code"
  | "blogs"
  | "forums";

export type CommunityChannelName =
  | "reddit"
  | "stackoverflow"
  | "github"
  | "hackernews"
  | "indie_forums"
  | "engineering_blogs";

export interface DorkOptions {
  era?: TemporalEra;
  before?: string;
  after?: string;
  overrideTemporal?: boolean;
  smartTemporal?: boolean;
  splitHorizon?: boolean;
  profile?: CommunityProfile;
  channels?: readonly CommunityChannelName[];
  includeSites?: readonly string[];
  excludeSites?: readonly string[];
  disableBlocklist?: boolean;
  engine?: SearchEngine;
  maxInlineExclusions?: number;
  searxngBaseUrl?: string;
}

export interface CompiledQuery {
  rawQuery: string;
  cleanQuery: string;
  compiledQuery: string;
  engine: SearchEngine;
  searchUrl: string;
  eraApplied: TemporalEra;
  temporalOperators: string[];
  includedSites: string[];
  excludedSitesInline: string[];
  operatorCount: number;
  operatorBudget: number;
  warnings: string[];
}

export interface VerticalRoute {
  channel: string;
  label: string;
  compiledQuery: string;
  engineUrl: string;
  nativeSearchUrl?: string;
}

export type SlopVerdict = "AUTHENTIC" | "SUSPICIOUS" | "SLOP";

export interface SlopSignal {
  code: string;
  weight: number;
  detail: string;
}

export interface ClassifyInput {
  text: string;
  title?: string;
  url?: string;
}

export interface SlopClassification {
  score: number;
  verdict: SlopVerdict;
  blockedDomain: boolean;
  trustedCommunityDomain: boolean;
  matchedDomain?: string;
  technicalDensity: number;
  paragraphBurstinessCv?: number;
  sentenceBurstinessCv?: number;
  signals: SlopSignal[];
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  publishedAt?: string;
  source?: string;
}

export interface FilteredSearchResult extends RawSearchResult {
  classification: SlopClassification;
  rankScore: number;
}

export interface FilterBatchReport {
  kept: FilteredSearchResult[];
  discarded: FilteredSearchResult[];
  stats: {
    total: number;
    keptCount: number;
    discardedCount: number;
    blockedDomainCount: number;
    slopCount: number;
  };
}

export type DivergenceKind =
  | "deprecation_or_breaking_shift"
  | "version_drift"
  | "emergent_terminology"
  | "anachronism_warning"
  | "slop_saturation_warning"
  | "routing_asymmetry";

export type DivergenceSeverity = "INFO" | "MEDIUM" | "HIGH";

export type DifferentialStatus =
  | "CONVERGENT"
  | "DIVERGENT"
  | "ANACHRONISTIC"
  | "SLOP_CONTAMINATED"
  | "QUERY_PLAN";

export interface HorizonDivergenceSignal {
  kind: DivergenceKind;
  severity: DivergenceSeverity;
  summary: string;
}

export interface HorizonDifferential {
  status: DifferentialStatus;
  canonicalOnlyTerms: string[];
  contemporaryOnlyTerms: string[];
  conflictSignals: HorizonDivergenceSignal[];
  synthesis: string;
}

export interface SplitHorizonQueryPlan {
  rawQuery: string;
  cleanQuery: string;
  splitHorizon: true;
  cutoffYear: number;
  canonicalPre2023: {
    heading: "[HORIZONTE CANÔNICO: PRÉ-2023]";
    query: CompiledQuery;
    archivedGithubUrl: string;
    verticalRoutes: VerticalRoute[];
  };
  contemporaryPost2023: {
    heading: "[HORIZONTE CONTEMPORÂNEO: PÓS-2023]";
    query: CompiledQuery;
  };
  differential: HorizonDifferential;
  formattedReport: string;
}

export interface SplitHorizonSearchReport {
  rawQuery: string;
  cleanQuery: string;
  splitHorizon: true;
  cutoffYear: number;
  canonicalPre2023: {
    heading: "[HORIZONTE CANÔNICO: PRÉ-2023]";
    query: CompiledQuery;
    archivedGithubUrl: string;
    results: FilterBatchReport;
  };
  contemporaryPost2023: {
    heading: "[HORIZONTE CONTEMPORÂNEO: PÓS-2023]";
    query: CompiledQuery;
    results: FilterBatchReport;
  };
  differential: HorizonDifferential;
  formattedReport: string;
}

export interface BlocklistCategory {
  priority: number;
  description: string;
  domains: string[];
}

export interface BlocklistData {
  version: string;
  description: string;
  engineOperatorLimits: Record<SearchEngine, number>;
  categories: Record<string, BlocklistCategory>;
  defaultInlineExclusions: string[];
}

export interface SourceChannelConfig {
  label: string;
  sites: string[];
  dorkHints?: string[];
  urlPatterns?: string[];
}

export interface SourcesData {
  version: string;
  description: string;
  channels: Record<CommunityChannelName, SourceChannelConfig>;
  profiles: Record<Exclude<CommunityProfile, "none">, string[]>;
}

export interface SlopLexiconData {
  version: string;
  description: string;
  thresholds: {
    suspicious: number;
    slop: number;
  };
  weights: {
    jargonPhrase: number;
    openingClichedHook: number;
    closingSummaryTemplate: number;
    boldColonListicle: number;
    uniformParagraphSymmetry: number;
    lowSentenceBurstiness: number;
    emDashOveruse: number;
    seoYearBait: number;
    fakeTranslationArtifact: number;
    highTechnicalDensityBonus: number;
  };
  phrases: {
    en: string[];
    pt: string[];
  };
  openingHooks: string[];
  closingHooks: string[];
  seoTitleBait: string[];
  fakeTranslationMarkers: string[];
}
