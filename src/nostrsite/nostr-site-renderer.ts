import NDK, {
  NDKEvent,
  NDKFilter,
  NDKRelaySet,
  NostrEvent,
} from "@nostr-dev-kit/ndk";

// @ts-ignore FIXME ADD TYPES
import BrowserHbs from "browser-hbs";

// FIXME get rid of it when we start loading settings from the nostr event
// @ts-ignore
import loader from "../ghost/shared/config/loader";

import { Site } from "./types/site";
import { ThemeEngine } from "./theme-engine";
import { Theme } from "./types/theme";
import { NostrStore } from "./store/nostr-store";
import {
  JQUERY,
  KIND_PACKAGE,
  KIND_SITE,
  OUTBOX_RELAYS,
} from "./consts";
import { NostrParser } from "./parser/parser";
// import { theme, theme1, theme2, theme3 } from "../sample-themes";
import { SiteAddr } from "./types/site-addr";
import { RenderOptions, Renderer, ServiceWorkerCaches } from "./types/renderer";
import { fetchOutboxRelays, isBlossomUrl } from "./utils";
import { dbi } from "./store/db";

export class NostrSiteRenderer implements Renderer {
  private addr: SiteAddr;
  public settings?: Site;
  public theme?: Theme;
  private options?: RenderOptions;
  private ndk?: NDK;
  private engine?: ThemeEngine;
  private caches?: ServiceWorkerCaches;
  private store?: NostrStore;
  private hasStarted: boolean = false;

  constructor(addr: SiteAddr) {
    this.addr = addr;
  }

  public getAddr() {
    return this.addr;
  }

  public started() {
    return this.hasStarted;
  }

  public getThemeAssets(): string[] {
    if (!this.theme) return [];
    return this.theme.entries.map((e) => e.url);
  }

  private async connect() {
    // initially we connect to the relays from site addr,
    // buy also to outbox relays to find the relay lists of
    // the site admin in case addr.relays aren't responding

    // outbox relays
    const relays = OUTBOX_RELAYS;

    // addr relays
    if (this.addr.relays) relays.push(...this.addr.relays);

    this.ndk = new NDK({
      explicitRelayUrls: relays,
    });

    // let caller decide whether they'd block on it or not
    return this.ndk.connect();
  }

  private async fetchSite() {
    // cached sites
    if (this.options!.mode !== "ssr") {
      const sites = await dbi.listKindEvents(KIND_SITE, 10);

      // find cached site
      const cachedSite = sites.find(
        (s) => s.pubkey === this.addr.pubkey && s.d_tag === this.addr.name
      );
      console.log("cache site", cachedSite, sites);

      // drop old cached sites, if any
      const oldSiteIds = sites
        .filter((s) => s.id !== cachedSite?.id)
        .map((s) => s.id);
      dbi.deleteEvents(oldSiteIds);

      // got cached one
      if (cachedSite) return new NDKEvent(this.ndk, cachedSite);
    }

    // helper
    const fetchFromRelays = async (relayUrls: string[]) => {
      console.log("fetching site from relays", relayUrls);
      return await this.ndk!.fetchEvent(
        {
          // @ts-ignore
          kinds: [KIND_SITE],
          authors: [this.addr.pubkey],
          "#d": [this.addr.name],
        },
        { groupable: false },
        NDKRelaySet.fromRelayUrls(relayUrls, this.ndk!)
      )
    };

    // FIXME create some purplepag.es-like relay that
    // only stores site events
    const relays = [];
    if (this.addr.relays) relays.push(...this.addr.relays);

    // fetch site object
    let site = await fetchFromRelays(relays);

    // not found on expected relays? look through the
    // admin outbox relays
    if (!site) {
      console.warn("site not found on addr relays", this.addr.relays);

      const outboxRelays = await fetchOutboxRelays(this.ndk!, [this.addr.pubkey]);
      console.log("site admin outbox relays", outboxRelays);
      if (!outboxRelays.length) {
        console.log("Failed to find outbox relays for", this.addr.pubkey);
      } else {
        site = await fetchFromRelays(outboxRelays);

        // replace the site relays
        if (site) this.addr.relays = outboxRelays;
      }
    }

    if (this.options!.mode !== "ssr") {
      if (site) dbi.addEvents([site]);
    }

    return site;
  }

