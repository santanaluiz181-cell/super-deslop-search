import { TemporalDorkEngine } from "./dorks.js";
import { loadRules } from "./rules.js";
import type {
  CommunityChannelName,
  DorkOptions,
  SearchEngine,
  VerticalRoute
} from "./types.js";

function buildNativeChannelUrl(channel: CommunityChannelName, cleanQuery: string): string | undefined {
  const encoded = encodeURIComponent(cleanQuery);
  switch (channel) {
    case "reddit":
      return `https://old.reddit.com/search?q=${encoded}&sort=relevance&t=all`;
    case "hackernews":
      // Native Algolia HN pre-2023 timestamp cutoff (2023-01-01T00:00:00Z = 1672531200)
      return `https://hn.algolia.com/?q=${encoded}&dateRange=custom&dateEnd=1672531200&type=all`;
    case "stackoverflow":
      return `https://stackoverflow.com/search?q=${encodeURIComponent(`${cleanQuery} created:..2022-12-31`)}`;
    case "github":
      return `https://github.com/search?q=${encodeURIComponent(`${cleanQuery} created:<2023-01-01`)}&type=issues`;
    case "indie_forums":
    case "engineering_blogs":
      return undefined;
  }
}

export class CommunityRouter {
  private readonly dorkEngine: TemporalDorkEngine;

  public constructor(dorkEngine = new TemporalDorkEngine()) {
    this.dorkEngine = dorkEngine;
  }

  public buildVerticalRoutes(
    rawQuery: string,
    options: Omit<DorkOptions, "profile" | "channels"> & {
      channels?: readonly CommunityChannelName[];
    } = {}
  ): VerticalRoute[] {
    const rules = loadRules();
    const engine: SearchEngine = options.engine ?? "google";
    const selectedChannels: readonly CommunityChannelName[] =
      options.channels ??
      (Object.keys(rules.sources.channels) as CommunityChannelName[]);

    const routes: VerticalRoute[] = [];

    for (const channelName of selectedChannels) {
      const channelConfig = rules.sources.channels[channelName];
      const compiled = this.dorkEngine.compile(rawQuery, {
        ...options,
        engine,
        profile: "none",
        channels: [channelName]
      });

      const nativeUrl =
        compiled.eraApplied === "modern-curated" || compiled.eraApplied === "none"
          ? undefined
          : buildNativeChannelUrl(channelName, compiled.cleanQuery);

      const route: VerticalRoute = {
        channel: channelName,
        label: channelConfig.label,
        compiledQuery: compiled.compiledQuery,
        engineUrl: compiled.searchUrl
      };
      if (nativeUrl !== undefined) {
        route.nativeSearchUrl = nativeUrl;
      }
      routes.push(route);
    }

    return routes;
  }
}
