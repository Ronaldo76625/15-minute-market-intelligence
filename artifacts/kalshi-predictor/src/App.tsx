import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetKalshiDashboard,
  type KalshiEarlyObservation,
} from "@workspace/api-client-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  Languages,
  Moon,
  RefreshCw,
  Search,
  Sun,
  TrendingUp,
  Wifi,
  X,
} from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import {
  localizedMarketTitle,
  preferredLanguage,
  translations,
  type Language,
} from "@/i18n";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const chartColors = {
  teal: "#167f83",
  yellow: "#e8ad3a",
  green: "#3c8f70",
  coral: "#c85d4b",
  ink: "#1d2935",
};
const intervals = [
  { key: "every1" as const, ms: 60 * 1000 },
  { key: "every3" as const, ms: 3 * 60 * 1000 },
  { key: "every5" as const, ms: 5 * 60 * 1000 },
  { key: "every15" as const, ms: 15 * 60 * 1000 },
  { key: "everyHour" as const, ms: 60 * 60 * 1000 },
  { key: "every24" as const, ms: 24 * 60 * 60 * 1000 },
];

function formatPercent(value?: number) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}

function formatPrice(value?: number) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}¢` : "—";
}

function recommendationLabel(value: string | undefined, language: Language) {
  const copy = translations[language];
  if (value === "favorable") return copy.favorable;
  if (value === "wait") return copy.wait;
  return copy.avoid;
}

function recommendationClass(value?: string) {
  if (value === "favorable") return "bg-accent/10 text-accent";
  if (value === "wait") return "bg-primary/10 text-primary";
  return "bg-destructive/10 text-destructive";
}

function formatTime(value: string, language: Language) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(language === "es" ? "es-MX" : "en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
}

function qualificationLabel(value: string, language: Language) {
  const copy = translations[language];
  if (value === "ready") return copy.readySignal;
  if (value === "stale_candles") return copy.staleCandles;
  if (value === "insufficient_history") return copy.insufficientHistory;
  if (value === "wide_spread") return copy.wideSpread;
  return copy.outsideWindow;
}

function EarlyReadingCell({
  observation,
  pendingText,
  language,
}: {
  observation?: KalshiEarlyObservation;
  pendingText: string;
  language: Language;
}) {
  const copy = translations[language];
  if (!observation) {
    return (
      <div className="max-w-[250px] text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1">
          <RefreshCw size={11} /> {pendingText}
        </span>
      </div>
    );
  }
  return (
    <div className="min-w-[205px]">
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-2 py-1 font-mono text-[10px] font-bold ${
            observation.side === "YES"
              ? "bg-accent/10 text-accent"
              : "bg-primary/10 text-primary"
          }`}
        >
          {observation.confidence <= 50.5
            ? copy.uncertainDirection
            : observation.side === "YES"
              ? copy.yesOutcome
              : copy.noOutcome}
        </span>
        <strong className="font-mono text-sm">
          {formatPercent(observation.confidence)}
        </strong>
      </div>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground">
        YES {formatPercent(observation.yesProbability)} · NO{" "}
        {formatPercent(observation.noProbability)}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {copy.recordedAt(formatTime(observation.observedAt, language))}
      </p>
      <p className="mt-1 max-w-[250px] text-[10px] leading-relaxed text-muted-foreground">
        {copy.earlyEvidence(
          formatPercent(observation.horizonHitRate),
          formatPercent(observation.horizonHitRateLowerBound),
          observation.horizonSampleSize,
        )}
      </p>
      {!observation.isQualified ? (
        <p className="mt-1 text-[10px] font-semibold text-destructive">
          {qualificationLabel(observation.qualificationReason, language)}
        </p>
      ) : null}
    </div>
  );
}

function MarketCloseTime({
  closeTime,
  language,
}: {
  closeTime: string;
  language: Language;
}) {
  const [now, setNow] = useState(() => Date.now());
  const copy = translations[language];
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(
    0,
    Math.floor((Date.parse(closeTime) - now) / 1_000),
  );
  const minutes = Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  return (
    <div>
      <p className="font-mono text-xs">
        {copy.closesIn(`${minutes}:${seconds}`)}
      </p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">
        {copy.localCloseTime(formatTime(closeTime, language))}
      </p>
    </div>
  );
}