  // private async fetchSampleThemes(_: Site, __: NostrParser): Promise<Theme[]> {
  //   console.warn("SAMPLE THEMES!");
  //   return Promise.resolve([theme, theme1, theme2, theme3]);
  // }

  private async fetchThemes(
    settings: Site,
    parser: NostrParser
  ): Promise<Theme[]> {
    const extIds = settings.extensions.map((x) => x.event_id);
    const exts: NostrEvent[] = [];
    if (this.options!.mode !== "ssr") {
      const cachedExtEvents = await dbi.listKindEvents(KIND_PACKAGE, 10);

      exts.push(...cachedExtEvents.filter((t) => extIds.includes(t.id)));
      console.log("cache themes", exts);

      // drop old cached exts
      const oldCachedExtIds = cachedExtEvents
        .filter((x) => !exts.find((e) => e.id === x.id))
        .map((x) => x.id);
      dbi.deleteEvents(oldCachedExtIds);

      // get non-cached ext ids to fetch from relays
      const nonCachedIds = extIds.filter(
        (id) => !exts.find((x) => x.id === id)
      );
      extIds.length = 0;
      extIds.push(...nonCachedIds);
    }

    // got non-cached themes?
    if (extIds.length) {
      const filter: NDKFilter = {
        // @ts-ignore
        kinds: [KIND_PACKAGE],
        ids: extIds,
      };
      console.log("fetch themes", filter);
      const events = await this.ndk!.fetchEvents(
        filter,
        { groupable: false },
        NDKRelaySet.fromRelayUrls(
          settings.extensions.map((x) => x.relay),
          this.ndk!
        )
      );
      if (!events) throw new Error("Theme not found");

      // put to cache
      if (this.options!.mode !== "ssr") dbi.addEvents([...events]);

      exts.push(...[...events].map((e) => e.rawEvent()));
    }

    // filter themes from exts
    const themeEvents = [...exts].filter((e) =>
      e.tags.find((t) => t.length >= 2 && t[0] === "l" && t[1] === "theme")
    );
    if (!themeEvents.length) throw new Error("No theme assigned");

    // themes must be sorted by their order in the list of extensions
    themeEvents.sort((a, b) => {
      const ai = settings.extensions.findIndex((x) => x.event_id === a.id);
      const bi = settings.extensions.findIndex((x) => x.event_id === b.id);
      return ai - bi;
    });
    console.log("got themes", themeEvents);

    // parse
    const themes: Theme[] = [];
    for (const e of themeEvents) {
      const theme = await parser.parseTheme(new NDKEvent(this.ndk, e));
      themes.push(theme);
    }

    console.log("parsed themes", themes);

    if ("document" in globalThis) this.preloadThemeAssets(themes[0]);

    return themes;
  }

  private preloadThemeAssets(theme: Theme) {
    // more info on preload/prefetch:
    // https://medium.com/reloading/preload-prefetch-and-priorities-in-chrome-776165961bbf
    const create = (url: string, as: string) => {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = as;
      link.href = url;
      // NOTE: do not try to apply style in onload,
      // it will cause stylesheet reload when we replace the html
      // with the rendered page
      console.log("preloading", url);
      document.head.appendChild(link);
    };
    for (const e of theme.entries) {
      if (e.url === JQUERY) {
        // skip, we're prefetching it in the ghost_head with
        // an integrity check
        continue;
      } else if (e.path === "gulpfile.js") {
        // this is an auxillary Ghost theme script never
        // included in the html
        continue;
      } else if (e.path.endsWith(".css")) {
        create(e.url, "style");
      } else if (e.path.endsWith(".js")) {
        create(e.url, "script");
      }
    }
  }

  public async destroy() {
    if (!this.ndk) return;
    if (this.store) this.store.destroy();
    for (const r of this.ndk.pool.relays.values()) {
      r.disconnect();
    }
  }

