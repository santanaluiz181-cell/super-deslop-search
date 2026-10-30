# Changelog

All notable changes to `deslop-search` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-10-30

### Added
- **Dual Temporal Split-Horizon Engine**:
  - Implemented parallel search across **Lane A (`[HORIZONTE CANÔNICO: PRÉ-2023]`)** and **Lane B (`[HORIZONTE CONTEMPORÂNEO: PÓS-2023]`)**.
  - Added deterministic differential analysis (`[DIFERENCIAL E CONFLITOS]`) highlighting deprecation shifts, breaking changes, CVEs, version drift, and slop saturation.
  - Added CLI flags `--split` and `--split-horizon` to `query` and `live` commands, plus shorthand `split` subcommand.
  - Added `split_horizon` boolean parameter to `skill.json`, `SKILL.md`, and MCP dispatchers (`executeDeslopTool`, `executeDeslopToolAsync`).
  - Added native `ThreadPoolExecutor` parallel execution in Python library and `Promise.all` in TypeScript SDK.
- **Visual Branding**:
  - Added custom dark-mode SVG hero banner in `assets/hero-banner.svg`.
  - Added GitHub community governance files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue & PR templates).

---

## [1.0.0] - 2026-10-30

### Added
- Initial public release of `deslop-search`.
- **Temporal Dork Engine**: Idempotent injection of `after:2010 before:2023`, operator budget capping (`32` Google, `24` DDG/Bing), Google `udm=14` clean Web mode, and post-2022 subject detection (`--smart`).
- **Community Source Router**: Curated routing profiles (`qa`, `discussions`, `code`, `blogs`, `forums`, `all_community`) pointing to Reddit, Stack Exchange, GitHub, HN, Lobste.rs, and high-density engineering blogs.
- **Heuristic Slop Classifier**: Deterministic linear-time $O(N)$ text classifier evaluating EN + PT-BR corporate jargon, bold-colon listicle symmetry, paragraph uniformity ($\text{CV} < 0.18$), sentence burstiness ($\text{CV} < 0.24$), fake translation markers, and technical density counterweights.
- **Cross-Platform CLI & SDK**: Full TypeScript ESM (`strict: true`) and Python 3.10+ (`PEP 561`) parity with zero external runtime dependencies in Python.
- **Live Pre-2023 Archive Search**: Zero-key query support across Hacker News (Algolia Unix timestamp), Stack Overflow, and GitHub Issues.
- **AI Agent & MCP Tooling**: Manifests and handlers for Claude Code, Antigravity, Cursor, Gemini, and MCP.
