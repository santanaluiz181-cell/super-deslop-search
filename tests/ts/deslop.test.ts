import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_HEADING,
  CONTEMPORARY_HEADING,
  DIFFERENTIAL_HEADING,
  DeslopSearch,
  classifySlop,
  deslopQuery,
  deslopSplitHorizon,
  executeDeslopTool,
  executeDeslopToolAsync,
  filterSearchResults
} from "../../src/index.js";

describe("TemporalDorkEngine", () => {
  it("injects after:2010 before:2023, inline spam exclusions, and Google udm=14 by default", () => {
    const res = deslopQuery("postgres vacuum wraparound");
    expect(res.eraApplied).toBe("human-classic");
    expect(res.compiledQuery).toContain("after:2010");
    expect(res.compiledQuery).toContain("before:2023");
    expect(res.compiledQuery).toContain("-site:copyprogramming.com");
    expect(res.compiledQuery).toContain("-site:stackoom.com");
    expect(res.searchUrl).toContain("udm=14");
    expect(res.operatorCount).toBeLessThanOrEqual(res.operatorBudget);
  });

  it("is strictly idempotent when compiling an already-compiled query", () => {
    const first = deslopQuery("linux epoll edge triggered");
    const second = deslopQuery(first.compiledQuery);
    expect(second.compiledQuery).toBe(first.compiledQuery);
  });

  it("strips zero-width tracking spaces and balances unclosed quotes safely", () => {
    const dirty = "  \u200B\"segmentation fault\u200D core dumped   ";
    const res = deslopQuery(dirty);
    expect(res.cleanQuery).toBe('"segmentation fault core dumped"');
    expect(res.compiledQuery.startsWith('"segmentation fault core dumped"')).toBe(true);
  });

  it("enforces per-engine operator limits (DuckDuckGo 24-token budget)", () => {
    const longQuery =
      "how to debug linux kernel memory leak slab allocator kmemleak tracepoint bpftrace perf";
    const res = deslopQuery(longQuery, { engine: "duckduckgo" });
    expect(res.operatorBudget).toBe(24);
    expect(res.operatorCount).toBeLessThanOrEqual(24);
  });

  it("warns on post-2022 subjects by default and auto-shifts when smartTemporal is enabled", () => {
    const strict = deslopQuery("React 19 useActionState hydration error");
    expect(strict.eraApplied).toBe("human-classic");
    expect(strict.warnings.length).toBeGreaterThan(0);

    const smart = deslopQuery("React 19 useActionState hydration error", {
      smartTemporal: true
    });
    expect(smart.eraApplied).toBe("modern-curated");
    expect(smart.compiledQuery).toContain("after:2023");
    expect(smart.compiledQuery).not.toContain("before:2023");
    expect(smart.includedSites).toContain("reddit.com");
  });
});

describe("CommunityRouter", () => {
  it("routes queries to curated community profiles and builds vertical native URLs", () => {
    const engine = new DeslopSearch();
    const qaDork = engine.compileQuery("git rebase interactive squash", { profile: "qa" });
    expect(qaDork.compiledQuery).toContain("site:stackoverflow.com");
    expect(qaDork.excludedSitesInline).toHaveLength(0);

    const routes = engine.buildRoutes("btrfs raid5 write hole", {
      channels: ["hackernews", "reddit", "github"]
    });
    expect(routes).toHaveLength(3);
    const hn = routes.find((r) => r.channel === "hackernews");
    expect(hn?.nativeSearchUrl).toContain("dateEnd=1672531200");
  });
});

