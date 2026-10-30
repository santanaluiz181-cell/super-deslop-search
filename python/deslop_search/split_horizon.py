from __future__ import annotations

import re
from urllib.parse import quote

from .dorks import TemporalDorkEngine, detect_modern_subject, sanitize_raw_query
from .models import (
    DifferentialStatus,
    DorkOptions,
    FilterBatchReport,
    HorizonDifferential,
    HorizonDivergenceSignal,
    SplitHorizonQueryPlan,
    SplitHorizonSearchReport,
)
from .router import CommunityRouter

CANONICAL_HEADING = "[HORIZONTE CANÔNICO: PRÉ-2023]"
CONTEMPORARY_HEADING = "[HORIZONTE CONTEMPORÂNEO: PÓS-2023]"
DIFFERENTIAL_HEADING = "[DIFERENCIAL E CONFLITOS]"

CANONICAL_PRIORITY_SITES: tuple[str, ...] = (
    "reddit.com",
    "stackoverflow.com",
    "github.com",
    "news.ycombinator.com",
    "lobste.rs",
    "danluu.com",
    "jvns.ca",
    "aphyr.com",
    "martinfowler.com",
)

_BREAKING_RE = re.compile(
    r"\b(?:deprecated|deprecation|obsolete|removed\s+in|replaced\s+by|breaking\s+change|breaking\s+changes|end-of-life|eol|superseded|no\s+longer\s+recommended|anti-pattern|vulnerable|vulnerability|cve-202[3-9]-\d+|descontinuado|obsoleto|substitu[íi]do\s+por|vulnerabilidade)\b",
    re.IGNORECASE,
)

_VERSION_OR_STD_RE = re.compile(
    r"\b(?:CVE-\d{4}-\d{4,7}|RFC\s?\d{3,5}|ES20\d{2}|HTTP/[123]|v\d+\.\d+(?:\.\d+)?|(?:React|Python|Node(?:\.js)?|Next(?:\.js)?|TypeScript|Tailwind|Go|Rust|PostgreSQL|Postgres|Linux)\s+v?\d+(?:\.\d+)?)\b",
    re.IGNORECASE,
)

_TECH_ID_RE = re.compile(
    r"\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z]+(?:[A-Z][a-z0-9]+)+|--[a-z0-9][a-z0-9-]{1,28})\b"
)

_STOP_IDS = {"http", "https", "html", "json", "true", "false", "null", "undefined"}


def _extract_salient_terms(texts: list[str], max_terms: int = 8) -> list[str]:
    counts: dict[str, tuple[str, int]] = {}
    for raw in texts:
        tokens = [*_VERSION_OR_STD_RE.findall(raw), *_TECH_ID_RE.findall(raw)]
        for tok in tokens:
            cleaned = re.sub(r"\s+", " ", tok.strip())
            key = cleaned.lower()
            if len(key) < 3 or key in _STOP_IDS:
                continue
            if key in counts:
                disp, cnt = counts[key]
                counts[key] = (disp, cnt + 1)
            else:
                counts[key] = (cleaned, 1)

    ranked = sorted(counts.values(), key=lambda item: (-item[1], item[0]))
    return [disp for disp, _ in ranked[:max_terms]]


def build_archived_github_url(clean_query: str, cutoff_year: int = 2023) -> str:
    q = f"{clean_query} archived:true created:<{cutoff_year}-01-01"
    return f"https://github.com/search?q={quote(q, safe='')}&type=repositories"


