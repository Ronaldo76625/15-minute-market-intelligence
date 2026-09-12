import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useGetKalshiDashboard } from '@workspace/api-client-react';
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
} from 'recharts';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  Moon,
  RefreshCw,
  Search,
  Sun,
  TrendingUp,
  Wifi,
  X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const chartColors = { teal: '#167f83', yellow: '#e8ad3a', green: '#3c8f70', coral: '#c85d4b', ink: '#1d2935' };
const intervals = [
  { label: 'Every 3 min', ms: 3 * 60 * 1000 },
  { label: 'Every 5 min', ms: 5 * 60 * 1000 },
  { label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 24 hours', ms: 24 * 60 * 60 * 1000 },
];

function formatPercent(value?: number) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '—';
}

function formatPrice(value?: number) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}¢` : '—';
}

function recommendationLabel(value?: string) {
  if (value === 'favorable') return 'Favorable setup';
  if (value === 'wait') return 'Wait / monitor';
  return 'No edge at this price';
}

function recommendationClass(value?: string) {
  if (value === 'favorable') return 'bg-accent/10 text-accent';
  if (value === 'wait') return 'bg-primary/10 text-primary';
  return 'bg-destructive/10 text-destructive';
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function csvDownload(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const body = [keys.join(','), ...rows.map((row) => keys.map((key) => `"${String(row[key] ?? '').replaceAll('"', '""')}"`).join(','))].join('\n');
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function IconButton({ label, onClick, children, disabled = false }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button data-testid={`button-${label.toLowerCase().replaceAll(' ', '-')}`} aria-label={label} title={label} onClick={onClick} disabled={disabled} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-accent hover:text-accent disabled:opacity-45 print-hidden">{children}</button>;
}

function ExportButton({ filename, rows, label = 'Export chart data' }: { filename: string; rows: Array<Record<string, unknown>>; label?: string }) {
  return <IconButton label={label} onClick={() => csvDownload(filename, rows)} disabled={!rows.length}><Download size={15} /></IconButton>;
}

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function EmptyChart({ text }: { text: string }) {
  return <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-muted-foreground"><BarChart3 size={26} strokeWidth={1.5} /><span className="text-sm">{text}</span></div>;
}