describe("SlopClassifier", () => {
  it("flags synthetic English SEO AI articles as SLOP", () => {
    const slopArticle = `
In today's fast-paced digital landscape, managing containers has become a game-changer for modern teams. Let's dive deep into how Kubernetes unlocks the full potential of cloud infrastructure.

1. **Seamless Integration:** It is important to note that orchestration fosters innovation across workflows.
2. **Scalable Architecture:** Delving into pods reveals a rich tapestry of microservices working in harmony.
3. **Enhanced Productivity:** Empowering developers to elevate your workflow with a robust and scalable solution.
4. **Automated Recovery:** Navigating the complexities of cluster state becomes effortless.

In conclusion, whether you are a beginner or seasoned architect, following these best practices ensures success.
    `;
    const result = classifySlop({
      title: "[Updated 2026] Ultimate Guide to Docker & Kubernetes",
      text: slopArticle
    });
    expect(result.verdict).toBe("SLOP");
    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.signals.some((s) => s.code === "lexical_ai_jargon")).toBe(true);
    expect(result.signals.some((s) => s.code === "symmetrical_bold_colon_list")).toBe(true);
  });

  it("flags synthetic Portuguese AI filler and scraper translation clones as SLOP", () => {
    const ptSlop = `
Na era digital de hoje, compreender mensageria assíncrona é um verdadeiro divisor de águas. Vamos mergulhar fundo neste guia definitivo e abrangente para desbloquear todo o potencial do Kafka.

É importante destacar que a integração perfeita e contínua forma uma rica tapeçaria de eventos. Além disso, por outro lado, vale ressaltar que esta resposta foi traduzida automaticamente.

Em conclusão, seja você um iniciante ou especialista, alavancar seus resultados exige prática.
    `;
    const result = classifySlop({
      url: "https://qastack.com.br/programming/12345/kafka",
      text: ptSlop
    });
    expect(result.blockedDomain).toBe(true);
    expect(result.verdict).toBe("SLOP");
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it("preserves dense human engineering posts as AUTHENTIC", () => {
    const humanPost = `
Hit SIGSEGV (0x00007ff8a120) in epoll_wait() when closing fd 42 from a second worker thread without EPOLLONESHOT.

Repro with \`strace -f --trace=epoll_ctl,close ./server --workers 4\`:
\`\`\`c
struct epoll_event ev = { .events = EPOLLIN | EPOLLET, .data.fd = conn_fd };
epoll_ctl(epfd, EPOLL_CTL_ADD, conn_fd, &ev);
\`\`\`
See RFC 793 and /proc/sys/fs/epoll/max_user_watches. Switching to EPOLLONESHOT fixed the race.
    `;
    const result = classifySlop({
      title: "epoll_wait race condition when closing fd across threads",
      url: "https://jvns.ca/blog/2021/epoll-notes/",
      text: humanPost
    });
    expect(result.verdict).toBe("AUTHENTIC");
    expect(result.trustedCommunityDomain).toBe(true);
    expect(result.technicalDensity).toBeGreaterThan(0.4);
    expect(result.score).toBeLessThan(0.2);
  });

  it("handles oversized HTML payloads linearly without ReDoS", () => {
    const hugeHtml = `<p>${"word ".repeat(20_000)}</p>`;
    const start = performance.now();
    const res = classifySlop({ text: hugeHtml });
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(150);
    expect(res.score).toBeGreaterThanOrEqual(0);
  });
});

describe("Split-Horizon Comparative Engine", () => {
  it("compiles dual Lane A (Pre-2023 Canonical) and Lane B (Post-2023 Filtered) dorks with demarcated headings", () => {
    const plan = deslopSplitHorizon("nextjs data fetching caching after:2024");
    expect(plan.splitHorizon).toBe(true);

    // Lane A overrides conflicting after:2024 and routes to human communities
    expect(plan.canonicalPre2023.heading).toBe(CANONICAL_HEADING);
    expect(plan.canonicalPre2023.query.compiledQuery).toContain("before:2023");
    expect(plan.canonicalPre2023.query.compiledQuery).not.toContain("after:2024");
    expect(plan.canonicalPre2023.query.includedSites).toContain("reddit.com");
    expect(plan.canonicalPre2023.query.includedSites).toContain("stackoverflow.com");
    expect(plan.canonicalPre2023.archivedGithubUrl).toContain("archived%3Atrue");

    // Lane B applies after:2023 and enforces inline blocklist exclusions
    expect(plan.contemporaryPost2023.heading).toBe(CONTEMPORARY_HEADING);
    expect(plan.contemporaryPost2023.query.compiledQuery).toContain("after:2023");
    expect(plan.contemporaryPost2023.query.compiledQuery).not.toContain("before:2023");
    expect(plan.contemporaryPost2023.query.excludedSitesInline).toContain("copyprogramming.com");

    expect(plan.formattedReport).toContain(CANONICAL_HEADING);
    expect(plan.formattedReport).toContain(CONTEMPORARY_HEADING);
    expect(plan.formattedReport).toContain(DIFFERENTIAL_HEADING);
  });

  it("executes Lane A and Lane B concurrently in parallel and detects conceptual divergence + slop purging", async () => {
    const engine = new DeslopSearch();
    const delay = (ms: number): Promise<void> =>
      new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
      });

    const t0 = performance.now();
    const report = await engine.liveSplitHorizonSearch("react form state management", {
      laneAFetcher: async () => {
        await delay(70);
        return [
          {
            title: "Handling forms in React 17 with controlled useState and redux_form",
            url: "https://stackoverflow.com/questions/610000/react-17-forms",
            snippet: "Use `redux_form` or `componentWillReceiveProps` in legacy React 17 apps.",
            source: "stackoverflow"
          }
        ];
      },
      laneBFetcher: async () => {
        await delay(70);
        return [
          {
            title: "[Updated 2026] Ultimate Guide to React Forms",
            url: "https://copyprogramming.com/howto/react-forms-slop",
            snippet: "In today's fast-paced digital landscape, let's dive deep into forms."
          },
          {
            title: "React 19 deprecates legacy form patterns in favor of useActionState (CVE-2024-12345)",
            url: "https://github.com/facebook/react/issues/29000",
            snippet:
              "componentWillReceiveProps is deprecated and removed; migrate to `useActionState` in React 19 to mitigate CVE-2024-12345.",
            source: "github"
          }
        ];
      }
    });
    const elapsedMs = performance.now() - t0;

    // Parallel execution proof: 2 x 70ms sequential would take >= 140ms; parallel finishes well under 130ms
    expect(elapsedMs).toBeLessThan(130);

    expect(report.canonicalPre2023.results.stats.keptCount).toBe(1);
    expect(report.contemporaryPost2023.results.stats.keptCount).toBe(1);
    expect(report.contemporaryPost2023.results.stats.discardedCount).toBe(1);
    expect(report.differential.status).toBe("DIVERGENT");
    expect(report.differential.canonicalOnlyTerms).toContain("React 17");
    expect(report.differential.contemporaryOnlyTerms).toContain("React 19");
    expect(
      report.differential.conflictSignals.some((s) => s.kind === "deprecation_or_breaking_shift")
    ).toBe(true);
    expect(
      report.differential.conflictSignals.some((s) => s.kind === "slop_saturation_warning")
    ).toBe(true);
    expect(report.formattedReport).toContain(CANONICAL_HEADING);
    expect(report.formattedReport).toContain(CONTEMPORARY_HEADING);
    expect(report.formattedReport).toContain(DIFFERENTIAL_HEADING);
  });

  it("flags ANACHRONISTIC topics when pre-2023 canonical archive has 0 results", () => {
    const engine = new DeslopSearch();
    const report = engine.compareHorizons(
      "tailwind v4 oxide engine",
      [],
      [
        {
          title: "Tailwind v4 alpha benchmarks with --oxide-parser",
          url: "https://github.com/tailwindlabs/tailwindcss/discussions/13000",
          snippet: "Tailwind v4 replaces PostCSS pipeline with Rust --oxide-parser."
        }
      ]
    );
    expect(report.differential.status).toBe("ANACHRONISTIC");
    expect(
      report.differential.conflictSignals.some((s) => s.kind === "anachronism_warning")
    ).toBe(true);
  });
});