def analyze_horizon_differential(
    clean_query: str,
    lane_a: FilterBatchReport,
    lane_b: FilterBatchReport,
    cutoff_year: int = 2023,
) -> HorizonDifferential:
    texts_a = [f"{r.title} {r.content or r.snippet}" for r in lane_a.kept]
    texts_b = [f"{r.title} {r.content or r.snippet}" for r in lane_b.kept]

    terms_a = _extract_salient_terms(texts_a, 12)
    terms_b = _extract_salient_terms(texts_b, 12)

    lower_b = {t.lower() for t in terms_b}
    lower_a = {t.lower() for t in terms_a}

    canonical_only = [t for t in terms_a if t.lower() not in lower_b][:6]
    contemporary_only = [t for t in terms_b if t.lower() not in lower_a][:6]

    signals: list[HorizonDivergenceSignal] = []

    breaking_hits: list[str] = []
    seen_breaking: set[str] = set()
    for txt in texts_b:
        for match in _BREAKING_RE.findall(txt):
            norm = re.sub(r"\s+", " ", match.lower())
            if norm not in seen_breaking:
                seen_breaking.add(norm)
                breaking_hits.append(norm)

    if breaking_hits:
        preview = ", ".join(breaking_hits[:5])
        signals.append(
            HorizonDivergenceSignal(
                kind="deprecation_or_breaking_shift",
                severity="HIGH",
                summary=f"Post-{cutoff_year} sources flag breaking shifts, deprecations, or advisories ({preview}) that may invalidate pre-{cutoff_year} patterns.",
            )
        )

    versions_a = [t for t in canonical_only if any(ch.isdigit() for ch in t)]
    versions_b = [t for t in contemporary_only if any(ch.isdigit() for ch in t)]
    if versions_a and versions_b:
        signals.append(
            HorizonDivergenceSignal(
                kind="version_drift",
                severity="MEDIUM",
                summary=f"Version/standard shift detected: pre-{cutoff_year} references [{', '.join(versions_a)}] vs post-{cutoff_year} [{', '.join(versions_b)}].",
            )
        )

    if contemporary_only:
        signals.append(
            HorizonDivergenceSignal(
                kind="emergent_terminology",
                severity="INFO",
                summary=f"Emergent post-{cutoff_year} identifiers absent from canonical baseline: {', '.join(contemporary_only)}.",
            )
        )

    kept_a = lane_a.stats["keptCount"]
    kept_b = lane_b.stats["keptCount"]
    disc_b = lane_b.stats["discardedCount"]

    if kept_a == 0 and kept_b > 0:
        signals.append(
            HorizonDivergenceSignal(
                kind="anachronism_warning",
                severity="HIGH",
                summary=f"Zero canonical hits before {cutoff_year} vs {kept_b} audited contemporary hit(s). Subject likely originated post-{cutoff_year}; relying on before:{cutoff_year} alone would miss all primary facts.",
            )
        )

    if disc_b > 0:
        sev = "HIGH" if (kept_b == 0 or disc_b >= kept_b) else "MEDIUM"
        signals.append(
            HorizonDivergenceSignal(
                kind="slop_saturation_warning",
                severity=sev,  # type: ignore[arg-type]
                summary=(
                    f"Post-{cutoff_year} firewall purged {disc_b}/{lane_b.stats['total']} contemporary result(s) "
                    f"({lane_b.stats['blockedDomainCount']} blocked spam domain(s), {lane_b.stats['slopCount']} synthetic slop hit(s))."
                ),
            )
        )

    status: DifferentialStatus = "CONVERGENT"
    if kept_a == 0 and kept_b > 0:
        status = "ANACHRONISTIC"
    elif breaking_hits or (versions_a and versions_b):
        status = "DIVERGENT"
    elif kept_b == 0 and disc_b > 0:
        status = "SLOP_CONTAMINATED"

    if status == "ANACHRONISTIC":
        synthesis = f"Topic '{clean_query}' appears post-{cutoff_year} in origin; prioritize audited Contemporary Lane B while verifying against primary specs."
    elif status == "DIVERGENT":
        synthesis = f"Conceptual divergence detected between pre-{cutoff_year} human consensus ({kept_a} hit(s)) and post-{cutoff_year} audited updates ({kept_b} hit(s)); reconcile deprecations/CVEs before adopting legacy recipes."
    elif status == "SLOP_CONTAMINATED":
        synthesis = f"Contemporary post-{cutoff_year} SERP is heavily saturated with synthetic SEO filler; anchor reasoning on Canonical Pre-{cutoff_year} Lane A ({kept_a} authentic hit(s))."
    else:
        synthesis = f"Pre-{cutoff_year} canonical literature ({kept_a} hit(s)) and post-{cutoff_year} audited reality ({kept_b} hit(s)) remain aligned with no breaking contradictions detected."

    return HorizonDifferential(
        status=status,
        canonical_only_terms=canonical_only,
        contemporary_only_terms=contemporary_only,
        conflict_signals=signals,
        synthesis=synthesis,
    )


