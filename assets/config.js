export const APP_CONFIG = {
  // Create a dedicated Supabase project, then replace these two public values.
  supabaseUrl: "https://ygtuxswpbdesqizqtlpl.supabase.co",
  supabasePublishableKey: "sb_publishable_82gVXkXTtgEVlQ_cPlKIjQ_tgCt5PsS",

  gameCatalogUrl:
    "https://cdn.jsdelivr.net/npm/gn-math.github.io-main@1.0.1/zones.json",
  gameCoverBase: "https://raw.githubusercontent.com/gn-math/covers/main",
  gameHtmlBase:
    "https://cdn.jsdelivr.net/npm/gn-math.github.io-main@1.0.4/html-main",

  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  maxCatalogGames: 800,
  mediaMaxBytes: 25 * 1024 * 1024,
};

export const isSupabaseConfigured = () =>
  APP_CONFIG.supabaseUrl.startsWith("https://") &&
  !APP_CONFIG.supabasePublishableKey.startsWith("YOUR_");
