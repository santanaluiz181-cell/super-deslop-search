# Contributing to deslop-search

Thank you for helping rescue the human web from synthetic AI slop and content mills! We welcome contributions of all kinds: new blocklist domains, refined heuristic regexes, community channels, tests, documentation, and performance optimizations.

---

## Code of Conduct

This project is governed by the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards.

---

## Development Setup

### Prerequisites
- **Node.js**: `>=18.0.0` (npm `>=9.0.0`)
- **Python**: `>=3.10`

### 1. Clone & Install
```bash
git clone https://github.com/santanaluiz181-cell/deslop-search.git
cd deslop-search

# Install Node dependencies
npm install

# Test TypeScript build & test suite
npm run verify
```

---

## Adding Blocklist Domains or Heuristic Markers

1. **New Scraper Clones / AI Farms**:
   - Add domains to [`data/blocklist.json`](./data/blocklist.json) under the relevant category (`scraper_mirrors`, `translation_clones`, `seo_content_mills`, or `ai_slop_farms`).
   - If adding a top offender, consider including it in `defaultInlineExclusions` (up to 12).
2. **New Community Sources**:
   - Add trustworthy human-first channels or indie blogs to [`data/sources.json`](./data/sources.json).
3. **Slop Lexicon Enhancements**:
   - Add synthetic corporate buzzwords or structural templates to [`data/slop-lexicon.json`](./data/slop-lexicon.json).

> **Important:** Always copy updated `data/*.json` to `python/deslop_search/data/` or run `npm run verify` to ensure tests validate identical data synchronization across TS and Python.

---

## Pull Request Guidelines

1. **Keep it Tested**: All PRs must pass `npm run verify` (`tsc`, `vitest`, and Python `unittest`).
2. **Deterministic & Fast**: The `SlopClassifier` must remain $O(N)$ with zero external API calls and zero ReDoS vulnerabilities.
3. **Commit Messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add new community routing profile for kernel developers`
   - `fix: prevent ReDoS on unclosed quote edge case`
   - `docs: update Split-Horizon examples in README`
