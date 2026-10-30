from __future__ import annotations

import re
from urllib.parse import quote

from .models import (
    CommunityChannelName,
    CommunityProfile,
    CompiledQuery,
    DorkOptions,
    SearchEngine,
    TemporalEra,
)
from .rules import load_rules

_ZERO_WIDTH_RE = re.compile(r"[\u200B-\u200D\uFEFF\u2060\u180E]")
_UNESCAPED_QUOTE_RE = re.compile(r'(?<!\\)"')
_EXISTING_BEFORE_RE = re.compile(r"\bbefore:\d{4}(?:-\d{2}(?:-\d{2})?)?\b", re.IGNORECASE)
_EXISTING_AFTER_RE = re.compile(r"\bafter:\d{4}(?:-\d{2}(?:-\d{2})?)?\b", re.IGNORECASE)
_EXISTING_SITE_TOKEN_RE = re.compile(r"(-?site:[^\s)]+)", re.IGNORECASE)

_MODERN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b202[3-9]\b"),
    re.compile(r"\breact\s*19\b", re.IGNORECASE),
    re.compile(r"\bnext\.?js\s*1[4-9]\b", re.IGNORECASE),
    re.compile(r"\bpython\s*3\.1[2-9]\b", re.IGNORECASE),
    re.compile(r"\btailwind(?:\s*css)?\s*v?4\b", re.IGNORECASE),
    re.compile(r"\bnode(?:\.?js)?\s*2[2-9]\b", re.IGNORECASE),
    re.compile(r"\btypescript\s*5\.[4-9]\b", re.IGNORECASE),
    re.compile(r"\bcve-202[3-9]-\d+", re.IGNORECASE),
)


def sanitize_raw_query(raw: str) -> str:
    stripped = re.sub(r"\s+", " ", _ZERO_WIDTH_RE.sub("", raw)).strip()
    if not stripped:
        return ""
    quotes = _UNESCAPED_QUOTE_RE.findall(stripped)
    if len(quotes) % 2 != 0:
        return f'{stripped}"'
    return stripped


def detect_modern_subject(query: str) -> bool:
    return any(pattern.search(query) is not None for pattern in _MODERN_PATTERNS)


def count_query_operators_and_terms(query: str) -> int:
    trimmed = query.strip()
    if not trimmed:
        return 0
    cleaned = trimmed.replace("(", " ").replace(")", " ")
    return len([tok for tok in cleaned.split() if tok])


def _resolve_temporal_bounds(
    era: TemporalEra, custom_after: str | None, custom_before: str | None
) -> tuple[str | None, str | None]:
    if custom_after is not None or custom_before is not None:
        after_val = custom_after.strip() if custom_after and custom_after.strip() else None
        before_val = custom_before.strip() if custom_before and custom_before.strip() else None
        return after_val, before_val

    if era == "human-classic":
        return "2010", "2023"
    if era == "pre-gpt4":
        return "2015", "2023-03-14"
    if era == "archival":
        return "2005", "2020"
    if era == "modern-curated":
        return "2023", None
    return None, None


def _collect_included_sites(
    profile: CommunityProfile,
    channels: tuple[CommunityChannelName, ...],
    include_sites: tuple[str, ...],
) -> list[str]:
    rules = load_rules()
    collected: list[str] = []
    seen: set[str] = set()

    def _add(domain: str) -> None:
        norm = domain.strip().lower()
        if norm.startswith("site:"):
            norm = norm[5:]
        if norm and norm not in seen:
            seen.add(norm)
            collected.append(norm)

    if profile != "none":
        for dom in rules.sources.get("profiles", {}).get(profile, []):
            _add(str(dom))

    for ch_name in channels:
        ch_cfg = rules.sources.get("channels", {}).get(ch_name, {})
        for dom in ch_cfg.get("sites", []):
            _add(str(dom))

    for dom in include_sites:
        _add(dom)

    return collected


def build_engine_search_url(
    compiled_query: str, engine: SearchEngine, searxng_base_url: str = "https://searx.be"
) -> str:
    encoded = quote(compiled_query, safe="")
    if engine == "google":
        return f"https://www.google.com/search?q={encoded}&udm=14"
    if engine == "duckduckgo":
        return f"https://duckduckgo.com/?q={encoded}&kp=-2&k1=-1"
    if engine == "brave":
        return f"https://search.brave.com/search?q={encoded}&source=web"
    if engine == "kagi":
        return f"https://kagi.com/search?q={encoded}"
    if engine == "bing":
        return f"https://www.bing.com/search?q={encoded}"
    base = searxng_base_url.rstrip("/")
    return f"{base}/search?q={encoded}&categories=general"


