from __future__ import annotations

import math
import re

from .models import SlopClassification, SlopSignal, SlopVerdict
from .rules import load_rules, match_domain_against_list

_MAX_ANALYZED_CHARS = 50_000

_BOLD_COLON_LINE_RE = re.compile(
    r"^\s*(?:[-*•]|\d+[.)])\s*(?:\*\*[^*\n]{2,65}?:\*\*|\*\*[^*\n]{2,65}?\*\*\s*:)",
    re.MULTILINE,
)

_TECHNICAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"```[\s\S]*?```"),
    re.compile(r"`[^`\n]{2,80}`"),
    re.compile(r"\b0x[0-9a-fA-F]{2,16}\b"),
    re.compile(
        r"\b(?:ENOENT|ECONNREFUSED|EADDRINUSE|SIGSEGV|SIGTERM|SIGKILL|NullPointerException|TypeError|ValueError|KeyError|Segmentation fault)\b"
    ),
    re.compile(r"(?:^|\s)--[a-z0-9][a-z0-9-]{1,30}\b", re.MULTILINE),
    re.compile(r"\b[a-zA-Z_][a-zA-Z0-9_]*\([^()\n]{0,60}\)"),
    re.compile(r"\b(?:RFC\s?\d{3,5}|CVE-\d{4}-\d{4,7})\b", re.IGNORECASE),
    re.compile(r"(?:/[a-zA-Z0-9._-]+){2,}"),
)

_SCRIPT_RE = re.compile(r"<script\b[^>]*>[\s\S]*?</script>", re.IGNORECASE)
_STYLE_RE = re.compile(r"<style\b[^>]*>[\s\S]*?</style>", re.IGNORECASE)
_BLOCK_CLOSE_RE = re.compile(r"</(?:p|div|li|h[1-6]|section|article|blockquote|tr)>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]{1,500}>")


def strip_html_preserving_blocks(raw: str) -> str:
    capped = raw[:_MAX_ANALYZED_CHARS] if len(raw) > _MAX_ANALYZED_CHARS else raw
    if "<" not in capped:
        return capped
    cleaned = _SCRIPT_RE.sub(" ", capped)
    cleaned = _STYLE_RE.sub(" ", cleaned)
    cleaned = _BLOCK_CLOSE_RE.sub("\n\n", cleaned)
    cleaned = _BR_RE.sub("\n", cleaned)
    cleaned = _TAG_RE.sub(" ", cleaned)
    return (
        cleaned.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )


def _coefficient_of_variation(values: list[int]) -> float | None:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    if mean <= 0:
        return None
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(variance) / mean


def _count_words(text: str) -> int:
    trimmed = text.strip()
    if not trimmed:
        return 0
    return len(trimmed.split())


def _compute_technical_density(text: str, total_words: int) -> float:
    if total_words == 0:
        return 0.0
    hits = sum(len(pat.findall(text)) for pat in _TECHNICAL_PATTERNS)
    denom = max(10.0, total_words * 0.12)
    return min(1.0, round(hits / denom, 3))


