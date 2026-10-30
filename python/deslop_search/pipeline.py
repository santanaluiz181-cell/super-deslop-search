from __future__ import annotations

import datetime as dt
import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .classifier import SlopClassifier
from .dorks import TemporalDorkEngine, sanitize_raw_query
from .models import (
    CompiledQuery,
    DorkOptions,
    FilterBatchReport,
    FilteredSearchResult,
    RawSearchResult,
    SlopClassification,
    SplitHorizonQueryPlan,
    SplitHorizonSearchReport,
    VerticalRoute,
)
from .router import CommunityRouter
from .split_horizon import (
    CANONICAL_HEADING,
    CONTEMPORARY_HEADING,
    analyze_horizon_differential,
    build_archived_github_url,
    build_split_horizon_query_plan,
    format_split_horizon_search_report,
)


def _get_json(url: str, timeout_sec: float = 8.0) -> dict[str, Any]:
    req = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "deslop-search-py/1.1",
        },
    )
    with urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310 - fixed HTTPS public archive endpoints
        raw = resp.read().decode("utf-8", errors="replace")
        parsed: dict[str, Any] = json.loads(raw)
        return parsed


class DeslopSearch:
    def __init__(self) -> None:
        self.dorks = TemporalDorkEngine()
        self.router = CommunityRouter(self.dorks)
        self.classifier = SlopClassifier()

    def compile_query(
        self, query: str, options: DorkOptions | None = None
    ) -> CompiledQuery:
        return self.dorks.compile(query, options)

    def compile_split_horizon(
        self,
        query: str,
        options: DorkOptions | None = None,
        cutoff_year: int = 2023,
    ) -> SplitHorizonQueryPlan:
        return build_split_horizon_query_plan(
            query, self.dorks, self.router, options, cutoff_year
        )

    def build_routes(
        self, query: str, options: DorkOptions | None = None
    ) -> list[VerticalRoute]:
        return self.router.build_vertical_routes(query, options)

    def classify_text(
        self, text: str, title: str = "", url: str = ""
    ) -> SlopClassification:
        return self.classifier.classify(text=text, title=title, url=url)

    def filter_results(
        self,
        results: list[RawSearchResult],
        max_slop_score: float = 0.59,
        drop_suspicious: bool = False,
    ) -> FilterBatchReport:
        kept: list[FilteredSearchResult] = []
        discarded: list[FilteredSearchResult] = []
        blocked_count = 0
        slop_count = 0

        for item in results:
            body = item.content if item.content else item.snippet
            classification = self.classifier.classify(
                text=body, title=item.title, url=item.url
            )
            community_bonus = 0.15 if classification.trusted_community_domain else 0.0
            tech_bonus = classification.technical_density * 0.2
            rank_score = round(
                max(0.0, min(1.0, 1.0 - classification.score + community_bonus + tech_bonus)),
                3,
            )

            enriched = FilteredSearchResult(
                title=item.title,
                url=item.url,
                snippet=item.snippet,
                content=item.content,
                published_at=item.published_at,
                source=item.source,
                classification=classification,
                rank_score=rank_score,
            )

            if classification.blocked_domain:
                blocked_count += 1
            if classification.verdict == "SLOP":
                slop_count += 1

            should_drop = (
                classification.blocked_domain
                or classification.score > max_slop_score
                or classification.verdict == "SLOP"
                or (drop_suspicious and classification.verdict == "SUSPICIOUS")
            )
            if should_drop:
                discarded.append(enriched)
            else:
                kept.append(enriched)

        kept.sort(key=lambda r: r.rank_score, reverse=True)
        return FilterBatchReport(
            kept=kept,
            discarded=discarded,
            stats={
                "total": len(results),
                "keptCount": len(kept),
                "discardedCount": len(discarded),
                "blockedDomainCount": blocked_count,
                "slopCount": slop_count,
            },
        )

    def compare_horizons(
        self,
        raw_query: str,
        canonical_raw_results: list[RawSearchResult],
        contemporary_raw_results: list[RawSearchResult],
        cutoff_year: int = 2023,
        max_slop_score: float = 0.59,
        drop_suspicious: bool = False,
        dork_options: DorkOptions | None = None,
    ) -> SplitHorizonSearchReport:
        clean_query = sanitize_raw_query(raw_query)
        if not clean_query:
            raise ValueError("Query cannot be empty or whitespace-only.")

        plan = self.compile_split_horizon(clean_query, dork_options, cutoff_year)
        filtered_a = self.filter_results(
            canonical_raw_results,
            max_slop_score=max_slop_score,
            drop_suspicious=drop_suspicious,
        )
        filtered_b = self.filter_results(
            contemporary_raw_results,
            max_slop_score=max_slop_score,
            drop_suspicious=drop_suspicious,
        )
        differential = analyze_horizon_differential(
            clean_query, filtered_a, filtered_b, cutoff_year
        )

        q_a_dict = plan.canonical_pre_2023["query"]
        q_b_dict = plan.contemporary_post_2023["query"]
        formatted = format_split_horizon_search_report(
            cutoff_year=cutoff_year,
            canonical_query_str=str(q_a_dict["compiled_query"]),
            contemporary_query_str=str(q_b_dict["compiled_query"]),
            lane_a=filtered_a,
            lane_b=filtered_b,
            differential=differential,
        )

        return SplitHorizonSearchReport(
            raw_query=raw_query,
            clean_query=clean_query,
            cutoff_year=cutoff_year,
            canonical_pre_2023={
                "heading": CANONICAL_HEADING,
                "query": q_a_dict,
                "archivedGithubUrl": build_archived_github_url(clean_query, cutoff_year),
                "results": filtered_a.to_dict(),
            },
            contemporary_post_2023={
                "heading": CONTEMPORARY_HEADING,
                "query": q_b_dict,
                "results": filtered_b.to_dict(),
            },
            differential=differential,
            formatted_report=formatted,
        )

    def live_archive_search(
        self,
        raw_query: str,
        before_year: int = 2023,
        limit_per_source: int = 5,
        timeout_sec: float = 8.0,
    ) -> FilterBatchReport:
        clean = sanitize_raw_query(raw_query)
        if not clean:
            raise ValueError("Query cannot be empty.")
        raw_hits = self._fetch_canonical_pre_cutoff(
            clean, before_year, max(1, min(20, limit_per_source)), timeout_sec, include_reddit=False
        )
        return self.filter_results(raw_hits)

    def live_split_horizon_search(
        self,
        raw_query: str,
        cutoff_year: int = 2023,
        limit_per_source: int = 4,
        timeout_sec: float = 8.0,
        max_slop_score: float = 0.59,
        drop_suspicious: bool = False,
        dork_options: DorkOptions | None = None,
        lane_a_fetcher: Callable[[str, int], list[RawSearchResult]] | None = None,
        lane_b_fetcher: Callable[[str, int], list[RawSearchResult]] | None = None,
    ) -> SplitHorizonSearchReport:
        clean = sanitize_raw_query(raw_query)
        if not clean:
            raise ValueError("Query cannot be empty or whitespace-only.")
        limit = max(1, min(20, limit_per_source))

        fn_a = (
            (lambda: lane_a_fetcher(clean, cutoff_year))
            if lane_a_fetcher is not None
            else (lambda: self._fetch_canonical_pre_cutoff(clean, cutoff_year, limit, timeout_sec, include_reddit=True))
        )
        fn_b = (
            (lambda: lane_b_fetcher(clean, cutoff_year))
            if lane_b_fetcher is not None
            else (lambda: self._fetch_contemporary_post_cutoff(clean, cutoff_year, limit, timeout_sec))
        )

        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_a = pool.submit(fn_a)
            fut_b = pool.submit(fn_b)
            raw_a = fut_a.result()
            raw_b = fut_b.result()

        return self.compare_horizons(
            raw_query=raw_query,
            canonical_raw_results=raw_a,
            contemporary_raw_results=raw_b,
            cutoff_year=cutoff_year,
            max_slop_score=max_slop_score,
            drop_suspicious=drop_suspicious,
            dork_options=dork_options,
        )

    def _fetch_canonical_pre_cutoff(
        self,
        clean_query: str,
        cutoff_year: int,
        limit: int,
        timeout_sec: float,
        include_reddit: bool = True,
    ) -> list[RawSearchResult]:
        cutoff_dt = dt.datetime(cutoff_year, 1, 1, 0, 0, 0, tzinfo=dt.timezone.utc)
        cutoff_unix = int(cutoff_dt.timestamp())

        tasks: list[Callable[[], list[RawSearchResult]]] = [
            lambda: self._fetch_hn(clean_query, f"<{cutoff_unix}", limit, timeout_sec),
            lambda: self._fetch_so(clean_query, None, cutoff_unix - 1, limit, timeout_sec),
            lambda: self._fetch_github(f"{clean_query} created:<{cutoff_year}-01-01", limit, timeout_sec),
        ]
        if include_reddit:
            tasks.append(lambda: self._fetch_reddit_pre_cutoff(clean_query, cutoff_unix, limit, timeout_sec))

        aggregated: list[RawSearchResult] = []
        with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            futures = [pool.submit(fn) for fn in tasks]
            for fut in futures:
                try:
                    aggregated.extend(fut.result())
                except Exception:  # noqa: BLE001
                    continue
        return aggregated

    def _fetch_contemporary_post_cutoff(
        self, clean_query: str, cutoff_year: int, limit: int, timeout_sec: float
    ) -> list[RawSearchResult]:
        cutoff_dt = dt.datetime(cutoff_year, 1, 1, 0, 0, 0, tzinfo=dt.timezone.utc)
        cutoff_unix = int(cutoff_dt.timestamp())

        tasks: list[Callable[[], list[RawSearchResult]]] = [
            lambda: self._fetch_hn(clean_query, f">={cutoff_unix}", limit, timeout_sec),
            lambda: self._fetch_so(clean_query, cutoff_unix, None, limit, timeout_sec),
            lambda: self._fetch_github(f"{clean_query} created:>={cutoff_year}-01-01", limit, timeout_sec),
        ]

        aggregated: list[RawSearchResult] = []
        with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            futures = [pool.submit(fn) for fn in tasks]
            for fut in futures:
                try:
                    aggregated.extend(fut.result())
                except Exception:  # noqa: BLE001
                    continue
        return aggregated

    def _fetch_hn(
        self, query: str, created_op: str, limit: int, timeout_sec: float
    ) -> list[RawSearchResult]:
        results: list[RawSearchResult] = []
        try:
            hn_url = (
                f"https://hn.algolia.com/api/v1/search?query={quote(query, safe='')}"
                f"&numericFilters={quote(f'created_at_i{created_op}', safe='')}&hitsPerPage={limit}"
            )
            hn_data = _get_json(hn_url, timeout_sec)
            for hit in hn_data.get("hits", []):
                title = str(hit.get("title") or "")
                obj_id = hit.get("objectID")
                fallback = f"https://news.ycombinator.com/item?id={obj_id}" if obj_id else ""
                target = str(hit.get("url") or fallback)
                if title and target:
                    results.append(
                        RawSearchResult(
                            title=title,
                            url=target,
                            snippet=str(hit.get("story_text") or ""),
                            published_at=hit.get("created_at"),
                            source="hackernews",
                        )
                    )
        except (URLError, TimeoutError, ValueError, OSError):
            pass
        return results

    def _fetch_so(
        self,
        query: str,
        fromdate: int | None,
        todate: int | None,
        limit: int,
        timeout_sec: float,
    ) -> list[RawSearchResult]:
        results: list[RawSearchResult] = []
        try:
            date_parts: list[str] = []
            if fromdate is not None:
                date_parts.append(f"fromdate={fromdate}")
            if todate is not None:
                date_parts.append(f"todate={todate}")
            date_qs = ("&" + "&".join(date_parts)) if date_parts else ""
            so_url = (
                f"https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance"
                f"&q={quote(query, safe='')}{date_qs}&pagesize={limit}&site=stackoverflow"
            )
            so_data = _get_json(so_url, timeout_sec)
            for entry in so_data.get("items", []):
                title = str(entry.get("title") or "")
                link = str(entry.get("link") or "")
                if title and link:
                    tags = ", ".join(str(t) for t in entry.get("tags", []))
                    created_ts = entry.get("creation_date")
                    pub_iso = (
                        dt.datetime.fromtimestamp(int(created_ts), tz=dt.timezone.utc).isoformat()
                        if isinstance(created_ts, int)
                        else None
                    )
                    results.append(
                        RawSearchResult(
                            title=title,
                            url=link,
                            snippet=f"Tags: {tags} | Score: {entry.get('score', 0)}",
                            published_at=pub_iso,
                            source="stackoverflow",
                        )
                    )
        except (URLError, TimeoutError, ValueError, OSError):
            pass
        return results

    def _fetch_github(
        self, qualified_query: str, limit: int, timeout_sec: float
    ) -> list[RawSearchResult]:
        results: list[RawSearchResult] = []
        try:
            gh_q = quote(qualified_query, safe="")
            gh_url = f"https://api.github.com/search/issues?q={gh_q}&per_page={limit}"
            gh_data = _get_json(gh_url, timeout_sec)
            for issue in gh_data.get("items", []):
                title = str(issue.get("title") or "")
                html_url = str(issue.get("html_url") or "")
                if title and html_url:
                    body = str(issue.get("body") or "")[:600]
                    results.append(
                        RawSearchResult(
                            title=title,
                            url=html_url,
                            snippet=body,
                            published_at=issue.get("created_at"),
                            source="github",
                        )
                    )
        except (URLError, TimeoutError, ValueError, OSError):
            pass
        return results

    def _fetch_reddit_pre_cutoff(
        self, query: str, cutoff_unix: int, limit: int, timeout_sec: float
    ) -> list[RawSearchResult]:
        results: list[RawSearchResult] = []
        try:
            rd_url = (
                f"https://www.reddit.com/search.json?q={quote(query, safe='')}"
                f"&sort=relevance&t=all&limit={min(25, limit * 4)}"
            )
            rd_data = _get_json(rd_url, timeout_sec)
            children = rd_data.get("data", {}).get("children", [])
            for wrapper in children:
                if len(results) >= limit:
                    break
                post = wrapper.get("data", {})
                title = str(post.get("title") or "")
                permalink = str(post.get("permalink") or "")
                created_utc = post.get("created_utc")
                if (
                    not title
                    or not permalink
                    or not isinstance(created_utc, (int, float))
                    or int(created_utc) >= cutoff_unix
                ):
                    continue
                pub_iso = dt.datetime.fromtimestamp(int(created_utc), tz=dt.timezone.utc).isoformat()
                results.append(
                    RawSearchResult(
                        title=title,
                        url=f"https://old.reddit.com{permalink}",
                        snippet=str(post.get("selftext") or "")[:500],
                        published_at=pub_iso,
                        source="reddit",
                    )
                )
        except (URLError, TimeoutError, ValueError, OSError):
            pass
        return results


_DEFAULT_ENGINE = DeslopSearch()


def deslop_query(query: str, options: DorkOptions | None = None) -> CompiledQuery:
    return _DEFAULT_ENGINE.compile_query(query, options)


def deslop_split_horizon(
    query: str, options: DorkOptions | None = None, cutoff_year: int = 2023
) -> SplitHorizonQueryPlan:
    return _DEFAULT_ENGINE.compile_split_horizon(query, options, cutoff_year)


def classify_slop(text: str, title: str = "", url: str = "") -> SlopClassification:
    return _DEFAULT_ENGINE.classify_text(text=text, title=title, url=url)


def filter_search_results(
    results: list[RawSearchResult], max_slop_score: float = 0.59
) -> FilterBatchReport:
    return _DEFAULT_ENGINE.filter_results(results, max_slop_score=max_slop_score)
