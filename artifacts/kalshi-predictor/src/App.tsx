import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Languages,
  Palette,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { preferredLanguage, type Language } from "@/i18n";

type Direction = {
  ticker: string;
  asset: string;
  side: "YES" | "NO";
};

type DirectionFeed = {
  asOf: string;
  directions: Direction[];
};

const refreshIntervalMs = 30_000;

function App() {
  const [language, setLanguage] = useState<Language>(preferredLanguage);
  const [themePreference, setThemePreference] = useState<
    "system" | "light" | "dark" | "image"
  >(() => {
    try {
      const saved = localStorage.getItem("kalshi-theme-preference-v2");
      return saved === "light" || saved === "dark" || saved === "image"
        ? saved
        : "system";
    } catch {
      return "system";
    }
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [feed, setFeed] = useState<DirectionFeed>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const isImageTheme = themePreference === "image";
  const isDark =
    themePreference === "system"
      ? systemDark
      : themePreference === "dark" || isImageTheme;
  const copy =
    language === "es"
      ? {
          appName: "KALSHI / PREDICTOR",
          headline: "Dirección del mercado a 15 minutos",
          description:
            "Lectura directa de los contratos cripto activos de Kalshi.",
          live: "Monedas en tiempo real",
          updated: "Actualizado",
          refresh: "Actualizar",
          loading: "Consultando los contratos activos…",
          error: "No pudimos cargar las monedas. Inténtalo de nuevo.",
          up: "SUBE",
          down: "NO SUBE",
          theme: "Elegir apariencia",
          light: "Claro",
          dark: "Oscuro",
          image: "Imagen",
          language: "Switch to English",
        }
      : {
          appName: "KALSHI / PREDICTOR",
          headline: "15-minute market direction",
          description: "Direct reading of Kalshi's active crypto contracts.",
          live: "Live currencies",
          updated: "Updated",
          refresh: "Refresh",
          loading: "Loading active contracts…",
          error: "We could not load the currencies. Try again.",
          up: "GOES UP",
          down: "DOES NOT GO UP",
          theme: "Choose appearance",
          light: "Light",
          dark: "Dark",
          image: "Image",
          language: "Cambiar a español",
        };

  const loadDirections = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/kalshi/directions", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextFeed = (await response.json()) as DirectionFeed;
      if (!Array.isArray(nextFeed.directions)) throw new Error("Invalid feed");
      setFeed(nextFeed);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDirections();
    const timer = window.setInterval(
      () => void loadDirections(),
      refreshIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [loadDirections]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("image-theme", isImageTheme);
    try {
      if (themePreference === "system") {
        localStorage.removeItem("kalshi-theme-preference-v2");
      } else {
        localStorage.setItem("kalshi-theme-preference-v2", themePreference);
      }
    } catch {}
  }, [isDark, isImageTheme, themePreference]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem("kalshi-language", language);
    } catch {}
  }, [language]);

  const updatedAt = feed?.asOf
    ? new Date(feed.asOf).toLocaleTimeString(
        language === "es" ? "es-MX" : "en-US",
        { hour: "numeric", minute: "2-digit", second: "2-digit" },
      )
    : "—";

  return (
    <main className="dashboard-grid min-h-[100dvh] px-4 py-5 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <TrendingUp size={20} />
              </div>
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                {copy.appName}
              </span>
            </div>
            <h1 className="max-w-3xl text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
              {copy.headline}
              <span className="text-primary">.</span>
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {copy.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={copy.refresh}
              onClick={() => void loadDirections()}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-semibold transition hover:border-accent hover:text-accent"
            >
              <RefreshCw
                size={15}
                className={refreshing ? "animate-spin" : ""}
              />
              {copy.refresh}
            </button>
            <button
              type="button"
              aria-label={copy.language}
              title={copy.language}
              onClick={() =>
                setLanguage((current) => (current === "es" ? "en" : "es"))
              }
              className="inline-flex h-10 items-center gap-1 rounded-md border border-border bg-card px-3 text-xs font-semibold transition hover:border-accent hover:text-accent"
            >
              <Languages size={15} /> {language.toUpperCase()}
            </button>
            <label
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground"
              title={copy.theme}
            >
              <Palette size={15} aria-hidden="true" />
              <span className="sr-only">{copy.theme}</span>
              <select
                aria-label={copy.theme}
                value={
                  themePreference === "system"
                    ? systemDark
                      ? "dark"
                      : "light"
                    : themePreference
                }
                onChange={(event) =>
                  setThemePreference(
                    event.target.value as "light" | "dark" | "image",
                  )
                }
                className="cursor-pointer bg-transparent text-xs font-semibold text-foreground outline-none"
              >
                <option value="light">{copy.light}</option>
                <option value="dark">{copy.dark}</option>
                <option value="image">{copy.image}</option>
              </select>
            </label>
          </div>
        </header>

        <section className="data-card overflow-hidden rounded-2xl">
          <header className="flex flex-col gap-2 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 font-semibold">
              <span className="h-2 w-2 rounded-full bg-accent" />
              {copy.live}
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {copy.updated} {updatedAt}
            </span>
          </header>

          {loading ? (
            <div className="px-5 py-16 text-center text-sm text-muted-foreground">
              {copy.loading}
            </div>
          ) : error && !feed?.directions.length ? (
            <div className="px-5 py-16 text-center">
              <p className="text-sm text-destructive">{copy.error}</p>
              <button
                type="button"
                onClick={() => void loadDirections()}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {copy.refresh}
              </button>
            </div>
          ) : (
            <div className="grid gap-px bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
              {feed?.directions.map((direction) => {
                const goesUp = direction.side === "YES";
                return (
                  <article
                    key={direction.ticker}
                    data-testid={`direction-${direction.asset}`}
                    className="flex min-h-40 flex-col items-center justify-center bg-card/95 p-6 text-center backdrop-blur-sm"
                  >
                    <strong className="font-mono text-xl tracking-[0.18em]">
                      {direction.asset}
                    </strong>
                    <div
                      className={`mt-4 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-lg font-extrabold ${
                        goesUp
                          ? "bg-accent/12 text-accent"
                          : "bg-destructive/12 text-destructive"
                      }`}
                    >
                      {goesUp ? (
                        <ArrowUpRight size={24} strokeWidth={2.5} />
                      ) : (
                        <ArrowDownRight size={24} strokeWidth={2.5} />
                      )}
                      {goesUp ? copy.up : copy.down}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
