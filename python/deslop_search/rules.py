from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(frozen=True)
class LoadedRules:
    blocklist: dict[str, Any]
    sources: dict[str, Any]
    slop_lexicon: dict[str, Any]
    all_blocked_domains: tuple[str, ...]
    all_trusted_domains: tuple[str, ...]


_CACHED_RULES: LoadedRules | None = None


def _resolve_data_dir() -> Path:
    here = Path(__file__).resolve().parent
    bundled = here / "data"
    if (bundled / "blocklist.json").is_file():
        return bundled
    repo_data = here.parent.parent / "data"
    if (repo_data / "blocklist.json").is_file():
        return repo_data
    raise FileNotFoundError(
        f"Could not locate Deslop data directory in {bundled} or {repo_data}."
    )


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
        return data


def load_rules(force_reload: bool = False) -> LoadedRules:
    global _CACHED_RULES
    if _CACHED_RULES is not None and not force_reload:
        return _CACHED_RULES

    data_dir = _resolve_data_dir()
    blocklist = _read_json(data_dir / "blocklist.json")
    sources = _read_json(data_dir / "sources.json")
    slop_lexicon = _read_json(data_dir / "slop-lexicon.json")

    blocked: list[str] = []
    seen_blocked: set[str] = set()
    for cat in blocklist.get("categories", {}).values():
        for dom in cat.get("domains", []):
            norm = str(dom).strip().lower()
            if norm and norm not in seen_blocked:
                seen_blocked.add(norm)
                blocked.append(norm)
    for dom in blocklist.get("defaultInlineExclusions", []):
        norm = str(dom).strip().lower()
        if norm and norm not in seen_blocked:
            seen_blocked.add(norm)
            blocked.append(norm)

    trusted: list[str] = []
    seen_trusted: set[str] = set()
    for chan in sources.get("channels", {}).values():
        for site in chan.get("sites", []):
            norm = str(site).strip().lower()
            if norm and norm not in seen_trusted:
                seen_trusted.add(norm)
                trusted.append(norm)

    _CACHED_RULES = LoadedRules(
        blocklist=blocklist,
        sources=sources,
        slop_lexicon=slop_lexicon,
        all_blocked_domains=tuple(blocked),
        all_trusted_domains=tuple(trusted),
    )
    return _CACHED_RULES


def extract_domain_or_path_prefix(url_string: str) -> str:
    trimmed = url_string.strip()
    if not trimmed:
        return ""
    candidate = trimmed if trimmed.lower().startswith(("http://", "https://")) else f"https://{trimmed}"
    try:
        parsed = urlparse(candidate)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        path = parsed.path.lower().rstrip("/")
        if not host:
            raise ValueError("Empty hostname")
        return f"{host}{path}" if path and path != "/" else host
    except ValueError:
        cleaned = trimmed.lower()
        for prefix in ("https://", "http://", "www."):
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix) :]
        return cleaned.rstrip("/")


def match_domain_against_list(url_string: str, candidates: tuple[str, ...] | list[str]) -> str | None:
    normalized = extract_domain_or_path_prefix(url_string)
    if not normalized:
        return None
    host_only = normalized.split("/", 1)[0]

    for item in candidates:
        clean_cand = item.lower().removeprefix("www.").rstrip("/")
        if "/" in clean_cand:
            if normalized == clean_cand or normalized.startswith(f"{clean_cand}/"):
                return clean_cand
        elif host_only == clean_cand or host_only.endswith(f".{clean_cand}"):
            return clean_cand
    return None