  public async start(options: RenderOptions) {
    this.options = options;

    const { origin } = options;

    // ndk connect to site relays
    // don't block and wait until all relays connect,
    // any relay can serve site event and we need it asap
    this.connect();

    // site event by the website admin
    const site = await this.fetchSite();
    console.log("site", site);
    if (!site) throw new Error("Nostr site event not found");

    const parser = new NostrParser(origin);

    // site settings from the database (settingsCache)
    const settings = parser.parseSite(this.addr, site);
    console.log("settings", settings);

    parser.setConfig(settings.config);

    // kinda server-side settings,
    // FIXME must also come from site event!
    const config = loader.loadNconf();
    config.url = new URL(settings.url || "/", origin || settings.origin).href;

    this.store = new NostrStore(options.mode, this.ndk!, settings, parser);

    this.engine = new ThemeEngine(this.store, options);

    // do it in parallel to save some latency
    const [themes] = await Promise.all([
      this.fetchThemes(settings, parser),
      this.store.load(options.maxObjects),
    ]);

    // now we have everything needed to init the engine
    await this.engine.init(settings, themes, config);

    // after data is loaded and engine is initialized,
    // prepare using the engine (assign urls etc)
    await this.store.prepare(this.engine);

    // some defaults
    if (!settings.cover_image && settings.contributor_pubkeys) {
      for (const pubkey of settings.contributor_pubkeys) {
        const profile = this.store.getProfile(pubkey);
        if (profile?.profile?.banner) {
          settings.cover_image = profile?.profile?.banner;
          break;
        }
      }
    }
    // FIXME somehow derive from profile etc
    // if (!settings.accent_color) {
    //   settings.accent_color = "rgb(255, 0, 149)";
    // }

    console.log("updated settings", settings);
    this.settings = settings;
    if (themes.length) this.theme = themes[0];

    if (this.caches && this.caches.themeCache) {
      await this.precacheTheme(this.caches.themeCache);
    }

    this.hasStarted = true;
  }

  public async render(path: string) {
    const r = await this.engine!.render(path);

    if (this.caches) {
      const blossom = r.context.mediaUrls.filter((u) => isBlossomUrl(u));
      const media = r.context.mediaUrls.filter((u) => !isBlossomUrl(u));
      if (this.caches.blossomCache)
        this.precacheMedia(this.caches.blossomCache, blossom);
      if (this.caches.mediaCache)
        this.precacheMedia(this.caches.mediaCache, media);
    }

    return r;
  }

  public async onUpdate(): Promise<void> {
    const filter = {
      // @ts-ignore
      kinds: [KIND_SITE],
      authors: [this.addr.pubkey],
      "#d": [this.addr.name],
      since: this.settings!.event.created_at,
    };

    return new Promise((ok) => {
      const sub = this.ndk!.subscribe(filter);
      sub.on("event", async (e: NDKEvent) => {
        if (e.created_at! <= this.settings!.event.created_at) return;
        console.log("sw got updated site, restarting");
        if (this.options!.mode !== "ssr") await dbi.addEvents([e]);
        sub.stop();
        ok();
      });
      sub.start();
      console.log("sw subscribed to updates of", this.addr);
    });
  }

  public setCaches(caches: ServiceWorkerCaches): void {
    this.caches = caches;
  }

  private async cacheAll(cache: Cache, urls: string[], MAX_ACTIVE: number) {
    let active = 0;
    return new Promise<void>((ok) => {
      const proceed = () => {
        active--;
        if (urls.length > 0) add();
        else ok();
      };
      const add = () => {
        const u = urls.shift();
        const r = new Request(u!, {
          cache: "force-cache",
        });
        active++;
        // console.log(Date.now(), "sw cache", active, u);
        cache.match(r).then((found) => {
          if (found) {
            // console.log(Date.now(), "sw already cached", u);
            return proceed();
          }

          // fetch
          cache
            .add(r)
            .then(proceed)
            .catch(() => {
              // console.log("Failed to put to cache", u, e);
              proceed();
            });
        });
      };
      while (urls.length > 0 && active < MAX_ACTIVE) add();
    });
  }

  private async precacheTheme(cache: Cache) {
    const assets = this.getThemeAssets();
    console.log("sw caching theme assets", assets);
    await this.cacheAll(cache, assets, 5);
  }

  private async precacheMedia(cache: Cache, urls: string[]) {
    const assets = [...new Set(urls)];
    console.log("sw cache assets", assets, cache);
    // FIXME this pre-caching seems to make no sense, unless we
    // pre-cache the next page of images!
    //await this.cacheAll(cache, assets, 5);
  }

  public async getSiteMap() {
    return this.engine!.getSiteMap();
  }
}
