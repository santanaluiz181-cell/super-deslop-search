from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

SearchEngine = Literal["google", "duckduckgo", "brave", "kagi", "searxng", "bing"]
TemporalEra = Literal["human-classic", "pre-gpt4", "archival", "modern-curated", "none"]
CommunityProfile = Literal[
    "none", "all_community", "discussions", "qa", "code", "blogs", "forums"
]
CommunityChannelName = Literal[
    "reddit",
    "stackoverflow",
    "github",
    "hackernews",
    "indie_forums",
    "engineering_blogs",
]
SlopVerdict = Literal["AUTHENTIC", "SUSPICIOUS", "SLOP"]


@dataclass(frozen=True)
class DorkOptions:
    era: TemporalEra = "human-classic"
    before: str | None = None
    after: str | None = None
    override_temporal: bool = False
    smart_temporal: bool = False
    split_horizon: bool = False
    profile: CommunityProfile = "none"
    channels: tuple[CommunityChannelName, ...] = ()
    include_sites: tuple[str, ...] = ()
    exclude_sites: tuple[str, ...] = ()
    disable_blocklist: bool = False
    engine: SearchEngine = "google"
    max_inline_exclusions: int = 12
    searxng_base_url: str = "https://searx.be"


@dataclass(frozen=True)
class CompiledQuery:
    raw_query: str
    clean_query: str
    compiled_query: str
    engine: SearchEngine
    search_url: str
    era_applied: TemporalEra
    temporal_operators: list[str]
    included_sites: list[str]
    excluded_sites_inline: list[str]
    operator_count: int
    operator_budget: int
    warnings: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class VerticalRoute:
    channel: str
    label: str
    compiled_query: str
    engine_url: str
    native_search_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if data["native_search_url"] is None:
            del data["native_search_url"]
        return data


@dataclass(frozen=True)
class SlopSignal:
    code: str
    weight: float
    detail: str


@dataclass(frozen=True)
class SlopClassification:
    score: float
    verdict: SlopVerdict
    blocked_domain: bool
    trusted_community_domain: bool
    technical_density: float
    signals: list[SlopSignal] = field(default_factory=list)
    matched_domain: str | None = None
    paragraph_burstiness_cv: float | None = None
    sentence_burstiness_cv: float | None = None

    def to_dict(self) -> dict[str, Any]:
        raw = asdict(self)
        return {k: v for k, v in raw.items() if v is not None}


@dataclass(frozen=True)
class RawSearchResult:
    title: str
    url: str
    snippet: str = ""
    content: str = ""
    published_at: str | None = None
    source: str | None = None


@dataclass(frozen=True)
class FilteredSearchResult:
    title: str
    url: str
    classification: SlopClassification
    rank_score: float
    snippet: str = ""
    content: str = ""
    published_at: str | None = None
    source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        raw = asdict(self)
        return {k: v for k, v in raw.items() if v is not None and v != ""}


@dataclass(frozen=True)
class FilterBatchReport:
    kept: list[FilteredSearchResult]
    discarded: list[FilteredSearchResult]
    stats: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "kept": [item.to_dict() for item in self.kept],
            "discarded": [item.to_dict() for item in self.discarded],
            "stats": dict(self.stats),
        }


DivergenceKind = Literal[
    "deprecation_or_breaking_shift",
    "version_drift",
    "emergent_terminology",
    "anachronism_warning",
    "slop_saturation_warning",
    "routing_asymmetry",
]
DivergenceSeverity = Literal["INFO", "MEDIUM", "HIGH"]
DifferentialStatus = Literal[
    "CONVERGENT", "DIVERGENT", "ANACHRONISTIC", "SLOP_CONTAMINATED", "QUERY_PLAN"
]


@dataclass(frozen=True)
class HorizonDivergenceSignal:
    kind: DivergenceKind
    severity: DivergenceSeverity
    summary: str


@dataclass(frozen=True)
class HorizonDifferential:
    status: DifferentialStatus
    canonical_only_terms: list[str]
    contemporary_only_terms: list[str]
    conflict_signals: list[HorizonDivergenceSignal]
    synthesis: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SplitHorizonQueryPlan:
    raw_query: str
    clean_query: str
    cutoff_year: int
    canonical_pre_2023: dict[str, Any]
    contemporary_post_2023: dict[str, Any]
    differential: HorizonDifferential
    formatted_report: str
    split_horizon: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "rawQuery": self.raw_query,
            "cleanQuery": self.clean_query,
            "splitHorizon": self.split_horizon,
            "cutoffYear": self.cutoff_year,
            "canonicalPre2023": self.canonical_pre_2023,
            "contemporaryPost2023": self.contemporary_post_2023,
            "differential": self.differential.to_dict(),
            "formattedReport": self.formatted_report,
        }


@dataclass(frozen=True)
class SplitHorizonSearchReport:
    raw_query: str
    clean_query: str
    cutoff_year: int
    canonical_pre_2023: dict[str, Any]
    contemporary_post_2023: dict[str, Any]
    differential: HorizonDifferential
    formatted_report: str
    split_horizon: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "rawQuery": self.raw_query,
            "cleanQuery": self.clean_query,
            "splitHorizon": self.split_horizon,
            "cutoffYear": self.cutoff_year,
            "canonicalPre2023": self.canonical_pre_2023,
            "contemporaryPost2023": self.contemporary_post_2023,
            "differential": self.differential.to_dict(),
            "formattedReport": self.formatted_report,
        }
