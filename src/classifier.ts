import { loadRules, matchDomainAgainstList } from "./rules.js";
import type { ClassifyInput, SlopClassification, SlopSignal, SlopVerdict } from "./types.js";

const MAX_ANALYZED_CHARS = 50_000;

const BOLD_COLON_LINE_RE =
  /^\s*(?:[-*•]|\d+[.)])\s*(?:\*\*[^*\n]{2,65}?:\*\*|\*\*[^*\n]{2,65}?\*\*\s*:)/gm;

const TECHNICAL_TOKEN_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]{2,80}`/g,
  /\b0x[0-9a-fA-F]{2,16}\b/g,
  /\b(?:ENOENT|ECONNREFUSED|EADDRINUSE|SIGSEGV|SIGTERM|SIGKILL|NullPointerException|TypeError|ValueError|KeyError|Segmentation fault)\b/g,
  /(?:^|\s)--[a-z0-9][a-z0-9-]{1,30}\b/gm,
  /\b[a-zA-Z_][a-zA-Z0-9_]*\([^()\n]{0,60}\)/g,
  /\b(?:RFC\s?\d{3,5}|CVE-\d{4}-\d{4,7})\b/gi,
  /(?:\/[a-zA-Z0-9._-]+){2,}/g
];

export function stripHtmlPreservingBlocks(raw: string): string {
  const capped = raw.length > MAX_ANALYZED_CHARS ? raw.slice(0, MAX_ANALYZED_CHARS) : raw;
  if (!capped.includes("<")) {
    return capped;
  }
  return capped
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]{1,500}>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

function computeCoefficientOfVariation(values: readonly number[]): number | undefined {
  if (values.length < 2) {
    return undefined;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  const mean = sum / values.length;
  if (mean <= 0) {
    return undefined;
  }
  let varianceSum = 0;
  for (const v of values) {
    const diff = v - mean;
    varianceSum += diff * diff;
  }
  const stdDev = Math.sqrt(varianceSum / values.length);
  return stdDev / mean;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function computeTechnicalDensity(text: string, totalWords: number): number {
  if (totalWords === 0) {
    return 0;
  }
  let hits = 0;
  for (const pattern of TECHNICAL_TOKEN_PATTERNS) {
    const matches = text.match(pattern);
    if (matches !== null) {
      hits += matches.length;
    }
  }
  return Math.min(1, Number((hits / Math.max(10, totalWords * 0.12)).toFixed(3)));
}

export class SlopClassifier {
  public classify(input: ClassifyInput): SlopClassification {
    const rules = loadRules();
    const lexicon = rules.slopLexicon;
    const weights = lexicon.weights;
    const signals: SlopSignal[] = [];

    const cleanedText = stripHtmlPreservingBlocks(input.text ?? "").trim();
    const title = (input.title ?? "").trim();
    const url = (input.url ?? "").trim();

    let rawScore = 0;
    let blockedDomain = false;
    let trustedCommunityDomain = false;
    let matchedDomain: string | undefined;

    if (url.length > 0) {
      const blockedMatch = matchDomainAgainstList(url, rules.allBlockedDomains);
      if (blockedMatch !== undefined) {
        blockedDomain = true;
        matchedDomain = blockedMatch;
        rawScore += 0.65;
        signals.push({
          code: "blocked_domain",
          weight: 0.65,
          detail: `URL matches curated spam/clone blocklist (${blockedMatch}).`
        });
      } else {
        const trustedMatch = matchDomainAgainstList(url, rules.allTrustedDomains);
        if (trustedMatch !== undefined) {
          trustedCommunityDomain = true;
          matchedDomain = trustedMatch;
          rawScore -= 0.12;
          signals.push({
            code: "trusted_community_domain",
            weight: -0.12,
            detail: `URL belongs to curated human-first community source (${trustedMatch}).`
          });
        }
      }
    }

    if (title.length > 0) {
      for (const patternSrc of lexicon.seoTitleBait) {
        const re = new RegExp(patternSrc, "i");
        if (re.test(title)) {
          rawScore += weights.seoYearBait;
          signals.push({
            code: "seo_year_bait",
            weight: weights.seoYearBait,
            detail: `Title matches synthetic SEO year-bait template: "${title.slice(0, 80)}".`
          });
          break;
        }
      }
    }

    if (cleanedText.length === 0) {
      const clampedEmpty = Math.max(0, Math.min(1, Number(rawScore.toFixed(3))));
      const emptyVerdict: SlopVerdict =
        clampedEmpty >= lexicon.thresholds.slop
          ? "SLOP"
          : clampedEmpty >= lexicon.thresholds.suspicious
            ? "SUSPICIOUS"
            : "AUTHENTIC";
      const emptyResult: SlopClassification = {
        score: clampedEmpty,
        verdict: emptyVerdict,
        blockedDomain,
        trustedCommunityDomain,
        technicalDensity: 0,
        signals
      };
      if (matchedDomain !== undefined) {
        emptyResult.matchedDomain = matchedDomain;
      }
      return emptyResult;
    }

    const lowerText = cleanedText.toLowerCase();
    const totalWords = countWords(cleanedText);

    // 1. Opening & closing synthetic hooks
    const headSlice = cleanedText.slice(0, 320);
    for (const hookSrc of lexicon.openingHooks) {
      const re = new RegExp(hookSrc, "i");
      if (re.test(headSlice)) {
        rawScore += weights.openingClichedHook;
        signals.push({
          code: "opening_cliched_hook",
          weight: weights.openingClichedHook,
          detail: "Text opens with a stereotypical LLM throat-clearing hook."
        });
        break;
      }
    }

    const tailSlice = cleanedText.slice(Math.max(0, cleanedText.length - 420));
    for (const closeSrc of lexicon.closingHooks) {
      const re = new RegExp(closeSrc, "i");
      if (re.test(tailSlice)) {
        rawScore += weights.closingSummaryTemplate;
        signals.push({
          code: "closing_summary_template",
          weight: weights.closingSummaryTemplate,
          detail: "Text closes with a generic symmetrical summary wrap-up."
        });
        break;
      }
    }

    // 2. Multilingual lexical AI jargon (EN + PT-BR), capped so long texts don't runaway
    const matchedPhrases: string[] = [];
    const allPhrases = [...lexicon.phrases.en, ...lexicon.phrases.pt];
    for (const phrase of allPhrases) {
      if (lowerText.includes(phrase.toLowerCase())) {
        matchedPhrases.push(phrase);
      }
    }
    if (matchedPhrases.length > 0) {
      const jargonPenalty = Math.min(0.56, Number((matchedPhrases.length * weights.jargonPhrase).toFixed(3)));
      rawScore += jargonPenalty;
      signals.push({
        code: "lexical_ai_jargon",
        weight: jargonPenalty,
        detail: `Matched ${matchedPhrases.length} synthetic jargon marker(s): ${matchedPhrases.slice(0, 5).join(", ")}.`
      });
    }

    // 3. Fake machine-translation scraper footprints
    for (const markerSrc of lexicon.fakeTranslationMarkers) {
      const re = new RegExp(markerSrc, "i");
      if (re.test(cleanedText)) {
        rawScore += weights.fakeTranslationArtifact;
        signals.push({
          code: "fake_translation_clone",
          weight: weights.fakeTranslationArtifact,
          detail: "Detected automated Q&A scraper translation attribution marker."
        });
        break;
      }
    }

    // 4. Symmetrical Bold-Colon listicle structure ("1. **Scalability:** ...")
    const boldColonMatches = cleanedText.match(BOLD_COLON_LINE_RE);
    if (boldColonMatches !== null && boldColonMatches.length >= 3) {
      const listPenalty =
        boldColonMatches.length >= 5
          ? Number((weights.boldColonListicle * 1.35).toFixed(3))
          : weights.boldColonListicle;
      rawScore += listPenalty;
      signals.push({
        code: "symmetrical_bold_colon_list",
        weight: listPenalty,
        detail: `Found ${boldColonMatches.length} symmetrical '**Heading:** Explanation' list items.`
      });
    }

    // 5. Paragraph uniformity (low CV across >= 4 substantive paragraphs)
    const paragraphs = cleanedText
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => !p.startsWith("```") && countWords(p) >= 16);

    const paragraphWordCounts = paragraphs.map((p) => countWords(p));
    const paragraphCv =
      paragraphs.length >= 4 ? computeCoefficientOfVariation(paragraphWordCounts) : undefined;

    if (paragraphCv !== undefined && paragraphCv < 0.18) {
      rawScore += weights.uniformParagraphSymmetry;
      signals.push({
        code: "uniform_paragraph_symmetry",
        weight: weights.uniformParagraphSymmetry,
        detail: `Unnaturally uniform paragraph lengths across ${paragraphs.length} paragraphs (CV=${paragraphCv.toFixed(3)} < 0.18).`
      });
    }

    // 6. Sentence burstiness (low CV across >= 6 prose sentences)
    const proseWithoutCode = cleanedText.replace(/```[\s\S]*?```/g, " ");
    const sentences = proseWithoutCode
      .split(/[.!?]+(?:\s+|$)/)
      .map((s) => countWords(s))
      .filter((w) => w >= 4);

    const sentenceCv =
      sentences.length >= 6 ? computeCoefficientOfVariation(sentences) : undefined;

    if (sentenceCv !== undefined && sentenceCv < 0.24) {
      rawScore += weights.lowSentenceBurstiness;
      signals.push({
        code: "low_sentence_burstiness",
        weight: weights.lowSentenceBurstiness,
        detail: `Flat, non-human sentence cadence across ${sentences.length} sentences (CV=${sentenceCv.toFixed(3)} < 0.24).`
      });
    }

    // 7. Em-dash overuse density
    if (totalWords >= 60) {
      const emDashes = (proseWithoutCode.match(/—/g) ?? []).length;
      const emDashPer100 = (emDashes / totalWords) * 100;
      if (emDashPer100 > 1.8) {
        rawScore += weights.emDashOveruse;
        signals.push({
          code: "em_dash_overuse",
          weight: weights.emDashOveruse,
          detail: `High em-dash frequency (${emDashPer100.toFixed(2)} per 100 words).`
        });
      }
    }

    // 8. Technical density counter-weight (protects genuine code-heavy posts)
    const technicalDensity = computeTechnicalDensity(cleanedText, totalWords);
    if (technicalDensity >= 0.45 && !blockedDomain) {
      const bonus = Number((weights.highTechnicalDensityBonus * technicalDensity).toFixed(3));
      rawScore += bonus;
      signals.push({
        code: "high_technical_density",
        weight: bonus,
        detail: `Concrete code/CLI/stack-trace artifacts detected (density=${technicalDensity.toFixed(2)}).`
      });
    }

    const finalScore = Math.max(0, Math.min(1, Number(rawScore.toFixed(3))));
    const verdict: SlopVerdict =
      blockedDomain || finalScore >= lexicon.thresholds.slop
        ? "SLOP"
        : finalScore >= lexicon.thresholds.suspicious
          ? "SUSPICIOUS"
          : "AUTHENTIC";

    const classification: SlopClassification = {
      score: finalScore,
      verdict,
      blockedDomain,
      trustedCommunityDomain,
      technicalDensity,
      signals
    };

    if (matchedDomain !== undefined) {
      classification.matchedDomain = matchedDomain;
    }
    if (paragraphCv !== undefined) {
      classification.paragraphBurstinessCv = Number(paragraphCv.toFixed(3));
    }
    if (sentenceCv !== undefined) {
      classification.sentenceBurstinessCv = Number(sentenceCv.toFixed(3));
    }

    return classification;
  }
}