class TemporalDorkEngine:
    def compile(self, raw_query: str, options: DorkOptions | None = None) -> CompiledQuery:
        opts = options or DorkOptions()
        rules = load_rules()
        clean_query = sanitize_raw_query(raw_query)
        if not clean_query:
            raise ValueError("Query cannot be empty or whitespace-only.")

        engine: SearchEngine = opts.engine
        limits: dict[str, int] = rules.blocklist.get("engineOperatorLimits", {})
        operator_budget = int(limits.get(engine, 32))
        warnings: list[str] = []

        era: TemporalEra = opts.era
        profile: CommunityProfile = opts.profile

        if detect_modern_subject(clean_query) and era in ("human-classic", "pre-gpt4", "archival"):
            if opts.smart_temporal:
                era = "modern-curated"
                if profile == "none" and not opts.channels and not opts.include_sites:
                    profile = "all_community"
                warnings.append(
                    "Detected post-2022 version/year in query; auto-shifted era to 'modern-curated' with community routing."
                )
            else:
                warnings.append(
                    "Query references a post-2022 version/year while 'before:2023' is active. Pass --era modern-curated or smart_temporal=True if results are empty."
                )

        base_query = clean_query
        if opts.override_temporal:
            base_query = _EXISTING_BEFORE_RE.sub("", base_query)
            base_query = _EXISTING_AFTER_RE.sub("", base_query)
            base_query = re.sub(r"\s+", " ", base_query).strip()

        existing_before = _EXISTING_BEFORE_RE.search(base_query) is not None
        existing_after = _EXISTING_AFTER_RE.search(base_query) is not None

        existing_positive: list[str] = []
        existing_negative: list[str] = []
        for token in _EXISTING_SITE_TOKEN_RE.findall(base_query):
            lower = token.lower()
            if lower.startswith("-site:"):
                dom = lower[6:]
                if dom not in existing_negative:
                    existing_negative.append(dom)
            elif lower.startswith("site:"):
                dom = lower[5:]
                if dom not in existing_positive:
                    existing_positive.append(dom)

        after_bound, before_bound = _resolve_temporal_bounds(era, opts.after, opts.before)
        temporal_operators: list[str] = []
        if after_bound is not None and not existing_after:
            temporal_operators.append(f"after:{after_bound}")
        if before_bound is not None and not existing_before:
            temporal_operators.append(f"before:{before_bound}")

        requested_sites = [
            s
            for s in _collect_included_sites(profile, opts.channels, opts.include_sites)
            if s not in existing_positive
        ]

        parts: list[str] = [base_query, *temporal_operators]
        included_sites: list[str] = list(existing_positive)

        if len(requested_sites) == 1:
            single = requested_sites[0]
            parts.append(f"site:{single}")
            included_sites.append(single)
        elif len(requested_sites) > 1:
            current_tokens = count_query_operators_and_terms(" ".join(parts))
            available = max(0, (operator_budget - current_tokens) // 2)
            capped = requested_sites[: max(1, available)]
            if len(capped) < len(requested_sites):
                warnings.append(
                    f"Trimmed positive site routing from {len(requested_sites)} to {len(capped)} domains to fit {engine} {operator_budget}-token limit."
                )
            or_clause = " OR ".join(f"site:{s}" for s in capped)
            parts.append(f"({or_clause})")
            included_sites.extend(capped)

        excluded_inline: list[str] = list(existing_negative)
        positive_set = set(included_sites)
        negative_set = set(existing_negative)

        should_inject_default = (not opts.disable_blocklist) and (len(included_sites) == 0)
        candidates: list[str] = []
        for dom in opts.exclude_sites:
            clean_dom = dom.strip().lower().removeprefix("-site:").removeprefix("site:")
            if clean_dom:
                candidates.append(clean_dom)
        if should_inject_default:
            for dom in rules.blocklist.get("defaultInlineExclusions", []):
                candidates.append(str(dom).lower())

        added_inline = 0
        for dom in candidates:
            if added_inline >= opts.max_inline_exclusions:
                break
            if dom in negative_set or dom in positive_set:
                continue
            current_count = count_query_operators_and_terms(" ".join(parts))
            if current_count + 1 > operator_budget:
                warnings.append(
                    f"Stopped inline -site: injection at {added_inline} domains to respect {engine} {operator_budget}-operator cap."
                )
                break
            parts.append(f"-site:{dom}")
            negative_set.add(dom)
            excluded_inline.append(dom)
            added_inline += 1

        compiled_query = " ".join(parts)
        operator_count = count_query_operators_and_terms(compiled_query)
        search_url = build_engine_search_url(compiled_query, engine, opts.searxng_base_url)

        return CompiledQuery(
            raw_query=raw_query,
            clean_query=clean_query,
            compiled_query=compiled_query,
            engine=engine,
            search_url=search_url,
            era_applied=era,
            temporal_operators=temporal_operators,
            included_sites=included_sites,
            excluded_sites_inline=excluded_inline,
            operator_count=operator_count,
            operator_budget=operator_budget,
            warnings=warnings,
        )
