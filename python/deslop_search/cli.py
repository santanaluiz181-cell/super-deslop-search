from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from .models import DorkOptions, RawSearchResult
from .pipeline import DeslopSearch


def _split_csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deslop-py",
        description="Clean Human-Era Search, Split-Horizon & Anti-Slop Utility (Python CLI)",
    )
    sub = parser.add_subparsers(dest="subcommand")

    def add_common_dork_flags(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--split",
            "--split-horizon",
            dest="split_horizon",
            action="store_true",
            help="Enable Dual Temporal Split-Horizon mode (Lane A: Pre-2023 Canonical vs Lane B: Post-2023 Audited)",
        )
        p.add_argument(
            "--era",
            default="human-classic",
            choices=["human-classic", "pre-gpt4", "archival", "modern-curated", "none"],
        )
        p.add_argument(
            "--profile",
            default="none",
            choices=[
                "none",
                "all_community",
                "discussions",
                "qa",
                "code",
                "blogs",
                "forums",
            ],
        )
        p.add_argument("--channel", default=None, help="Comma-separated community channels")
        p.add_argument(
            "--engine",
            default="google",
            choices=["google", "duckduckgo", "brave", "kagi", "searxng", "bing"],
        )
        p.add_argument("--before", default=None)
        p.add_argument("--after", default=None)
        p.add_argument("--before-year", type=int, default=2023)
        p.add_argument("--exclude", default=None)
        p.add_argument("--include", default=None)
        p.add_argument("--no-blocklist", action="store_true")
        p.add_argument("--smart", action="store_true")
        p.add_argument("--json", action="store_true")

    q_parser = sub.add_parser("query", help="Compile a clean temporal search dork (or dual plan with --split)")
    q_parser.add_argument("terms", nargs="+", help="Search query terms")
    add_common_dork_flags(q_parser)

    s_parser = sub.add_parser("split", help="Run parallel Split-Horizon comparative search (Pre-2023 vs Post-2023)")
    s_parser.add_argument("terms", nargs="+", help="Search query terms")
    s_parser.add_argument("--plan", action="store_true", help="Emit dual query plan without live HTTP calls")
    s_parser.add_argument("--limit", type=int, default=4)
    s_parser.add_argument("--max-slop", type=float, default=0.59)
    add_common_dork_flags(s_parser)

    r_parser = sub.add_parser("routes", help="Build curated community routing URLs")
    r_parser.add_argument("terms", nargs="+", help="Search query terms")
    add_common_dork_flags(r_parser)

    c_parser = sub.add_parser("classify", help="Classify snippet or webpage text for AI slop")
    c_parser.add_argument("--text", default="")
    c_parser.add_argument("--file", default=None)
    c_parser.add_argument("--title", default="")
    c_parser.add_argument("--url", default="")
    c_parser.add_argument("--json", action="store_true")

    f_parser = sub.add_parser("filter", help="Filter a JSON array of search results")
    f_parser.add_argument("--file", required=True)
    f_parser.add_argument("--max-slop", type=float, default=0.59)
    f_parser.add_argument("--json", action="store_true")

    l_parser = sub.add_parser("live", help="Query pre-2023 archives (or parallel Split-Horizon with --split)")
    l_parser.add_argument("terms", nargs="+")
    l_parser.add_argument(
        "--split",
        "--split-horizon",
        dest="split_horizon",
        action="store_true",
        help="Run parallel Split-Horizon search across Pre-2023 Canonical & Post-2023 Audited lanes",
    )
    l_parser.add_argument("--before-year", type=int, default=2023)
    l_parser.add_argument("--limit", type=int, default=5)
    l_parser.add_argument("--max-slop", type=float, default=0.59)
    l_parser.add_argument("--json", action="store_true")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.subcommand:
        parser.print_help()
        return 0

    deslop = DeslopSearch()

    if args.subcommand in ("query", "routes", "split"):
        raw_query = " ".join(args.terms).strip()
        opts = DorkOptions(
            era=args.era,
            before=args.before,
            after=args.after,
            smart_temporal=bool(args.smart),
            split_horizon=bool(args.split_horizon or args.subcommand == "split"),
            profile=args.profile,
            channels=_split_csv(args.channel),  # type: ignore[arg-type]
            include_sites=_split_csv(args.include),
            exclude_sites=_split_csv(args.exclude),
            disable_blocklist=bool(args.no_blocklist),
            engine=args.engine,
        )

        if args.subcommand == "split":
            if args.plan:
                plan = deslop.compile_split_horizon(raw_query, opts, cutoff_year=args.before_year)
                if args.json:
                    print(json.dumps(plan.to_dict(), indent=2, ensure_ascii=False))
                else:
                    print(plan.formatted_report)
                return 0
            split_report = deslop.live_split_horizon_search(
                raw_query,
                cutoff_year=args.before_year,
                limit_per_source=args.limit,
                max_slop_score=args.max_slop,
                dork_options=opts,
            )
            if args.json:
                print(json.dumps(split_report.to_dict(), indent=2, ensure_ascii=False))
            else:
                print(split_report.formatted_report)
            return 0

        if args.subcommand == "query":
            if args.split_horizon:
                plan = deslop.compile_split_horizon(raw_query, opts, cutoff_year=args.before_year)
                if args.json:
                    print(json.dumps(plan.to_dict(), indent=2, ensure_ascii=False))
                else:
                    print(plan.formatted_report)
                return 0

            compiled = deslop.compile_query(raw_query, opts)
            if args.json:
                print(json.dumps(compiled.to_dict(), indent=2, ensure_ascii=False))
            else:
                print(f"Compiled Query : {compiled.compiled_query}")
                print(f"Engine URL     : {compiled.search_url}")
                print(
                    f"Operators      : {compiled.operator_count}/{compiled.operator_budget} ({compiled.engine}, era={compiled.era_applied})"
                )
                for w in compiled.warnings:
                    print(f"[WARN] {w}", file=sys.stderr)
            return 0

        routes = deslop.build_routes(raw_query, opts)
        if args.json:
            print(json.dumps([r.to_dict() for r in routes], indent=2, ensure_ascii=False))
        else:
            for route in routes:
                print(f"\n[{route.channel}] {route.label}")
                print(f"  Dork   : {route.compiled_query}")
                print(f"  Engine : {route.engine_url}")
                if route.native_search_url:
                    print(f"  Native : {route.native_search_url}")
        return 0

    if args.subcommand == "classify":
        body = args.text
        if args.file:
            body = Path(args.file).read_text(encoding="utf-8")
        report = deslop.classify_text(text=body, title=args.title, url=args.url)
        if args.json:
            print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(f"Verdict          : {report.verdict} (score={report.score})")
            print(f"Technical Density: {report.technical_density}")
            for sig in report.signals:
                sign = "+" if sig.weight >= 0 else ""
                print(f"  - [{sig.code}] ({sign}{sig.weight}): {sig.detail}")
        return 0

    if args.subcommand == "filter":
        raw_items = json.loads(Path(args.file).read_text(encoding="utf-8"))
        parsed_items = [
            RawSearchResult(
                title=str(item["title"]),
                url=str(item["url"]),
                snippet=str(item.get("snippet", "")),
                content=str(item.get("content", "")),
            )
            for item in raw_items
        ]
        filtered = deslop.filter_results(parsed_items, max_slop_score=args.max_slop)
        if args.json:
            print(json.dumps(filtered.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(
                f"Filtered {filtered.stats['total']} -> Kept {filtered.stats['keptCount']}, Discarded {filtered.stats['discardedCount']}"
            )
        return 0

    if args.subcommand == "live":
        raw_query = " ".join(args.terms).strip()
        if args.split_horizon:
            split_live = deslop.live_split_horizon_search(
                raw_query,
                cutoff_year=args.before_year,
                limit_per_source=args.limit,
                max_slop_score=args.max_slop,
            )
            if args.json:
                print(json.dumps(split_live.to_dict(), indent=2, ensure_ascii=False))
            else:
                print(split_live.formatted_report)
            return 0

        live_report = deslop.live_archive_search(
            raw_query, before_year=args.before_year, limit_per_source=args.limit
        )
        if args.json:
            print(json.dumps(live_report.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(
                f"Live Human-Archive Results (before:{args.before_year}) — Kept {live_report.stats['keptCount']}/{live_report.stats['total']}:"
            )
            for hit in live_report.kept:
                print(
                    f"\n- [{hit.source or 'web'}] {hit.title}\n  URL  : {hit.url}\n  Score: rank={hit.rank_score}, slop={hit.classification.score} ({hit.classification.verdict})"
                )
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