def build_query_plan_differential(clean_query: str, cutoff_year: int = 2023) -> HorizonDifferential:
    signals: list[HorizonDivergenceSignal] = [
        HorizonDivergenceSignal(
            kind="routing_asymmetry",
            severity="INFO",
            summary=(
                f"Lane A restricts before:{cutoff_year} to high-trust human communities "
                f"(Reddit, Stack Overflow, GitHub, HN, Indie Blogs); Lane B opens after:{cutoff_year} "
                "across the live web guarded by blocklist.json + heuristic anti-slop scoring."
            ),
        )
    ]
    if detect_modern_subject(clean_query):
        signals.append(
            HorizonDivergenceSignal(
                kind="anachronism_warning",
                severity="HIGH",
                summary=(
                    f"Query '{clean_query}' references a post-2022 artifact/year: expect foundational "
                    "precursors in Lane A and primary release/advisory facts in Lane B."
                ),
            )
        )
    return HorizonDifferential(
        status="QUERY_PLAN",
        canonical_only_terms=[],
        contemporary_only_terms=[],
        conflict_signals=signals,
        synthesis=(
            f"Dual-horizon plan armed at {cutoff_year} boundary: cross-check foundational human "
            "architecture (Lane A) against contemporary breaking changes, CVEs, and releases purged of SEO farms (Lane B)."
        ),
    )


def format_split_horizon_query_plan(
    canonical_dict: dict[str, Any],
    contemporary_dict: dict[str, Any],
    differential: HorizonDifferential,
) -> str:
    divider = "=" * 72
    q_a = canonical_dict["query"]
    q_b = contemporary_dict["query"]
    lines = [
        divider,
        CANONICAL_HEADING,
        divider,
        f"Dork       : {q_a['compiled_query']}",
        f"Engine URL : {q_a['search_url']}",
        f"GitHub Arc : {canonical_dict['archivedGithubUrl']}",
        f"Operators  : {q_a['operator_count']}/{q_a['operator_budget']} ({q_a['engine']})",
        "",
        divider,
        CONTEMPORARY_HEADING,
        divider,
        f"Dork       : {q_b['compiled_query']}",
        f"Engine URL : {q_b['search_url']}",
        f"Blocked    : {len(q_b['excluded_sites_inline'])} inline spam domains + 60+ post-fetch blocklist & SlopClassifier",
        f"Operators  : {q_b['operator_count']}/{q_b['operator_budget']} ({q_b['engine']})",
        "",
        divider,
        DIFFERENTIAL_HEADING,
        divider,
        f"Status     : {differential.status}",
        f"Synthesis  : {differential.synthesis}",
    ]
    for sig in differential.conflict_signals:
        lines.append(f"  - [{sig.severity} | {sig.kind}] {sig.summary}")
    return "\n".join(lines)