describe("Pipeline & Agent MCP Tools", () => {
  it("filters out scraper clones and ranks human community threads first", () => {
    const batch = filterSearchResults([
      {
        title: "[Updated 2026] Best Way to Fix ENOENT in Node",
        url: "https://copyprogramming.com/howto/fix-enoent-node",
        snippet: "In today's fast-paced digital world, let's delve into ENOENT..."
      },
      {
        title: "fs.readFileSync ENOENT under chroot symlink",
        url: "https://stackoverflow.com/questions/1928374/fs-readfilesync-enoent",
        snippet: "Check `process.cwd()` and `--preserve-symlinks`; error ENOENT thrown at open()."
      }
    ]);

    expect(batch.stats.keptCount).toBe(1);
    expect(batch.stats.discardedCount).toBe(1);
    expect(batch.kept[0]?.url).toContain("stackoverflow.com");
  });

  it("executes single and split_horizon agent tool calls cleanly via MCP dispatcher and skill.json", async () => {
    const singleOut = executeDeslopTool("deslop_build_query", {
      query: "sqlite wal checkpoint starvation",
      profile: "discussions"
    }) as { compiledQuery: string };
    expect(singleOut.compiledQuery).toContain("before:2023");
    expect(singleOut.compiledQuery).toContain("site:reddit.com");

    const splitPlan = executeDeslopTool("deslop_build_query", {
      query: "openssl x509 certificate chain",
      split_horizon: true
    }) as { splitHorizon: boolean; formattedReport: string };
    expect(splitPlan.splitHorizon).toBe(true);
    expect(splitPlan.formattedReport).toContain(CANONICAL_HEADING);
    expect(splitPlan.formattedReport).toContain(CONTEMPORARY_HEADING);

    const compared = (await executeDeslopToolAsync("deslop_split_horizon", {
      query: "http2 rapid reset",
      canonical_results: [
        {
          title: "RFC 7540 HTTP/2 stream concurrency",
          url: "https://lwn.net/Articles/650000/",
          snippet: "HTTP/2 multiplexes streams via RST_STREAM frames."
        }
      ],
      contemporary_results: [
        {
          title: "CVE-2023-44487 HTTP/2 Rapid Reset vulnerability mitigation",
          url: "https://news.ycombinator.com/item?id=37830998",
          snippet: "Unbounded RST_STREAM exploited in CVE-2023-44487; patch nghttp2 immediately."
        }
      ]
    })) as { differential: { status: string } };
    expect(compared.differential.status).toBe("DIVERGENT");

    const manifestRaw = readFileSync(resolve(process.cwd(), "skill.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    };
    const buildTool = manifest.tools.find((t) => t.name === "deslop_build_query");
    expect(buildTool?.inputSchema.properties["split_horizon"]).toBeDefined();
    expect(manifest.tools.some((t) => t.name === "deslop_split_horizon")).toBe(true);
  });
});
