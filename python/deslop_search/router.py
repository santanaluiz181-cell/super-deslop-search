from __future__ import annotations

from dataclasses import replace
from urllib.parse import quote

from .dorks import TemporalDorkEngine
from .models import CommunityChannelName, DorkOptions, VerticalRoute
from .rules import load_rules


def _build_native_channel_url(channel: CommunityChannelName, clean_query: str) -> str | None:
    encoded = quote(clean_query, safe="")
    if channel == "reddit":
        return f"https://old.reddit.com/search?q={encoded}&sort=relevance&t=all"
    if channel == "hackernews":
        return f"https://hn.algolia.com/?q={encoded}&dateRange=custom&dateEnd=1672531200&type=all"
    if channel == "stackoverflow":
        so_q = quote(f"{clean_query} created:..2022-12-31", safe="")
        return f"https://stackoverflow.com/search?q={so_q}"
    if channel == "github":
        gh_q = quote(f"{clean_query} created:<2023-01-01", safe="")
        return f"https://github.com/search?q={gh_q}&type=issues"
    return None


class CommunityRouter:
    def __init__(self, dork_engine: TemporalDorkEngine | None = None) -> None:
        self._dork_engine = dork_engine or TemporalDorkEngine()

    def build_vertical_routes(
        self, raw_query: str, options: DorkOptions | None = None
    ) -> list[VerticalRoute]:
        opts = options or DorkOptions()
        rules = load_rules()
        channels_map = rules.sources.get("channels", {})
        selected: tuple[CommunityChannelName, ...] = (
            opts.channels
            if opts.channels
            else tuple(channels_map.keys())  # type: ignore[arg-type]
        )

        routes: list[VerticalRoute] = []
        for ch_name in selected:
            ch_cfg = channels_map.get(ch_name, {})
            ch_opts = replace(opts, profile="none", channels=(ch_name,))
            compiled = self._dork_engine.compile(raw_query, ch_opts)
            native_url = (
                None
                if compiled.era_applied in ("modern-curated", "none")
                else _build_native_channel_url(ch_name, compiled.clean_query)
            )
            routes.append(
                VerticalRoute(
                    channel=ch_name,
                    label=str(ch_cfg.get("label", ch_name)),
                    compiled_query=compiled.compiled_query,
                    engine_url=compiled.search_url,
                    native_search_url=native_url,
                )
            )
        return routes