def format_split_horizon_search_report(
    cutoff_year: int,
    canonical_query_str: str,
    contemporary_query_str: str,
    lane_a: FilterBatchReport,
    lane_b: FilterBatchReport,
    differential: HorizonDifferential,
) -> str:
    divider = "=" * 72
    lines = [
        divider,
        CANONICAL_HEADING,
        divider,
        f"Dork    : {canonical_query_str}",
        f"Archive : Kept {lane_a.stats['keptCount']}/{lane_a.stats['total']} human canonical result(s)",
    ]
    if not lane_a.kept:
        lines.append("  (No canonical pre-cutoff results matched)")
    else:
        for item in lane_a.kept:
            lines.append(
                f"  * [{item.source or 'web'} | rank={item.rank_score} | slop={item.classification.score}] {item.title}"
            )
            lines.append(f"    URL: {item.url}")

    lines.extend(
        [
            "",
            divider,
            CONTEMPORARY_HEADING,
            divider,
            f"Dork    : {contemporary_query_str}",
            (
                f"Audited : Kept {lane_b.stats['keptCount']}/{lane_b.stats['total']} | "
                f"Purged {lane_b.stats['discardedCount']} ({lane_b.stats['blockedDomainCount']} blocked domain(s), {lane_b.stats['slopCount']} slop)"
            ),
        ]
    )
    if not lane_b.kept:
        lines.append("  (No clean contemporary results survived anti-slop audit)")
    else:
        for item in lane_b.kept:
            lines.append(
                f"  * [{item.source or 'web'} | rank={item.rank_score} | slop={item.classification.score}] {item.title}"
            )
            lines.append(f"    URL: {item.url}")

    lines.extend(
        [
            "",
            divider,
            DIFFERENTIAL_HEADING,
            divider,
            f"Status    : {differential.status}",
            f"Synthesis : {differential.synthesis}",
        ]
    )
    if differential.canonical_only_terms:
        lines.append(f"Pre-{cutoff_year} Exclusive Terms  : {', '.join(differential.canonical_only_terms)}")
    if differential.contemporary_only_terms:
        lines.append(f"Post-{cutoff_year} Exclusive Terms : {', '.join(differential.contemporary_only_terms)}")
    for sig in differential.conflict_signals:
        lines.append(f"  - [{sig.severity} | {sig.kind}] {sig.summary}")

    return "\n".join(lines)


def build_split_horizon_query_plan(
    raw_query: str,
    dorks: TemporalDorkEngine,
    router: CommunityRouter,
    options: DorkOptions | None = None,
    cutoff_year: int = 2023,
) -> SplitHorizonQueryPlan:
    opts = options or DorkOptions()
    clean_query = sanitize_raw_query(raw_query)
    if not clean_query:
        raise ValueError("Query cannot be empty or whitespace-only.")

    after_canonical = opts.after or "2010"
    include_sites = opts.include_sites if opts.include_sites else CANONICAL_PRIORITY_SITES

    lane_a_opts = DorkOptions(
        era="human-classic",
        after=after_canonical,
        before=str(cutoff_year),
        override_temporal=True,
        smart_temporal=False,
        include_sites=include_sites,
        engine=opts.engine,
        searxng_base_url=opts.searxng_base_url,
    )
    canonical_compiled = dorks.compile(clean_query, lane_a_opts)
    vertical_routes = router.build_vertical_routes(
        clean_query,
        DorkOptions(
            era="human-classic",
            after=after_canonical,
            before=str(cutoff_year),
            override_temporal=True,
            smart_temporal=False,
            channels=("reddit", "stackoverflow", "github", "engineering_blogs"),
            engine=opts.engine,
            searxng_base_url=opts.searxng_base_url,
        ),
    )

    lane_b_opts = DorkOptions(
        era="modern-curated",
        after=str(cutoff_year),
        override_temporal=True,
        smart_temporal=False,
        profile="none",
        exclude_sites=opts.exclude_sites,
        disable_blocklist=False,
        engine=opts.engine,
        max_inline_exclusions=opts.max_inline_exclusions,
        searxng_base_url=opts.searxng_base_url,
    )
    contemporary_compiled = dorks.compile(clean_query, lane_b_opts)
    differential = build_query_plan_differential(clean_query, cutoff_year)

    canonical_dict: dict[str, Any] = {
        "heading": CANONICAL_HEADING,
        "query": canonical_compiled.to_dict(),
        "archivedGithubUrl": build_archived_github_url(clean_query, cutoff_year),
        "verticalRoutes": [r.to_dict() for r in vertical_routes],
    }
    contemporary_dict: dict[str, Any] = {
        "heading": CONTEMPORARY_HEADING,
        "query": contemporary_compiled.to_dict(),
    }
    formatted = format_split_horizon_query_plan(canonical_dict, contemporary_dict, differential)

    return SplitHorizonQueryPlan(
        raw_query=raw_query,
        clean_query=clean_query,
        cutoff_year=cutoff_year,
        canonical_pre_2023=canonical_dict,
        contemporary_post_2023=contemporary_dict,
        differential=differential,
        formatted_report=formatted,
    )
