import { NDKEvent, NostrEvent } from "@nostr-dev-kit/ndk";
import { Site } from "../types/site";
import { tags, tv } from "./utlis";
import { nip19 } from "nostr-tools";
import { Post } from "../types/post";
import { marked } from "marked";
// import moment from "moment-timezone";
import { KIND_LONG_NOTE, KIND_NOTE, KIND_PACKAGE, KIND_SITE } from "../consts";
import { Profile } from "../types/profile";
import { Author } from "../types/author";
import { Theme } from "../types/theme";
import { DateTime } from "luxon";
// @ts-ignore
import downsize from "downsize-cjs";
import { SiteAddr } from "../types/site-addr";
import { slugify } from "../../ghost/helpers/slugify";

function fromUNIX(ts: number | undefined) {
  return DateTime.fromMillis((ts || 0) * 1000).toISO() || "";
}

export class NostrParser {
  readonly origin?: string;
  private config: Map<string, string> | undefined;

  constructor(origin?: string) {
    this.origin = origin;
  }

  public setConfig(config: Map<string, string>) {
    this.config = config;
  }

  public getId(e: NDKEvent) {
    if (e.kind === undefined) return "";
    const isMeta = e.kind === 0 || e.kind === 3;
    const isReplaceable = e.kind >= 10000 && e.kind < 20000;
    const isPRE = e.kind >= 30000 && e.kind < 40000;
    if (isMeta || isReplaceable || isPRE) {
      return nip19.naddrEncode({
        identifier: tv(e, "d") || "",
        kind: e.kind,
        pubkey: e.pubkey,
      });
    } else {
      return nip19.noteEncode(e.id);
    }
  }

  public getAuthorId(e: NostrEvent) {
    return nip19.npubEncode(e.pubkey);
  }

  public parseSite(addr: SiteAddr, event: NDKEvent | null): Site {
    if (!event) throw new Error("Site not found");

    const id = nip19.naddrEncode({
      identifier: addr.name,
      kind: KIND_SITE,
      pubkey: addr.pubkey,
      relays: addr.relays,
    });

    const ref = tv(event, "r");
    const url = ref ? new URL(ref) : null;

    const settings: Site = {
      id,
      event: event.rawEvent(),

      name: tv(event, "d") || "",
      admin_pubkey: event.pubkey,
      admin_relays: addr.relays,

      url: url ? url.pathname : "/",
      origin: this.origin || (url ? url.origin : ""),

      contributor_pubkeys: tags(event, "p").map((t) => t[1]),
      contributor_relays: [],

      include_tags: tags(event, "include", 3).map((t) => ({
        tag: t[1],
        value: t[2],
      })),
      include_all: !!tags(event, "include", 2).find((t) => t[1] === "*"),
      include_manual: !!tags(event, "include", 2).find((t) => t[1] === "?"),
      include_kinds: tags(event, "kind").map((t) => t[1]),
      include_relays: tags(event, "relay").map((t) => t[1]),

      engine: tv(event, "x") || undefined,
      themes: tags(event, "y").map((t) => t[1]),
      plugins: tags(event, "z").map((t) => t[1]),

      title: tv(event, "title"),
      timezone: "UTC",
      description: tv(event, "summary"),
      logo: tv(event, "logo"),
      icon: tv(event, "icon"),
      accent_color: null,
      cover_image: tv(event, "image"),
      facebook: null,
      twitter: null,
      lang: tv(event, "lang"),

      codeinjection_head: null,
      codeinjection_foot: null,
      navigation: tags(event, "nav", 3).map((t) => ({
        label: t[2],
        url: t[1],
      })),
      secondary_navigation: [],
      meta_title: tv(event, "meta_title"),
      meta_description: tv(event, "meta_description"),
      og_image: tv(event, "og_image"),
      og_title: tv(event, "og_title"),
      og_description: tv(event, "og_description"),
      twitter_image: tv(event, "twitter_image"),
      twitter_title: tv(event, "twitter_title"),
      twitter_description: tv(event, "twitter_description"),
      members_support_address: null,

      extensions: tags(event, "x", 5).map((x) => ({
        event_id: x[1],
        relay: x[2],
        package_hash: x[3],
        petname: x[4],
      })),

      config: new Map(),
      custom: new Map(),
    };

    // admin is the only contributor?
    if (
      !settings.contributor_pubkeys.length ||
      (settings.contributor_pubkeys.length === 1 &&
        settings.contributor_pubkeys[0] === addr.pubkey)
    ) {
      settings.contributor_pubkeys = [addr.pubkey];
      settings.contributor_relays = addr.relays;
    }

    if (settings.include_relays && settings.include_relays.length > 0)
      settings.contributor_relays = settings.include_relays;

    for (const c of tags(event, "config", 3)) {
      settings.config.set(c[1], c[2]);
    }

    for (const c of tags(event, "custom", 3)) {
      settings.custom.set(c[1], c[2]);
    }

    if (!settings.url?.endsWith("/")) settings.url += "/";

    settings.comments_enabled = this.config?.get("comments_enabled") === "true";
    settings.recommendations_enabled =
      this.config?.get("recommendations_enabled") === "true";

    // FIXME for testing
    // settings.secondary_navigation = settings.navigation;

    return settings;
  }

