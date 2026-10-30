---
name: deslop-search
description: Clean web search query builder, Split-Horizon comparative search engine, community source router, and heuristic AI slop filter. Use when searching the web free of SEO content farms, contrasting pre-2023 canonical human literature with post-2023 audited facts (--split / split_horizon), applying temporal dorks (before:2023, after:2010), routing lookups to Reddit/StackOverflow/HN/GitHub/indie blogs, or scoring scraped pages for synthetic LLM filler.
---

# Deslop Search Skill

Intercept web searches before execution and filter retrieved results post-fetch to isolate high-density human engineering and journalistic sources.

## Workflow

1. **Choose Single-Horizon or Split-Horizon (`--split` / `split_horizon: true`)**:
   - **Split-Horizon (Recommended for investigative journalism, architecture reviews, and fast-moving APIs):** Fires two parallel lanes simultaneously:
     - **Lane A (`[HORIZONTE CANÔNICO: PRÉ-2023]`):** `after:2010 before:2023` routed to Reddit, Stack Overflow, archived/canonical GitHub repos, HN, Lobste.rs, and pre-LLM engineering blogs.
     - **Lane B (`[HORIZONTE CONTEMPORÂNEO: PÓS-2023]`):** `after:2023` across the live web guarded by `blocklist.json` (`-site:` + 60+ domain filter) and `SlopClassifier` to surface real CVEs, deprecations, and recent news without synthetic SEO farms.
     - **Synthesis (`[DIFERENCIAL E CONFLITOS]`):** Flags breaking changes, version drift, anachronisms, or post-2023 slop saturation.
   - **Single-Horizon Presets:**
     - `human-classic` (default): `after:2010 before:2023` — cuts post-ChatGPT synthetic SEO farms and obsolete pre-2010 legacy docs.
     - `modern-curated`: `after:2023` — use with `--profile all_community` or `--profile code` for post-2023 releases.
     - `archival`: `after:2005 before:2020` — Win32, POSIX, C/C++, classic UNIX internals.
   - *Completion criterion:* Mode chosen matches temporal risk; Split-Horizon is active whenever historical consensus must be verified against contemporary changes.

2. **Execute Split-Horizon or Compile Dorks** via CLI or MCP:
   ```bash
   # Parallel live Split-Horizon comparative search (Node & Python)
   npx deslop live "epoll thundering herd" --split
   python -m deslop_search live "postgres vacuum freeze" --split-horizon

   # Dual Split-Horizon dork plan (no network calls)
   npx deslop query "sqlite wal checkpoint starvation" --split

   # Classic single-lane dork compilation
   npx deslop query "postgres vacuum freeze wraparound" --era human-classic --profile qa --json
   ```
   - Respects per-engine operator caps (`32` on Google, `24` on DuckDuckGo/Bing) and appends `udm=14` on Google URLs.
   - *Completion criterion:* Output preserves both `[HORIZONTE CANÔNICO: PRÉ-2023]` and `[HORIZONTE CONTEMPORÂNEO: PÓS-2023]` sections plus `[DIFERENCIAL E CONFLITOS]` when Split-Horizon is enabled.

3. **Filter and score retrieved pages** before feeding them into context:
   ```bash
   npx deslop classify --title "Page Title" --url "https://example.com/post" --text "Extracted snippet or body..." --json
   ```
   - Drop any result with `verdict: "SLOP"` (`score >= 0.60`) or `blockedDomain: true`.
   - *Completion criterion:* Zero blocked scraper clones (`stackoom`, `copyprogramming`, `codegrepper`, `qastack`, etc.) or `SLOP`-verdict pages enter the synthesis context.

## Routing Profiles (`data/sources.json`)

| Profile | Target Channels | Best For |
|---|---|---|
| `qa` | StackOverflow, ServerFault, SuperUser, Unix SE | Exact compiler errors, SQL tuning, shell/OS administration |
| `discussions` | Reddit, Hacker News, Lobste.rs | Post-mortems, war stories, library trade-offs, candid benchmarks |
| `code` | GitHub Issues/Discussions/Gists, GitLab, Codeberg, sr.ht | Workarounds, minimal reproductions, archived reference repos |
| `blogs` | Curated indie engineering blogs (`danluu.com`, `jvns.ca`, `aphyr.com`, `fasterthanli.me`, `research.swtch.com`, etc.) | Systems architecture, deep internals, distributed systems |
| `forums` | `lwn.net`, Arch/Gentoo/FreeBSD forums, Rust/Python/Elixir Discourse | Kernel behavior, language internals, distro-level debugging |
| `all_community` | Reddit + StackOverflow + HN + Lobste.rs + GitHub | Broad high-signal sweep across community hubs |

## Heuristic Slop Signals (`data/slop-lexicon.json`)

The deterministic classifier evaluates five orthogonal signals in linear time $O(N)$ without LLM API calls:
- **Lexical AI Jargon (EN + PT-BR):** Detects synthetic filler (*"delve into"*, *"rich tapestry"*, *"in today's fast-paced digital"*, *"na era digital de hoje"*, *"rica tapeçaria"*, *"guia definitivo e abrangente"*).
- **Bold-Colon Listicle Symmetry:** Flags mechanical `1. **Title:** Generic explanation` scaffolding across $\ge 3$ consecutive items.
- **Paragraph Length Uniformity:** Measures coefficient of variation ($\text{CV} = \sigma / \mu$) across paragraphs; synthetic essays cluster below $\text{CV} < 0.18$.
- **Fake Translation & Year-Bait Markers:** Catches scraped CC-BY-SA machine translations and `[Updated 2026]` clickbait titles.
- **Technical Density Counter-Weight:** Discounts false positives when text contains real stack traces, CLI flags, code blocks, hex addresses, or file paths.
