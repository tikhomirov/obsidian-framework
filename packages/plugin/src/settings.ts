export interface PluginSettings {
  serverUrl: string;
  token: string;
  project: string;
  participantId: string;
  showArchived: boolean;
  hideEmptyColumns: boolean;
  refreshSeconds: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  project: "of",
  participantId: "owner",
  showArchived: false,
  hideEmptyColumns: true,
  refreshSeconds: 30,
};

/** Merge stored data with defaults, dropping wrong types. */
export function normalizeSettings(raw: unknown): PluginSettings {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (k: keyof PluginSettings): string => {
    const v = o[k];
    return typeof v === "string" ? v : (DEFAULT_SETTINGS[k] as string);
  };
  const bool = (k: keyof PluginSettings): boolean => {
    const v = o[k];
    return typeof v === "boolean" ? v : (DEFAULT_SETTINGS[k] as boolean);
  };
  const refresh = o["refreshSeconds"];
  return {
    serverUrl: str("serverUrl").trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.serverUrl,
    token: str("token").trim(),
    project: str("project").trim() || DEFAULT_SETTINGS.project,
    participantId: str("participantId").trim() || DEFAULT_SETTINGS.participantId,
    showArchived: bool("showArchived"),
    hideEmptyColumns: bool("hideEmptyColumns"),
    refreshSeconds: typeof refresh === "number" && refresh >= 5 && refresh <= 3600 ? Math.round(refresh) : DEFAULT_SETTINGS.refreshSeconds,
  };
}

/** Р-003: the server is reachable only via Tailscale / localhost — warn on anything else. */
export function serverUrlWarning(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Неверный адрес сервера";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Адрес должен начинаться с http:// или https://";
  const h = u.hostname;
  const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(h) || h.endsWith(".ts.net");
  if (h === "127.0.0.1" || h === "localhost" || tailscale) return null;
  return "Адрес не похож на Tailscale (100.64.0.0/10, *.ts.net) — доступ должен идти только через Tailscale";
}