  public async parseTheme(e: NDKEvent) {
    if (e.kind !== KIND_PACKAGE) throw new Error("Bad kind: " + e.kind);
    const id = this.getId(e);
    const theme: Theme = {
      id,

      name: tv(e, "title") || id,

      dir: `/${id}/`,

      config: {},
      custom: {},

      entries: tags(e, "f", 4).map((f) => ({
        hash: f[1],
        path: f[2],
        url: f[3],
      })),

      templates: tags(e, "f", 4)
        .filter((f) => !f[2].includes("/") && f[2].endsWith(".hbs"))
        .map((f) => f[2].split(".hbs")[0]),

      partials: tags(e, "f", 4)
        .filter((f) => f[2].startsWith("partials/") && f[2].endsWith(".hbs"))
        .map((f) => f[2].split("partials/")[1]),
    };

    for (const e of theme.entries) {
      const name = e.path.includes("/")
        ? e.path.split("/").pop() || ""
        : e.path;
      if (!name) {
        console.warn("Bad theme asset path", e);
        continue;
      }
      const ext = name.split(".").pop();
      if (ext && ext !== name) e.url = `${e.url}.${ext}`;
    }

    const packageJsonUrl = theme.entries.find(
      (f) => f.path === "package.json"
    )!.url;
    const packageJson = await fetch(packageJsonUrl).then((r) => r.json());
    console.log("packageJson", packageJson);
    if (packageJson.config) {
      if (packageJson.config.custom) {
        for (const name in packageJson.config.custom) {
          theme.custom[name] = packageJson.config.custom[name]["default"];
        }
      }
      theme.config = packageJson.config;
    }
    console.log("parsed theme", theme);
    return theme;
  }

  public async parseLongNote(e: NDKEvent) {
    if (e.kind !== KIND_LONG_NOTE) throw new Error("Bad kind: " + e.kind);

    const id = this.getId(e);
    const html = await marked.parse(e.content);
    const post: Post = {
      id,
      slug: slugify(tv(e, "slug") || tv(e, "d") || id),
      uuid: e.id,
      url: "",
      title: tv(e, "title"),
      html,
      comment_id: e.id,
      feature_image: tv(e, "image"),
      feature_image_alt: null,
      feature_image_caption: null,
      featured: false,
      visibility: "public",
      created_at: fromUNIX(e.created_at),
      updated_at: fromUNIX(e.created_at),
      published_at: fromUNIX(
        parseInt(tv(e, "published_at") || "" + e.created_at)
      ),
      custom_excerpt: null,
      codeinjection_head: null,
      codeinjection_foot: null,
      custom_template: null,
      canonical_url: null,
      excerpt:
        tv(e, "summary") ||
        (await marked.parse(downsize(e.content, { words: 50 }))),
      reading_time: 0,
      access: true,
      og_image: null,
      og_title: null,
      og_description: null,
      twitter_image: null,
      twitter_title: null,
      twitter_description: null,
      meta_title: null,
      meta_description: null,
      email_subject: null,
      primary_tag: null,
      tags: [],
      primary_author: null,
      authors: [],
      markdown: e.content,
      images: [],
      links: this.parseTextLinks(e.content),
      nostrLinks: this.parseNostrLinks(e.content),
      event: e.rawEvent(),
      show_title_and_feature_image: true,
    };

    post.images = this.parseImages(post);
    if (!post.feature_image && post.images.length)
      post.feature_image = post.images[0];

    // FIXME config
    post.og_description = post.links.find((u) => this.isVideoUrl(u)) || null;

    return post;
  }

  public async parseNote(e: NDKEvent) {
    if (e.kind !== KIND_NOTE) throw new Error("Bad kind: " + e.kind);

    const id = this.getId(e);
    const post: Post = {
      id,
      slug: slugify(tv(e, "slug") || id),
      uuid: e.id,
      url: "",
      title: "",
      html: null,
      comment_id: e.id,
      feature_image: "",
      feature_image_alt: null,
      feature_image_caption: null,
      featured: false,
      visibility: "public",
      created_at: fromUNIX(e.created_at),
      updated_at: fromUNIX(e.created_at),
      published_at: fromUNIX(
        parseInt(tv(e, "published_at") || "" + e.created_at)
      ),
      custom_excerpt: null,
      codeinjection_head: null,
      codeinjection_foot: null,
      custom_template: null,
      canonical_url: null,
      excerpt: null,
      reading_time: 0,
      access: true,
      og_image: null,
      og_title: null,
      og_description: null,
      twitter_image: null,
      twitter_title: null,
      twitter_description: null,
      meta_title: null,
      meta_description: null,
      email_subject: null,
      primary_tag: null,
      tags: [],
      primary_author: null,
      authors: [],
      markdown: "",
      images: [],
      links: this.parseTextLinks(e.content),
      nostrLinks: this.parseNostrLinks(e.content),
      event: e.rawEvent(),
      show_title_and_feature_image: true,
    };

    // parse images, set feature image
    post.images = this.parseImages(post);
    if (!post.feature_image && post.images.length)
      post.feature_image = post.images[0];

    // only one image url at the start? cut it, we're
    // using it in feature_image
    let content = e.content;
    if (
      post.images.length === 1 &&
      (content.trim().startsWith(post.images[0]) ||
        content.trim().endsWith(post.images[0]))
    ) {
      content = content.replace(post.images[0], "");
    }

    // now format content w/o the feature_image
    post.markdown = content;
    post.html = await marked.parse(content);

    // now cut all links to create a title and excerpt
    let textContent = content;
    for (const l of post.links) textContent = textContent.replace(l, "");
    for (const l of post.nostrLinks) textContent = textContent.replace(l, "");
    post.excerpt = downsize(textContent, { words: 50 });
    post.title = downsize(textContent.trim().split("\n")[0], { words: 10 });

    // short content (title === content) => empty title
    if (content.trim() === post.title?.trim()) post.title = null;

    // podcasts
    if (this.getConf("podcast_media_in_og_description") === "true") {
      post.og_description =
        post.links.find((u) => this.isVideoUrl(u) || this.isAudioUrl(u)) ||
        null;
    }

    return post;
  }