function csvDownload(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const body = [
    keys.join(","),
    ...rows.map((row) =>
      keys
        .map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`)
        .join(","),
    ),
  ].join("\n");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid={`button-${label.toLowerCase().replaceAll(" ", "-")}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-accent hover:text-accent disabled:opacity-45 print-hidden"
    >
      {children}
    </button>
  );
}

function ExportButton({
  filename,
  rows,
  label,
}: {
  filename: string;
  rows: Array<Record<string, unknown>>;
  label: string;
}) {
  return (
    <IconButton
      label={label}
      onClick={() => csvDownload(filename, rows)}
      disabled={!rows.length}
    >
      <Download size={15} />
    </IconButton>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-muted-foreground">
      <BarChart3 size={26} strokeWidth={1.5} />
      <span className="text-sm">{text}</span>
    </div>
  );
}

function Panel({
  title,
  eyebrow,
  children,
  actions,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="data-card overflow-hidden rounded-xl">
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
            {eyebrow}
          </p>
          <h2 className="mt-1 font-semibold tracking-tight">{title}</h2>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Home() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = useState<Language>(preferredLanguage);
  const [themePreference, setThemePreference] = useState<
    "system" | "light" | "dark"
  >(() => {
    try {
      const saved = localStorage.getItem("kalshi-theme-preference-v2");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [category, setCategory] = useState("");
  const [minConfidence, setMinConfidence] = useState(50);
  const [limit, setLimit] = useState(8);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalMs, setIntervalMs] = useState(intervals[0].ms);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"volume" | "yesPrice" | "closeTime">(
    "volume",
  );
  const [sortDesc, setSortDesc] = useState(true);
  const refreshRef = useRef<HTMLDivElement>(null);
  const copy = translations[language];
  const locale = language === "es" ? "es-MX" : "en-US";
  const isDark =
    themePreference === "system" ? systemDark : themePreference === "dark";
  const dashboardQuery = useGetKalshiDashboard({
    category: category || undefined,
    minConfidence,
    limit,
  });
  const dashboard = dashboardQuery.data;
  const loading = dashboardQuery.isLoading || dashboardQuery.isFetching;
  const marketRows = useMemo(() => {
    const base = dashboard?.markets ?? [];
    return base
      .filter((market) =>
        `${market.ticker} ${market.title} ${market.category}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
      .sort((a, b) => {
        const left = a[sortKey];
        const right = b[sortKey];
        const result =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return sortDesc ? -result : result;
      });
  }, [dashboard?.markets, search, sortDesc, sortKey]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    try {
      localStorage.removeItem("kalshi-theme");
      if (themePreference === "system")
        localStorage.removeItem("kalshi-theme-preference-v2");
      else localStorage.setItem("kalshi-theme-preference-v2", themePreference);
    } catch {}
  }, [isDark, themePreference]);

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

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: dashboardQuery.queryKey });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh, dashboardQuery.queryKey, intervalMs, queryClient]);

  useEffect(() => {
    const onOutside = (event: MouseEvent) => {
      if (
        refreshRef.current &&
        !refreshRef.current.contains(event.target as Node)
      )
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: dashboardQuery.queryKey });
  };

  const lastRefresh = dashboardQuery.dataUpdatedAt
    ? new Date(dashboardQuery.dataUpdatedAt).toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
  const categories = Array.from(
    new Set((dashboard?.markets ?? []).map((market) => market.category)),
  ).filter(Boolean);
  const chartPriceRows = (dashboard?.priceHistory ?? []).map((point) => ({
    time: point.time,
    yesPrice: point.yesPrice,
    volume: point.volume,
  }));
  const chartPerformanceRows = (dashboard?.performance ?? []).map((point) => {
    const parsedLabel = new Date(point.label);
    return {
      label: Number.isNaN(parsedLabel.getTime())
        ? point.label
        : parsedLabel.toLocaleString(locale, {
            month: "short",
            day: "numeric",
            hour: "numeric",
          }),
      cumulativeReturn: point.cumulativeReturn,
      hitRate: point.hitRate,
      trades: point.trades,
    };
  });

  if (dashboardQuery.isError) {
    return (
      <main className="dashboard-grid min-h-[100dvh] px-5 py-8">
        <div className="mx-auto max-w-[1400px]">
          <div className="data-card flex min-h-[340px] flex-col items-center justify-center rounded-xl text-center">
            <CircleAlert className="mb-4 text-destructive" size={32} />
            <h1 className="text-xl font-semibold">{copy.feedUnavailable}</h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {copy.feedUnavailableBody}
            </p>
            <button
              data-testid="button-retry-dashboard"
              onClick={handleRefresh}
              className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {copy.retry}
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="dashboard-grid min-h-[100dvh] px-4 py-5 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1480px]">
        <header className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <TrendingUp size={19} />
              </div>
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                {copy.appName}
              </span>
            </div>
            <h1 className="max-w-3xl text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
              {copy.headline}
              <span className="text-primary">.</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {copy.description}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                data-testid="status-source"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${dashboard?.isLive ? "bg-accent" : "bg-primary"}`}
                />
                {dashboard?.isLive ? copy.realData : copy.snapshotSource}
              </span>
              <span className="rounded-full border border-border bg-card px-2.5 py-1 font-mono">
                {dashboard
                  ? `${copy.realData} · ${dashboard.modelName}`
                  : copy.kalshiFeed}{" "}
                · {copy.asOf}{" "}
                {dashboard?.asOf ? formatTime(dashboard.asOf, language) : "—"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                {copy.updated} {lastRefresh}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 print-hidden">
            <div
              ref={refreshRef}
              className="relative flex h-9 items-center overflow-visible rounded-md border border-border bg-card"
            >
              <button
                data-testid="button-refresh-dashboard"
                onClick={handleRefresh}
                className="flex h-full items-center gap-2 px-3 text-xs font-semibold transition hover:text-accent"
              >
                <RefreshCw
                  size={14}
                  className={dashboardQuery.isFetching ? "animate-spin" : ""}
                />
                {copy.refresh}
              </button>
              <div className="h-5 w-px bg-border" />
              <button
                data-testid="button-refresh-options"
                aria-label={copy.refreshOptions}
                onClick={() => setMenuOpen((open) => !open)}
                className="flex h-full items-center px-2 text-muted-foreground transition hover:text-accent"
              >
                <ChevronDown size={14} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-11 z-20 w-56 rounded-lg border border-border bg-popover p-2 shadow-xl">
                  <label className="flex cursor-pointer items-center justify-between rounded-md px-2 py-2 text-xs hover:bg-muted">
                    <span>{copy.autoRefresh}</span>
                    <input
                      data-testid="input-auto-refresh"
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(event) => setAutoRefresh(event.target.checked)}
                      className="accent-[hsl(var(--primary))]"
                    />
                  </label>
                  <div className="my-1 border-t border-border" />
                  {intervals.map((option) => (
                    <button
                      data-testid={`button-${option.key}`}
                      key={option.ms}
                      onClick={() => {
                        setIntervalMs(option.ms);
                        setAutoRefresh(true);
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs hover:bg-muted"
                    >
                      <span>{copy[option.key]}</span>
                      {intervalMs === option.ms && autoRefresh ? (
                        <Check size={14} className="text-accent" />
                      ) : null}
                    </button>
                  ))}
                  <p className="px-2 pb-1 pt-2 text-[10px] leading-4 text-muted-foreground">
                    {copy.pollingNote}
                  </p>
                </div>
              )}
            </div>
            <IconButton label={copy.print} onClick={() => window.print()}>
              <FileText size={15} />
            </IconButton>
            <IconButton
              label={copy.toggleLanguage}
              onClick={() =>
                setLanguage((current) => (current === "en" ? "es" : "en"))
              }
            >
              <span className="flex items-center gap-0.5">
                <Languages size={14} />
                <small className="font-mono text-[8px] font-bold">
                  {language.toUpperCase()}
                </small>
              </span>
            </IconButton>
            <IconButton
              label={isDark ? copy.toggleLight : copy.toggleDark}
              onClick={() => setThemePreference(isDark ? "light" : "dark")}
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
            </IconButton>
          </div>
        </header>

        {dashboard ? (
          <div
            data-testid="data-freshness-banner"
            className={`mb-6 flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
              dashboard.dataFreshness === "live"
                ? "border-accent/30 bg-accent/8"
                : dashboard.dataFreshness === "delayed"
                  ? "border-primary/35 bg-primary/8"
                  : "border-destructive/35 bg-destructive/8"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              <span
                className={`h-2 w-2 rounded-full ${
                  dashboard.dataFreshness === "live"
                    ? "bg-accent"
                    : dashboard.dataFreshness === "delayed"
                      ? "bg-primary"
                      : "bg-destructive"
                }`}
              />
              {dashboard.dataFreshness === "live"
                ? copy.liveData
                : dashboard.dataFreshness === "delayed"
                  ? copy.delayedData
                  : copy.staleData}
              <span className="font-mono text-[10px] font-normal text-muted-foreground">
                ·{" "}
                {copy.dataAge(
                  Math.max(0, Math.floor(dashboard.dataAgeSeconds / 60)),
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {dashboard.dataFreshness === "live"
                ? copy.liveDataBody
                : dashboard.dataFreshness === "delayed"
                  ? copy.delayedDataBody
                  : copy.staleDataBody}
            </p>
          </div>
        ) : null}

        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              label: copy.marketsScanned,
              value: dashboard?.totalMarkets.toLocaleString(locale) ?? "—",
              note: copy.currentUniverse,
              color: "text-accent",
            },
            {
              label: copy.activePredictions,
              value: dashboard?.activeSignals.toLocaleString(locale) ?? "—",
              note: copy.aboveFilter,
              color: "text-primary",
            },
            {
              label: copy.averageProbability,
              value: formatPercent(dashboard?.averageConfidence),
              note: copy.predictedSideProbability,
              color: "text-accent",
            },
            {
              label: copy.qualifiedHitRate,
              value: formatPercent(dashboard?.backtestHitRate),
              note: dashboard
                ? copy.qualifiedNote(
                    dashboard.backtestSampleSize,
                    formatPercent(dashboard.signalCoverage),
                  )
                : copy.chronologicalTest,
              color: "text-primary",
            },
          ].map((metric) => (
            <div
              data-testid={`metric-${metric.label.toLowerCase().replaceAll(" ", "-")}`}
              key={metric.label}
              className="data-card rounded-xl p-4"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                {metric.label}
              </p>
              {loading ? (
                <SkeletonBlock className="mt-3 h-8 w-28" />
              ) : (
                <p
                  className={`mt-2 text-2xl font-extrabold tracking-tight ${metric.color}`}
                >
                  {metric.value}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {metric.note}
              </p>
            </div>
          ))}
        </div>

        <div className="mb-6">
          <Panel title={copy.earlyTitle} eyebrow={copy.earlyEyebrow}>
            <div className="border-b border-border/70 px-5 py-3">
              <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">
                {copy.earlyBody}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border/70 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">
                      {copy.earlyMarket}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {copy.earlyMinute1}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {copy.earlyMinute2}
                    </th>
                    <th className="px-5 py-3 font-medium">
                      {copy.earlyDecision}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !dashboard?.earlyForecasts?.length ? (
                    Array.from({ length: 3 }).map((_, index) => (
                      <tr className="border-b border-border/70" key={index}>
                        <td className="px-5 py-5">
                          <SkeletonBlock className="h-10 w-44" />
                        </td>
                        <td className="px-4 py-5">
                          <SkeletonBlock className="h-16 w-52" />
                        </td>
                        <td className="px-4 py-5">
                          <SkeletonBlock className="h-16 w-52" />
                        </td>
                        <td className="px-5 py-5">
                          <SkeletonBlock className="h-12 w-44" />
                        </td>
                      </tr>
                    ))
                  ) : !dashboard?.earlyForecasts?.length ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-5 py-10 text-center text-sm text-muted-foreground"
                      >
                        {copy.noEarlyMarkets}
                      </td>
                    </tr>
                  ) : (
                    dashboard.earlyForecasts.map((forecast) => {
                      const finalReading =
                        forecast.confirmation ??
                        forecast.initial ??
                        forecast.current;
                      const agreementText =
                        forecast.agreement === "confirmed"
                          ? copy.confirmedReading
                          : forecast.agreement === "revised"
                            ? copy.revisedReading
                            : copy.pendingReading;
                      return (
                        <tr
                          key={forecast.ticker}
                          className="border-b border-border/70 align-top last:border-0"
                        >
                          <td className="px-5 py-5">
                            <strong className="text-sm">
                              {forecast.asset}
                            </strong>
                            <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">
                              {localizedMarketTitle(forecast.title, language)}
                            </p>
                            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                              {copy.previousClose}:{" "}
                              {forecast.previousResult === "YES"
                                ? copy.previousUp
                                : forecast.previousResult === "NO"
                                  ? copy.previousDown
                                  : copy.previousPending}
                            </p>
                          </td>
                          <td className="px-4 py-5">
                            <EarlyReadingCell
                              observation={forecast.initial}
                              pendingText={copy.collectingMinute1}
                              language={language}
                            />
                          </td>
                          <td className="px-4 py-5">
                            <EarlyReadingCell
                              observation={forecast.confirmation}
                              pendingText={
                                forecast.initial
                                  ? copy.collectingMinute2
                                  : copy.collectingMinute1
                              }
                              language={language}
                            />
                          </td>
                          <td className="px-5 py-5">
                            <span
                              className={`inline-flex rounded px-2 py-1 text-[10px] font-bold ${recommendationClass(forecast.recommendation)}`}
                            >
                              {recommendationLabel(
                                forecast.recommendation,
                                language,
                              )}
                            </span>
                            <div className="mt-2 flex items-center gap-2">
                              {forecast.agreement === "confirmed" ? (
                                <Check size={14} className="text-accent" />
                              ) : forecast.agreement === "revised" ? (
                                <X size={14} className="text-destructive" />
                              ) : (
                                <RefreshCw
                                  size={13}
                                  className="text-muted-foreground"
                                />
                              )}
                              <span className="text-xs font-semibold">
                                {agreementText}
                              </span>
                            </div>
                            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                              {finalReading.confidence <= 50.5
                                ? copy.uncertainDirection
                                : finalReading.side === "YES"
                                  ? copy.yesOutcome
                                  : copy.noOutcome}
                              {" · "}
                              {formatPercent(finalReading.confidence)}
                            </p>
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                              {copy.netEv}{" "}
                              {formatPercent(finalReading.netExpectedValue)}
                            </p>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border/70 px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
              {copy.earlySafetyNote}
            </p>
          </Panel>
        </div>

        <details className="data-card group mb-6 rounded-xl">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold">
            <span>{copy.advancedFilters}</span>
            <ChevronDown
              size={16}
              className="transition group-open:rotate-180"
            />
          </summary>
          <div className="flex flex-col gap-4 border-t border-border/70 p-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                {copy.predictionControls}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.controlsDescription}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="min-w-[170px]">
                <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {copy.category}
                </span>
                <select
                  data-testid="select-category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-accent"
                >
                  <option value="">{copy.allCategories}</option>
                  {categories.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-[170px]">
                <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {copy.minProbability}{" "}
                  <b className="text-foreground">{minConfidence}%</b>
                </span>
                <input
                  data-testid="input-min-confidence"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={minConfidence}
                  onChange={(event) =>
                    setMinConfidence(Number(event.target.value))
                  }
                  className="mt-2 h-2 w-full accent-[hsl(var(--accent))]"
                />
              </label>
              <label className="min-w-[150px]">
                <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {copy.signalLimit}
                </span>
                <select
                  data-testid="select-signal-limit"
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-accent"
                >
                  <option value="5">{copy.top} 5</option>
                  <option value="8">{copy.top} 8</option>
                  <option value="12">{copy.top} 12</option>
                  <option value="20">{copy.top} 20</option>
                </select>
              </label>
            </div>
          </div>
        </details>

        <div className="mb-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <Panel
            title={copy.livePredictions}
            eyebrow={copy.modelOutput}
            actions={
              <span className="font-mono text-[10px] text-muted-foreground">
                {dashboard?.signals?.length ?? 0} {copy.ranked}
              </span>
            }
          >
            <div className="divide-y divide-border/70">
              {!loading && dashboard?.filterFallbackActive ? (
                <div className="border-b border-primary/20 bg-primary/5 px-5 py-3 text-xs text-primary">
                  {copy.filterFallback}
                </div>
              ) : null}
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div className="p-5" key={index}>
                    <SkeletonBlock className="h-4 w-1/2" />
                    <SkeletonBlock className="mt-3 h-3 w-3/4" />
                  </div>
                ))
              ) : !dashboard?.signals?.length ? (
                <div className="p-12 text-center text-sm text-muted-foreground">
                  {copy.noSignals}
                </div>
              ) : (
                dashboard.signals.map((signal, index) => {
                  const assetReturn = dashboard.assetStats.find(
                    (asset) => asset.asset === signal.asset,
                  )?.netReturn;
                  return (
                    <article
                      data-testid={`signal-${signal.id}`}
                      key={signal.id}
                      className="group grid gap-3 p-4 transition hover:bg-muted/45 sm:grid-cols-[auto_1fr] sm:items-start"
                    >
                      <div className="flex items-center gap-3 sm:block">
                        <span className="font-mono text-xs text-muted-foreground">
                          0{index + 1}
                        </span>
                        <span
                          className={`mt-1 inline-flex rounded px-2 py-1 font-mono text-[10px] font-medium ${signal.side === "YES" ? "bg-accent/10 text-accent" : "bg-destructive/10 text-destructive"}`}
                        >
                          {signal.side}
                        </span>
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold">
                            {localizedMarketTitle(signal.title, language)}
                          </h3>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {signal.ticker}
                          </span>
                          <span
                            className={`rounded px-2 py-1 text-[10px] font-semibold ${recommendationClass(signal.recommendation)}`}
                          >
                            {recommendationLabel(
                              signal.recommendation,
                              language,
                            )}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="rounded-lg border border-accent/25 bg-accent/5 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                              {copy.yesOutcome}
                            </p>
                            <p className="mt-1 font-mono text-xl font-bold text-accent">
                              {formatPercent(signal.yesProbability)}
                            </p>
                          </div>
                          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-right">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
                              {copy.noOutcome}
                            </p>
                            <p className="mt-1 font-mono text-xl font-bold text-destructive">
                              {formatPercent(signal.noProbability)}
                            </p>
                          </div>
                        </div>
                        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted">
                          <span
                            className="bg-accent"
                            style={{ width: `${signal.yesProbability}%` }}
                          />
                          <span
                            className="bg-destructive/70"
                            style={{ width: `${signal.noProbability}%` }}
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px]">
                          <span
                            className={
                              signal.isQualified
                                ? "text-accent"
                                : "text-primary"
                            }
                          >
                            {signal.isQualified
                              ? copy.horizonEvidence(
                                  signal.horizonMinutes,
                                  formatPercent(signal.horizonHitRate),
                                  signal.horizonSampleSize,
                                )
                              : qualificationLabel(
                                  signal.qualificationReason,
                                  language,
                                )}
                          </span>
                          <span className="text-muted-foreground">
                            {copy.safetyAdjustment} · -
                            {formatPercent(signal.uncertaintyMargin)}
                          </span>
                        </div>
                        <details className="mt-3 rounded-md border border-border/70 bg-background/40 px-3 py-2">
                          <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                            {copy.showDetails}
                          </summary>
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">
                            {copy.signalExplanation(
                              dashboard.modelName,
                              formatPercent(signal.modelProbability),
                              signal.side,
                              formatPercent(signal.marketProbability),
                              signal.asset ?? "",
                              formatPercent(assetReturn),
                            )}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
                            <span>
                              {copy.model}{" "}
                              <b className="text-primary">
                                {formatPercent(signal.modelProbability)}
                              </b>
                            </span>
                            <span>
                              {copy.market}{" "}
                              <b className="text-foreground">
                                {formatPercent(signal.marketProbability)}
                              </b>
                            </span>
                            <span>
                              {copy.edge}{" "}
                              <b className="text-accent">
                                {formatPercent(signal.edge)}
                              </b>
                            </span>
                            <span>
                              {copy.netEv}{" "}
                              <b className="text-foreground">
                                {formatPercent(signal.netExpectedValue)}
                              </b>
                            </span>
                            <span>
                              {copy.fee}{" "}
                              <b className="text-foreground">
                                {formatPrice(signal.estimatedFee)}
                              </b>
                            </span>
                            <span>
                              {copy.closes} {signal.timeToClose}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
                            <span>
                              {copy.rawProbability} YES{" "}
                              <b className="text-foreground">
                                {formatPercent(signal.rawYesProbability)}
                              </b>
                            </span>
                            <span>
                              {copy.safetyAdjustment}{" "}
                              <b className="text-foreground">
                                {formatPercent(signal.uncertaintyMargin)}
                              </b>
                            </span>
                            <span>
                              {copy.market} YES{" "}
                              <b className="text-foreground">
                                {formatPercent(signal.marketYesProbability)}
                              </b>
                            </span>
                          </div>
                        </details>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </Panel>
          <Panel
            title={copy.activeContract}
            eyebrow={copy.candlesEyebrow}
            actions={
              <ExportButton
                filename="yes-price-history.csv"
                rows={chartPriceRows}
                label={copy.exportChart}
              />
            }
          >
            <div className="p-4">
              {loading ? (
                <SkeletonBlock className="h-[260px] w-full" />
              ) : !chartPriceRows.length ? (
                <EmptyChart text={copy.noPriceHistory} />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart
                    data={chartPriceRows}
                    margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="yesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor={chartColors.teal}
                          stopOpacity={0.32}
                        />
                        <stop
                          offset="100%"
                          stopColor={chartColors.teal}
                          stopOpacity={0.02}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      stroke="hsl(var(--border))"
                      strokeDasharray="2 4"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="time"
                      tickFormatter={(value) => formatTime(value, language)}
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={26}
                    />
                    <YAxis
                      domain={[0, 1]}
                      tickFormatter={(value) => `${Math.round(value * 100)}¢`}
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value: number) => [formatPrice(value), "YES"]}
                      labelFormatter={(value) => formatTime(value, language)}
                    />
                    <Area
                      type="monotone"
                      dataKey="yesPrice"
                      stroke={chartColors.teal}
                      strokeWidth={2.5}
                      fill="url(#yesFill)"
                      dot={false}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3 text-xs">
                <span className="text-muted-foreground">{copy.latestYes}</span>
                <strong data-testid="text-latest-yes-price">
                  {formatPrice(chartPriceRows.at(-1)?.yesPrice)}
                </strong>
              </div>
            </div>
          </Panel>
        </div>

        <div className="mb-6">
          <Panel
            title={copy.profitability}
            eyebrow={copy.decisionSupport}
            actions={
              <span className="font-mono text-[10px] text-muted-foreground">
                {copy.historicalCurrent}
              </span>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border/70 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.asset}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.historicalNet}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.hitRate}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.maxDrawdown}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.avgPnl}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.currentPrediction}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.netEv}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.modelView}
                    </th>
                    <th className="px-4 py-3 font-mono font-medium">
                      {copy.forwardRecord}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {loading
                    ? Array.from({ length: 7 }).map((_, index) => (
                        <tr key={index}>
                          {Array.from({ length: 9 }).map((__, cell) => (
                            <td className="px-4 py-3" key={cell}>
                              <SkeletonBlock className="h-4 w-16" />
                            </td>
                          ))}
                        </tr>
                      ))
                    : (dashboard?.assetStats ?? []).map((asset) => (
                        <tr
                          data-testid={`row-profitability-${asset.asset}`}
                          key={asset.asset}
                          className="transition hover:bg-muted/45"
                        >
                          <td className="px-4 py-3">
                            <p className="text-sm font-bold">{asset.asset}</p>
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {asset.seriesTicker}
                            </p>
                          </td>
                          <td
                            className={`px-4 py-3 font-mono text-sm font-semibold ${asset.netReturn > 0 ? "text-accent" : "text-destructive"}`}
                          >
                            {formatPercent(asset.netReturn)}
                            <p className="mt-0.5 text-[9px] font-normal text-muted-foreground">
                              {copy.unseenSignals(asset.sampleSize)}
                            </p>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {formatPercent(asset.hitRate)}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-destructive">
                            {formatPercent(asset.maxDrawdown)}
                          </td>
                          <td
                            className={`px-4 py-3 font-mono text-xs ${asset.averageNetProfitCents >= 0 ? "text-accent" : "text-destructive"}`}
                          >
                            {asset.averageNetProfitCents.toFixed(2)}¢
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {asset.currentSide
                              ? `${asset.currentSide} · ${formatPercent(asset.currentProbability)}`
                              : copy.noOpenMarket}
                          </td>
                          <td
                            className={`px-4 py-3 font-mono text-xs ${(asset.currentNetExpectedValue ?? 0) > 0 ? "text-accent" : "text-destructive"}`}
                          >
                            {formatPercent(asset.currentNetExpectedValue)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded px-2 py-1 text-[10px] font-semibold ${recommendationClass(asset.recommendation)}`}
                            >
                              {recommendationLabel(
                                asset.recommendation,
                                language,
                              )}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {asset.forwardResolved}/{asset.forwardTracked}
                            <p className="mt-0.5 text-[9px] text-muted-foreground">
                              {asset.forwardResolved
                                ? `${formatPercent(asset.forwardNetReturn)} ${copy.estimatedReturn}`
                                : copy.collecting}
                            </p>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            <footer className="border-t border-border/70 px-4 py-3 text-xs leading-5 text-muted-foreground">
              {copy.favorableMeaning}
            </footer>
          </Panel>
        </div>

        <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_0.7fr]">
          <Panel
            title={copy.chronologicalHoldout}
            eyebrow={copy.unseenTest}
            actions={
              <ExportButton
                filename="model-performance.csv"
                rows={chartPerformanceRows}
                label={copy.exportChart}
              />
            }
          >
            <div className="p-4">
              {loading ? (
                <SkeletonBlock className="h-[260px] w-full" />
              ) : !chartPerformanceRows.length ? (
                <EmptyChart text={copy.noEvaluation} />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart
                    data={chartPerformanceRows}
                    margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke="hsl(var(--border))"
                      strokeDasharray="2 4"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="label"
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      yAxisId="return"
                      tickFormatter={(value) => `${value}%`}
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      yAxisId="hit"
                      orientation="right"
                      domain={[0, 100]}
                      tickFormatter={(value) => `${value}%`}
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Line
                      yAxisId="return"
                      type="monotone"
                      dataKey="cumulativeReturn"
                      name={copy.estimatedNetReturn}
                      stroke={chartColors.yellow}
                      strokeWidth={2.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="hit"
                      type="monotone"
                      dataKey="hitRate"
                      name={copy.hitRate}
                      stroke={chartColors.teal}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
              <div className="mt-3 flex flex-wrap gap-5 border-t border-border/70 pt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <i className="h-2 w-2 rounded-full bg-primary" />
                  {copy.estimatedNetReturn}
                </span>
                <span className="flex items-center gap-2">
                  <i className="h-2 w-2 rounded-full bg-accent" />
                  {copy.hitRate}
                </span>
                <span>
                  {copy.marketBaseline}{" "}
                  {formatPercent(dashboard?.baselineHitRate)}
                </span>
                <span>
                  {copy.confidenceFloor}{" "}
                  {formatPercent(dashboard?.hitRateLowerBound)}
                </span>
                <span>
                  {copy.coverage} {formatPercent(dashboard?.signalCoverage)}
                </span>
                <span>Brier {dashboard?.brierScore?.toFixed(4) ?? "—"}</span>
                <span className="ml-auto italic">{copy.fiveMinutes}</span>
              </div>
            </div>
          </Panel>
          <Panel title={copy.dataStatus} eyebrow={copy.context}>
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-1">
              <div className="bg-card p-5">
                <p className="text-xs text-muted-foreground">
                  {copy.estimatedPaperReturn}
                </p>
                <p
                  data-testid="text-simulated-return"
                  className={`mt-1 text-3xl font-extrabold ${(dashboard?.netSimulatedReturn ?? 0) >= 0 ? "text-accent" : "text-destructive"}`}
                >
                  {formatPercent(dashboard?.netSimulatedReturn)}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {copy.paperReturnBody}
                </p>
              </div>
              <div className="bg-card p-5">
                <p className="text-xs text-muted-foreground">
                  {copy.forwardRecord}
                </p>
                <p className="mt-1 text-2xl font-extrabold">
                  {dashboard?.liveTracking.resolved ?? 0} {copy.resolved}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    / {dashboard?.liveTracking.tracked ?? 0} {copy.tracked}
                  </span>
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {dashboard?.liveTracking.resolved
                    ? `${formatPercent(dashboard.liveTracking.hitRate)} ${copy.hitRate.toLowerCase()} · ${formatPercent(dashboard.liveTracking.netReturn)} ${copy.estimatedReturn}.`
                    : copy.recordingBody}
                </p>
              </div>
              <div className="bg-card p-5">
                <p className="text-xs text-muted-foreground">
                  {copy.qualityTitle}
                </p>
                <p className="mt-2 text-xs leading-5 font-semibold">
                  {dashboard
                    ? copy.qualityBody(
                        formatPercent(dashboard.expectedCalibrationError),
                        formatPercent(dashboard.brierSkillScore),
                        dashboard.logLoss.toFixed(4),
                        formatPercent(dashboard.confidenceThreshold),
                      )
                    : "—"}
                </p>
              </div>
              <div className="bg-card p-5">
                <p className="text-xs text-muted-foreground">
                  {copy.modelStatus}
                </p>
                <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
                  <Wifi
                    size={15}
                    className={
                      dashboard?.isLive ? "text-accent" : "text-primary"
                    }
                  />
                  {dashboard?.isLive ? copy.connected : copy.cached}
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {dashboard
                    ? `${dashboard.modelName} · ${copy.trainedOn} ${dashboard.trainingMarkets.toLocaleString(locale)}, ${copy.calibratedOn} ${dashboard.calibrationMarkets.toLocaleString(locale)} ${copy.and} ${copy.evaluatedOn} ${dashboard.evaluationMarkets.toLocaleString(locale)} ${copy.marketsWord} · ${formatTime(dashboard.modelTrainedAt, language)}`
                    : copy.trainingModel}
                </p>
              </div>
            </div>
          </Panel>
        </div>

        <Panel
          title={copy.marketUniverse}
          eyebrow={copy.universeEyebrow}
          actions={
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                data-testid="input-market-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={copy.searchMarkets}
                aria-label={copy.searchMarkets}
                className="h-9 w-48 rounded-md border border-input bg-background pl-8 pr-3 text-xs outline-none focus:border-accent sm:w-64"
              />
              {search && (
                <button
                  data-testid="button-clear-search"
                  aria-label={copy.searchMarkets}
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border/70 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {[
                    ["ticker", copy.marketColumn],
                    ["category", copy.category],
                    ["closeTime", copy.closesColumn],
                    ["volume", copy.volume],
                    ["yesPrice", copy.yesPriceColumn],
                    ["noPrice", copy.noPriceColumn],
                    ["liquidity", copy.liquidity],
                  ].map(([key, label]) => (
                    <th key={key} className="px-5 py-3 font-mono font-medium">
                      <button
                        data-testid={`button-sort-${key}`}
                        onClick={() => {
                          if (sortKey === key) setSortDesc((desc) => !desc);
                          else {
                            setSortKey(key as typeof sortKey);
                            setSortDesc(true);
                          }
                        }}
                        className="inline-flex items-center gap-1 hover:text-accent"
                      >
                        {label}
                        {sortKey === key ? (
                          sortDesc ? (
                            <ArrowDown size={12} />
                          ) : (
                            <ArrowUp size={12} />
                          )
                        ) : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {dashboardQuery.isLoading && !dashboard?.markets?.length ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index}>
                      {Array.from({ length: 7 }).map((__, cell) => (
                        <td className="px-5 py-4" key={cell}>
                          <SkeletonBlock className="h-4 w-20" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : marketRows.length ? (
                  marketRows.map((market) => (
                    <tr
                      data-testid={`row-market-${market.ticker}`}
                      key={market.ticker}
                      className="transition hover:bg-muted/45"
                    >
                      <td className="px-5 py-3.5">
                        <p className="text-sm font-semibold">
                          {localizedMarketTitle(market.title, language)}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {market.ticker}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        {market.category}
                      </td>
                      <td className="px-5 py-3.5">
                        <MarketCloseTime
                          closeTime={market.closeTime}
                          language={language}
                        />
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs">
                        {market.volume.toLocaleString(locale)}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-sm text-accent">
                        {formatPrice(market.yesPrice)}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-sm text-muted-foreground">
                        {formatPrice(market.noPrice)}
                      </td>
                      <td className="px-5 py-3.5 text-sm">
                        {market.liquidity}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={7}
                      className="h-36 text-center text-sm text-muted-foreground"
                    >
                      {copy.noSearchMatches}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="flex flex-col gap-2 border-t border-border/70 px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              {marketRows.length} {copy.marketsShown}
              {dashboardQuery.isFetching ? ` · ${copy.updating}` : ""}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {copy.pricesNote}
            </span>
          </footer>
        </Panel>
        <footer className="flex flex-col gap-2 py-7 text-[11px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{copy.footerLeft}</span>
          <span>{copy.disclaimer}</span>
        </footer>
      </div>
    </main>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