function Panel({ title, eyebrow, children, actions }: { title: string; eyebrow?: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="data-card overflow-hidden rounded-xl">
    <header className="flex items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">{eyebrow}</p><h2 className="mt-1 font-semibold tracking-tight">{title}</h2></div>
      {actions}
    </header>
    {children}
  </section>;
}

function Home() {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState('');
  const [minConfidence, setMinConfidence] = useState(60);
  const [limit, setLimit] = useState(8);
  const [isDark, setIsDark] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalMs, setIntervalMs] = useState(intervals[0].ms);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'volume' | 'yesPrice' | 'closeTime'>('volume');
  const [sortDesc, setSortDesc] = useState(true);
  const refreshRef = useRef<HTMLDivElement>(null);
  const dashboardQuery = useGetKalshiDashboard({ category: category || undefined, minConfidence, limit });
  const dashboard = dashboardQuery.data;
  const loading = dashboardQuery.isLoading || dashboardQuery.isFetching;
  const marketRows = useMemo(() => {
    const base = dashboard?.markets ?? [];
    return base
      .filter((market) => `${market.ticker} ${market.title} ${market.category}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => {
        const left = a[sortKey];
        const right = b[sortKey];
        const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
        return sortDesc ? -result : result;
      });
  }, [dashboard?.markets, search, sortDesc, sortKey]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('kalshi-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const saved = localStorage.getItem('kalshi-theme');
    if (saved === 'dark') setIsDark(true);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: dashboardQuery.queryKey });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh, dashboardQuery.queryKey, intervalMs, queryClient]);

  useEffect(() => {
    const onOutside = (event: MouseEvent) => { if (refreshRef.current && !refreshRef.current.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: dashboardQuery.queryKey });
  };

  const lastRefresh = dashboardQuery.dataUpdatedAt ? new Date(dashboardQuery.dataUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  const categories = Array.from(new Set((dashboard?.markets ?? []).map((market) => market.category))).filter(Boolean);
  const chartPriceRows = (dashboard?.priceHistory ?? []).map((point) => ({ time: point.time, yesPrice: point.yesPrice, volume: point.volume }));
  const chartPerformanceRows = (dashboard?.performance ?? []).map((point) => ({ label: point.label, cumulativeReturn: point.cumulativeReturn, hitRate: point.hitRate, trades: point.trades }));

  if (dashboardQuery.isError) {
    return <main className="dashboard-grid min-h-[100dvh] px-5 py-8"><div className="mx-auto max-w-[1400px]"><div className="data-card flex min-h-[340px] flex-col items-center justify-center rounded-xl text-center"><CircleAlert className="mb-4 text-destructive" size={32} /><h1 className="text-xl font-semibold">The signal feed is unavailable</h1><p className="mt-2 max-w-md text-sm text-muted-foreground">We could not load the latest Kalshi snapshot. Try the manual refresh again.</p><button data-testid="button-retry-dashboard" onClick={handleRefresh} className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Retry connection</button></div></div></main>;
  }

  return <main className="dashboard-grid min-h-[100dvh] px-4 py-5 text-foreground sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1480px]">
      <header className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
        <div>
          <div className="mb-4 flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><TrendingUp size={19} /></div><span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">KALSHI / PREDICTOR</span></div>
          <h1 className="max-w-3xl text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">15-minute market intelligence<span className="text-primary">.</span></h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Recent Kalshi prices with experimental probabilities trained and evaluated on chronologically separated BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE contracts.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="status-source" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"><span className={`h-1.5 w-1.5 rounded-full ${dashboard?.isLive ? 'bg-accent' : 'bg-primary'}`} />{dashboard?.isLive ? 'Real market data' : 'Snapshot source'}</span>
            <span className="rounded-full border border-border bg-card px-2.5 py-1 font-mono">{dashboard?.source ?? 'Kalshi feed'} · as of {dashboard?.asOf ? formatTime(dashboard.asOf) : '—'}</span>
            <span className="font-mono text-[10px] uppercase tracking-wider">Updated {lastRefresh}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print-hidden">
          <div ref={refreshRef} className="relative flex h-9 items-center overflow-visible rounded-md border border-border bg-card">
            <button data-testid="button-refresh-dashboard" onClick={handleRefresh} className="flex h-full items-center gap-2 px-3 text-xs font-semibold transition hover:text-accent"><RefreshCw size={14} className={dashboardQuery.isFetching ? 'animate-spin' : ''} />Refresh</button>
            <div className="h-5 w-px bg-border" />
            <button data-testid="button-refresh-options" aria-label="Refresh options" onClick={() => setMenuOpen((open) => !open)} className="flex h-full items-center px-2 text-muted-foreground transition hover:text-accent"><ChevronDown size={14} /></button>
            {menuOpen && <div className="absolute right-0 top-11 z-20 w-56 rounded-lg border border-border bg-popover p-2 shadow-xl">
              <label className="flex cursor-pointer items-center justify-between rounded-md px-2 py-2 text-xs hover:bg-muted"><span>Auto-refresh</span><input data-testid="input-auto-refresh" type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} className="accent-[hsl(var(--primary))]" /></label>
              <div className="my-1 border-t border-border" />
              {intervals.map((option) => <button data-testid={`button-${option.label.toLowerCase().replaceAll(' ', '-')}`} key={option.ms} onClick={() => { setIntervalMs(option.ms); setAutoRefresh(true); setMenuOpen(false); }} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs hover:bg-muted"><span>{option.label}</span>{intervalMs === option.ms && autoRefresh ? <Check size={14} className="text-accent" /> : null}</button>)}
              <p className="px-2 pb-1 pt-2 text-[10px] leading-4 text-muted-foreground">Three-minute polling keeps the forecast record near the five-minute evaluation point.</p>
            </div>}
          </div>
          <IconButton label="Print or save PDF" onClick={() => window.print()}><FileText size={15} /></IconButton>
          <IconButton label="Toggle dark mode" onClick={() => setIsDark((dark) => !dark)}>{isDark ? <Sun size={15} /> : <Moon size={15} />}</IconButton>
        </div>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Markets scanned', value: dashboard?.totalMarkets.toLocaleString() ?? '—', note: 'Current universe', color: 'text-accent' },
          { label: 'Active predictions', value: dashboard?.activeSignals.toLocaleString() ?? '—', note: 'Above current filter', color: 'text-primary' },
          { label: 'Average probability', value: formatPercent(dashboard?.averageConfidence), note: 'Predicted side probability', color: 'text-accent' },
          { label: 'Holdout hit rate', value: formatPercent(dashboard?.backtestHitRate), note: dashboard ? `${dashboard.backtestSampleSize} unseen markets` : 'Chronological test', color: 'text-primary' },
        ].map((metric) => <div data-testid={`metric-${metric.label.toLowerCase().replaceAll(' ', '-')}`} key={metric.label} className="data-card rounded-xl p-4"><p className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{metric.label}</p>{loading ? <SkeletonBlock className="mt-3 h-8 w-28" /> : <p className={`mt-2 text-2xl font-extrabold tracking-tight ${metric.color}`}>{metric.value}</p>}<p className="mt-1 text-xs text-muted-foreground">{metric.note}</p></div>)}
      </div>

      <section className="data-card mb-6 rounded-xl p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Prediction controls</p><p className="mt-1 text-sm text-muted-foreground">Filter the probabilities produced by the time-split logistic baseline.</p></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="min-w-[170px]"><span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Category</span><select data-testid="select-category" value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-accent"><option value="">All categories</option>{categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <label className="min-w-[170px]"><span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Min probability <b className="text-foreground">{minConfidence}%</b></span><input data-testid="input-min-confidence" type="range" min="0" max="100" step="5" value={minConfidence} onChange={(event) => setMinConfidence(Number(event.target.value))} className="mt-2 h-2 w-full accent-[hsl(var(--accent))]" /></label>
            <label className="min-w-[150px]"><span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Signal limit</span><select data-testid="select-signal-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-accent"><option value="5">Top 5</option><option value="8">Top 8</option><option value="12">Top 12</option><option value="20">Top 20</option></select></label>
          </div>
        </div>
      </section>

      <div className="mb-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Panel title="Live probabilistic predictions" eyebrow="01 / model output" actions={<span className="font-mono text-[10px] text-muted-foreground">{dashboard?.signals?.length ?? 0} ranked</span>}>
          <div className="divide-y divide-border/70">
            {loading ? Array.from({ length: 4 }).map((_, index) => <div className="p-5" key={index}><SkeletonBlock className="h-4 w-1/2" /><SkeletonBlock className="mt-3 h-3 w-3/4" /></div>) : !dashboard?.signals?.length ? <div className="p-12 text-center text-sm text-muted-foreground">No signals meet this confidence threshold.</div> : dashboard.signals.map((signal, index) => <article data-testid={`signal-${signal.id}`} key={signal.id} className="group grid gap-3 p-4 transition hover:bg-muted/45 sm:grid-cols-[auto_1fr_auto] sm:items-center">
              <div className="flex items-center gap-3 sm:block"><span className="font-mono text-xs text-muted-foreground">0{index + 1}</span><span className={`mt-1 inline-flex rounded px-2 py-1 font-mono text-[10px] font-medium ${signal.side === 'YES' ? 'bg-accent/10 text-accent' : 'bg-destructive/10 text-destructive'}`}>{signal.side}</span></div>
              <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{signal.title}</h3><span className="font-mono text-[10px] text-muted-foreground">{signal.ticker}</span><span className={`rounded px-2 py-1 text-[10px] font-semibold ${recommendationClass(signal.recommendation)}`}>{recommendationLabel(signal.recommendation)}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.explanation}</p><div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground"><span>Model <b className="text-primary">{formatPercent(signal.modelProbability)}</b></span><span>Market <b className="text-foreground">{formatPercent(signal.marketProbability)}</b></span><span>Edge <b className="text-accent">{formatPercent(signal.edge)}</b></span><span>Net EV est. <b className="text-foreground">{formatPercent(signal.netExpectedValue)}</b></span><span>Fee est. <b className="text-foreground">{formatPrice(signal.estimatedFee)}</b></span><span>Closes {signal.timeToClose}</span></div></div>
              <div className="text-left sm:text-right"><p className="font-mono text-lg font-medium text-primary">{formatPercent(signal.confidence)}</p><p className="text-[10px] uppercase tracking-wider text-muted-foreground">predicted chance</p></div>
            </article>)}
          </div>
        </Panel>
        <Panel title="Active 15-minute contract" eyebrow="02 / one-minute YES candles" actions={<ExportButton filename="yes-price-history.csv" rows={chartPriceRows} />}>
          <div className="p-4">
            {loading ? <SkeletonBlock className="h-[260px] w-full" /> : !chartPriceRows.length ? <EmptyChart text="No intraday price history" /> : <ResponsiveContainer width="100%" height={260}><AreaChart data={chartPriceRows} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><defs><linearGradient id="yesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={chartColors.teal} stopOpacity={0.32} /><stop offset="100%" stopColor={chartColors.teal} stopOpacity={0.02} /></linearGradient></defs><CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} /><XAxis dataKey="time" tickFormatter={formatTime} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} minTickGap={26} /><YAxis domain={[0, 1]} tickFormatter={(value) => `${Math.round(value * 100)}¢`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} /><Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} formatter={(value: number) => [formatPrice(value), 'YES price']} labelFormatter={formatTime} /><Area type="monotone" dataKey="yesPrice" stroke={chartColors.teal} strokeWidth={2.5} fill="url(#yesFill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} /></AreaChart></ResponsiveContainer>}
            <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3 text-xs"><span className="text-muted-foreground">Latest YES price</span><strong data-testid="text-latest-yes-price">{formatPrice(chartPriceRows.at(-1)?.yesPrice)}</strong></div>
          </div>
        </Panel>
      </div>

      <div className="mb-6">
        <Panel title="Profitability by asset" eyebrow="03 / decision support" actions={<span className="font-mono text-[10px] text-muted-foreground">Historical test + current quote</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead><tr className="border-b border-border/70 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><th className="px-4 py-3 font-mono font-medium">Asset</th><th className="px-4 py-3 font-mono font-medium">Historical net</th><th className="px-4 py-3 font-mono font-medium">Hit rate</th><th className="px-4 py-3 font-mono font-medium">Max drawdown</th><th className="px-4 py-3 font-mono font-medium">Avg. P&amp;L</th><th className="px-4 py-3 font-mono font-medium">Current prediction</th><th className="px-4 py-3 font-mono font-medium">Net EV est.</th><th className="px-4 py-3 font-mono font-medium">Model view</th><th className="px-4 py-3 font-mono font-medium">Forward record</th></tr></thead>
              <tbody className="divide-y divide-border/60">{loading ? Array.from({ length: 7 }).map((_, index) => <tr key={index}>{Array.from({ length: 9 }).map((__, cell) => <td className="px-4 py-3" key={cell}><SkeletonBlock className="h-4 w-16" /></td>)}</tr>) : (dashboard?.assetStats ?? []).map((asset) => <tr data-testid={`row-profitability-${asset.asset}`} key={asset.asset} className="transition hover:bg-muted/45"><td className="px-4 py-3"><p className="text-sm font-bold">{asset.asset}</p><p className="font-mono text-[10px] text-muted-foreground">{asset.seriesTicker}</p></td><td className={`px-4 py-3 font-mono text-sm font-semibold ${asset.netReturn > 0 ? 'text-accent' : 'text-destructive'}`}>{formatPercent(asset.netReturn)}<p className="mt-0.5 text-[9px] font-normal text-muted-foreground">{asset.sampleSize} unseen markets</p></td><td className="px-4 py-3 font-mono text-xs">{formatPercent(asset.hitRate)}</td><td className="px-4 py-3 font-mono text-xs text-destructive">{formatPercent(asset.maxDrawdown)}</td><td className={`px-4 py-3 font-mono text-xs ${asset.averageNetProfitCents >= 0 ? 'text-accent' : 'text-destructive'}`}>{asset.averageNetProfitCents.toFixed(2)}¢</td><td className="px-4 py-3 font-mono text-xs">{asset.currentSide ? `${asset.currentSide} · ${formatPercent(asset.currentProbability)}` : 'No open market'}</td><td className={`px-4 py-3 font-mono text-xs ${(asset.currentNetExpectedValue ?? 0) > 0 ? 'text-accent' : 'text-destructive'}`}>{formatPercent(asset.currentNetExpectedValue)}</td><td className="px-4 py-3"><span className={`inline-flex rounded px-2 py-1 text-[10px] font-semibold ${recommendationClass(asset.recommendation)}`}>{recommendationLabel(asset.recommendation)}</span></td><td className="px-4 py-3 font-mono text-xs">{asset.forwardResolved}/{asset.forwardTracked}<p className="mt-0.5 text-[9px] text-muted-foreground">{asset.forwardResolved ? `${formatPercent(asset.forwardNetReturn)} net` : 'collecting outcomes'}</p></td></tr>)}</tbody>
            </table>
          </div>
          <footer className="border-t border-border/70 px-4 py-3 text-xs leading-5 text-muted-foreground">“Favorable” means the asset was profitable in the chronological test and the current model edge remains positive after the estimated taker fee. It is evidence to review—not a guarantee or an instruction to buy. Any trade must be made separately in Kalshi.</footer>
        </Panel>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_0.7fr]">
        <Panel title="Chronological holdout" eyebrow="04 / unseen-market test" actions={<ExportButton filename="model-performance.csv" rows={chartPerformanceRows} />}>
          <div className="p-4">
            {loading ? <SkeletonBlock className="h-[260px] w-full" /> : !chartPerformanceRows.length ? <EmptyChart text="The model could not produce a holdout evaluation" /> : <ResponsiveContainer width="100%" height={260}><LineChart data={chartPerformanceRows} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} /><YAxis yAxisId="return" tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} /><YAxis yAxisId="hit" orientation="right" domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} /><Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} /><Line yAxisId="return" type="monotone" dataKey="cumulativeReturn" name="Estimated net return" stroke={chartColors.yellow} strokeWidth={2.5} dot={false} isAnimationActive={false} /><Line yAxisId="hit" type="monotone" dataKey="hitRate" name="Hit rate" stroke={chartColors.teal} strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer>}
            <div className="mt-3 flex flex-wrap gap-5 border-t border-border/70 pt-3 text-xs text-muted-foreground"><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-primary" />Estimated net return</span><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-accent" />Hit rate</span><span>Market baseline {formatPercent(dashboard?.baselineHitRate)}</span><span>Brier {dashboard?.brierScore?.toFixed(4) ?? '—'}</span><span className="ml-auto italic">Five minutes before close · taker fee estimate included</span></div>
          </div>
        </Panel>
        <Panel title="Data status" eyebrow="05 / context">
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-1">
            <div className="bg-card p-5"><p className="text-xs text-muted-foreground">Estimated net paper return</p><p data-testid="text-simulated-return" className={`mt-1 text-3xl font-extrabold ${(dashboard?.netSimulatedReturn ?? 0) >= 0 ? 'text-accent' : 'text-destructive'}`}>{formatPercent(dashboard?.netSimulatedReturn)}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Holdout simulation at the quoted ask after the general taker-fee estimate. Actual fees and fills may differ.</p></div>
            <div className="bg-card p-5"><p className="text-xs text-muted-foreground">Forward signal record</p><p className="mt-1 text-2xl font-extrabold">{dashboard?.liveTracking.resolved ?? 0} resolved <span className="text-sm font-normal text-muted-foreground">/ {dashboard?.liveTracking.tracked ?? 0} tracked</span></p><p className="mt-2 text-xs leading-5 text-muted-foreground">{dashboard?.liveTracking.resolved ? `${formatPercent(dashboard.liveTracking.hitRate)} hit rate · ${formatPercent(dashboard.liveTracking.netReturn)} estimated net return.` : 'The app has started recording predictions. Results will appear after those markets settle.'}</p></div>
            <div className="bg-card p-5"><p className="text-xs text-muted-foreground">Model status</p><div className="mt-2 flex items-center gap-2 text-sm font-semibold"><Wifi size={15} className={dashboard?.isLive ? 'text-accent' : 'text-primary'} />{dashboard?.isLive ? 'Kalshi API + model connected' : 'Cached market snapshot'}</div><p className="mt-2 text-xs leading-5 text-muted-foreground">{dashboard ? `${dashboard.modelName} · trained on ${dashboard.trainingMarkets} markets · ${formatTime(dashboard.modelTrainedAt)}` : 'Training model…'}</p></div>
          </div>
        </Panel>
      </div>

      <Panel title="Market universe" eyebrow="06 / scan all contracts" actions={<div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input data-testid="input-market-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search markets" className="h-9 w-48 rounded-md border border-input bg-background pl-8 pr-3 text-xs outline-none focus:border-accent sm:w-64" />{search && <button data-testid="button-clear-search" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={13} /></button>}</div>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left"><thead><tr className="border-b border-border/70 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{[['ticker', 'Market'], ['category', 'Category'], ['closeTime', 'Closes'], ['volume', 'Volume'], ['yesPrice', 'YES'], ['noPrice', 'NO'], ['liquidity', 'Liquidity']].map(([key, label]) => <th key={key} className="px-5 py-3 font-mono font-medium"><button data-testid={`button-sort-${key}`} onClick={() => { if (sortKey === key) setSortDesc((desc) => !desc); else { setSortKey(key as typeof sortKey); setSortDesc(true); } }} className="inline-flex items-center gap-1 hover:text-accent">{label}{sortKey === key ? (sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : null}</button></th>)}</tr></thead><tbody className="divide-y divide-border/60">{dashboardQuery.isLoading && !dashboard?.markets?.length ? Array.from({ length: 5 }).map((_, index) => <tr key={index}>{Array.from({ length: 7 }).map((__, cell) => <td className="px-5 py-4" key={cell}><SkeletonBlock className="h-4 w-20" /></td>)}</tr>) : marketRows.length ? marketRows.map((market) => <tr data-testid={`row-market-${market.ticker}`} key={market.ticker} className="transition hover:bg-muted/45"><td className="px-5 py-3.5"><p className="text-sm font-semibold">{market.title}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{market.ticker}</p></td><td className="px-5 py-3.5 text-sm text-muted-foreground">{market.category}</td><td className="px-5 py-3.5 font-mono text-xs">{formatTime(market.closeTime)}</td><td className="px-5 py-3.5 font-mono text-xs">{market.volume.toLocaleString()}</td><td className="px-5 py-3.5 font-mono text-sm text-accent">{formatPrice(market.yesPrice)}</td><td className="px-5 py-3.5 font-mono text-sm text-muted-foreground">{formatPrice(market.noPrice)}</td><td className="px-5 py-3.5 text-sm">{market.liquidity}</td></tr>) : <tr><td colSpan={7} className="h-36 text-center text-sm text-muted-foreground">No markets match your search.</td></tr>}</tbody></table>
        </div>
        <footer className="flex flex-col gap-2 border-t border-border/70 px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>{marketRows.length} markets shown{dashboardQuery.isFetching ? ' · updating' : ''}</span><span className="font-mono text-[10px] uppercase tracking-wider">Prices in cents · volume is contract count</span></footer>
      </Panel>
      <footer className="flex flex-col gap-2 py-7 text-[11px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Kalshi 15-Minute Predictor · seven live crypto contracts.</span><span>Probabilities are experimental estimates, not financial advice or guaranteed outcomes.</span></footer>
    </div>
  </main>;
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