  private getConf(name: string): string | undefined {
    if (!this.config) return "";
    return this.config.get(name);
  }

  public parseHashtags(e: NDKEvent): string[] {
    return tags(e, "t").map((tv) => tv[1]);
  }

  public parseProfile(e: NDKEvent): Profile {
    return {
      id: this.getAuthorId(e.rawEvent()),
      pubkey: e.pubkey,
      profile: JSON.parse(e.content),
      event: e,
    };
  }

  public parseAuthor(profile: Profile): Author {
    return {
      id: profile.id,
      slug: profile.id,
      name:
        profile.profile?.display_name || profile.profile?.name || profile.id,
      email: null,
      profile_image: profile.profile?.picture || null,
      cover_image: profile.profile?.banner || null,
      bio: profile.profile?.about || null,
      website: profile.profile?.website || null,
      location: null,
      facebook: null,
      twitter: null,
      accessibility: null,
      status: "active",
      meta_title: null,
      meta_description: null,
      tour: null,
      last_seen: null,
      created_at: fromUNIX(profile.event.created_at),
      updated_at: fromUNIX(profile.event.created_at),
      permissions: [],
      roles: [],
      count: { posts: 0 },
      url: "",
      event: profile.event,
    };
  }

  private parseMarkdownImages(markdown: string | undefined): string[] {
    if (!markdown) return [];

    const IMAGE_MD_RX = /!\[(.*)\]\((.+)\)/g;
    return [
      ...new Set(
        [...markdown.matchAll(IMAGE_MD_RX)]
          .filter((m) => m?.[2])
          .map((m) => m[2])
      ),
    ];
  }

  private parseTextLinks(text: string): string[] {
    if (!text) return [];
    const RX =
      /(?:(?:https?):\/\/)(?:([-A-Z0-9+&@#/%=~_|$?!:,.]*)|[-A-Z0-9+&@#/%=~_|$?!:,.])*(?:([-A-Z0-9+&@#/%=~_|$?!:,.]*)|[A-Z0-9+&@#/%=~_|$])/gi;
    return [...new Set([...text.matchAll(RX)].map((m) => m[0]))];
  }

  private parseNostrLinks(text: string): string[] {
    if (!text) return [];
    const RX = /nostr:[^\s\?:]+/gi;
    return [...new Set([...text.matchAll(RX)].map((m) => m[0]))];
  }

  private isImageUrl(u: string) {
    try {
      const url = new URL(u);
      const ext = url.pathname.split(".").pop();
      switch (ext?.toLowerCase()) {
        case "png":
        case "svg":
        case "jpg":
        case "jpeg":
        case "gif":
        case "tif":
        case "tiff":
        case "webp":
          return true;
      }
    } catch {}
    return false;
  }

  private isVideoUrl(u: string) {
    try {
      const url = new URL(u);
      const ext = url.pathname.split(".").pop();
      switch (ext?.toLowerCase()) {
        case "mp4":
        case "avi":
        case "mpeg":
        case "mkv":
        case "webm":
        case "ogv":
          return true;
      }
    } catch {}
    return false;
  }

  private isAudioUrl(u: string) {
    try {
      const url = new URL(u);
      const ext = url.pathname.split(".").pop();
      switch (ext?.toLowerCase()) {
        case "mp3":
        case "aac":
        case "ogg":
        case "wav":
        case "weba":
          return true;
      }
    } catch {}
    return false;
  }

  private parseImages(post: Post): string[] {
    const images: string[] = [];
    if (post.feature_image) images.push(post.feature_image);

    // collect images from markdown
    images.push(...this.parseMarkdownImages(post.markdown));

    // extract from string content
    const urls = this.parseTextLinks(post.event.content);
    images.push(...urls.filter((u) => this.isImageUrl(u)));

    // unique
    return [...new Set(images)];
  }
}