class SlopClassifier:
    def classify(
        self, text: str, title: str = "", url: str = ""
    ) -> SlopClassification:
        rules = load_rules()
        lexicon = rules.slop_lexicon
        weights: dict[str, float] = lexicon["weights"]
        thresholds: dict[str, float] = lexicon["thresholds"]
        signals: list[SlopSignal] = []

        cleaned_text = strip_html_preserving_blocks(text or "").strip()
        clean_title = (title or "").strip()
        clean_url = (url or "").strip()

        raw_score = 0.0
        blocked_domain = False
        trusted_domain = False
        matched_domain: str | None = None

        if clean_url:
            blocked_match = match_domain_against_list(clean_url, rules.all_blocked_domains)
            if blocked_match is not None:
                blocked_domain = True
                matched_domain = blocked_match
                raw_score += 0.65
                signals.append(
                    SlopSignal(
                        code="blocked_domain",
                        weight=0.65,
                        detail=f"URL matches curated spam/clone blocklist ({blocked_match}).",
                    )
                )
            else:
                trusted_match = match_domain_against_list(clean_url, rules.all_trusted_domains)
                if trusted_match is not None:
                    trusted_domain = True
                    matched_domain = trusted_match
                    raw_score -= 0.12
                    signals.append(
                        SlopSignal(
                            code="trusted_community_domain",
                            weight=-0.12,
                            detail=f"URL belongs to curated human-first community source ({trusted_match}).",
                        )
                    )

        if clean_title:
            for pattern_src in lexicon.get("seoTitleBait", []):
                if re.search(pattern_src, clean_title, re.IGNORECASE):
                    w = float(weights["seoYearBait"])
                    raw_score += w
                    signals.append(
                        SlopSignal(
                            code="seo_year_bait",
                            weight=w,
                            detail=f'Title matches synthetic SEO year-bait template: "{clean_title[:80]}".',
                        )
                    )
                    break

        if not cleaned_text:
            clamped_empty = max(0.0, min(1.0, round(raw_score, 3)))
            empty_verdict: SlopVerdict = (
                "SLOP"
                if blocked_domain or clamped_empty >= thresholds["slop"]
                else "SUSPICIOUS"
                if clamped_empty >= thresholds["suspicious"]
                else "AUTHENTIC"
            )
            return SlopClassification(
                score=clamped_empty,
                verdict=empty_verdict,
                blocked_domain=blocked_domain,
                trusted_community_domain=trusted_domain,
                matched_domain=matched_domain,
                technical_density=0.0,
                signals=signals,
            )

        lower_text = cleaned_text.lower()
        total_words = _count_words(cleaned_text)

        # 1. Opening & closing synthetic hooks
        head_slice = cleaned_text[:320]
        for hook_src in lexicon.get("openingHooks", []):
            if re.search(hook_src, head_slice, re.IGNORECASE):
                w = float(weights["openingClichedHook"])
                raw_score += w
                signals.append(
                    SlopSignal(
                        code="opening_cliched_hook",
                        weight=w,
                        detail="Text opens with a stereotypical LLM throat-clearing hook.",
                    )
                )
                break

        tail_slice = cleaned_text[max(0, len(cleaned_text) - 420) :]
        for close_src in lexicon.get("closingHooks", []):
            if re.search(close_src, tail_slice, re.IGNORECASE):
                w = float(weights["closingSummaryTemplate"])
                raw_score += w
                signals.append(
                    SlopSignal(
                        code="closing_summary_template",
                        weight=w,
                        detail="Text closes with a generic symmetrical summary wrap-up.",
                    )
                )
                break

        # 2. Multilingual lexical AI jargon (EN + PT-BR)
        phrases_cfg = lexicon.get("phrases", {})
        all_phrases = [*phrases_cfg.get("en", []), *phrases_cfg.get("pt", [])]
        matched_phrases = [p for p in all_phrases if str(p).lower() in lower_text]
        if matched_phrases:
            penalty = min(0.56, round(len(matched_phrases) * float(weights["jargonPhrase"]), 3))
            raw_score += penalty
            preview = ", ".join(str(p) for p in matched_phrases[:5])
            signals.append(
                SlopSignal(
                    code="lexical_ai_jargon",
                    weight=penalty,
                    detail=f"Matched {len(matched_phrases)} synthetic jargon marker(s): {preview}.",
                )
            )

        # 3. Fake machine-translation scraper footprints
        for marker_src in lexicon.get("fakeTranslationMarkers", []):
            if re.search(marker_src, cleaned_text, re.IGNORECASE):
                w = float(weights["fakeTranslationArtifact"])
                raw_score += w
                signals.append(
                    SlopSignal(
                        code="fake_translation_clone",
                        weight=w,
                        detail="Detected automated Q&A scraper translation attribution marker.",
                    )
                )
                break

        # 4. Symmetrical Bold-Colon listicle structure
        bold_matches = _BOLD_COLON_LINE_RE.findall(cleaned_text)
        if len(bold_matches) >= 3:
            base_w = float(weights["boldColonListicle"])
            list_penalty = round(base_w * 1.35, 3) if len(bold_matches) >= 5 else base_w
            raw_score += list_penalty
            signals.append(
                SlopSignal(
                    code="symmetrical_bold_colon_list",
                    weight=list_penalty,
                    detail=f"Found {len(bold_matches)} symmetrical '**Heading:** Explanation' list items.",
                )
            )

        # 5. Paragraph uniformity (low CV across >= 4 substantive paragraphs)
        paragraphs = [
            p.strip()
            for p in re.split(r"\n\s*\n", cleaned_text)
            if p.strip() and not p.strip().startswith("```") and _count_words(p) >= 16
        ]
        para_counts = [_count_words(p) for p in paragraphs]
        para_cv = _coefficient_of_variation(para_counts) if len(para_counts) >= 4 else None
        if para_cv is not None and para_cv < 0.18:
            w = float(weights["uniformParagraphSymmetry"])
            raw_score += w
            signals.append(
                SlopSignal(
                    code="uniform_paragraph_symmetry",
                    weight=w,
                    detail=f"Unnaturally uniform paragraph lengths across {len(paragraphs)} paragraphs (CV={para_cv:.3f} < 0.18).",
                )
            )

        # 6. Sentence burstiness
        prose_without_code = re.sub(r"```[\s\S]*?```", " ", cleaned_text)
        sent_counts = [
            _count_words(s)
            for s in re.split(r"[.!?]+(?:\s+|$)", prose_without_code)
            if _count_words(s) >= 4
        ]
        sent_cv = _coefficient_of_variation(sent_counts) if len(sent_counts) >= 6 else None
        if sent_cv is not None and sent_cv < 0.24:
            w = float(weights["lowSentenceBurstiness"])
            raw_score += w
            signals.append(
                SlopSignal(
                    code="low_sentence_burstiness",
                    weight=w,
                    detail=f"Flat, non-human sentence cadence across {len(sent_counts)} sentences (CV={sent_cv:.3f} < 0.24).",
                )
            )

        # 7. Em-dash overuse
        if total_words >= 60:
            em_dashes = prose_without_code.count("—")
            em_per_100 = (em_dashes / total_words) * 100.0
            if em_per_100 > 1.8:
                w = float(weights["emDashOveruse"])
                raw_score += w
                signals.append(
                    SlopSignal(
                        code="em_dash_overuse",
                        weight=w,
                        detail=f"High em-dash frequency ({em_per_100:.2f} per 100 words).",
                    )
                )

        # 8. Technical density counter-weight
        tech_density = _compute_technical_density(cleaned_text, total_words)
        if tech_density >= 0.45 and not blocked_domain:
            bonus = round(float(weights["highTechnicalDensityBonus"]) * tech_density, 3)
            raw_score += bonus
            signals.append(
                SlopSignal(
                    code="high_technical_density",
                    weight=bonus,
                    detail=f"Concrete code/CLI/stack-trace artifacts detected (density={tech_density:.2f}).",
                )
            )

        final_score = max(0.0, min(1.0, round(raw_score, 3)))
        verdict: SlopVerdict = (
            "SLOP"
            if blocked_domain or final_score >= thresholds["slop"]
            else "SUSPICIOUS"
            if final_score >= thresholds["suspicious"]
            else "AUTHENTIC"
        )

        return SlopClassification(
            score=final_score,
            verdict=verdict,
            blocked_domain=blocked_domain,
            trusted_community_domain=trusted_domain,
            matched_domain=matched_domain,
            technical_density=tech_density,
            paragraph_burstiness_cv=round(para_cv, 3) if para_cv is not None else None,
            sentence_burstiness_cv=round(sent_cv, 3) if sent_cv is not None else None,
            signals=signals,
        )
