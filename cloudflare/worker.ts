import modelSnapshot from "./model-snapshot.json";
import {
  predictLiveMarket,
  type KalshiApiCandle,
  type KalshiApiMarket,
  type ValidatedKalshiModel,
} from "../artifacts/api-server/src/services/kalshi-model";

const KALSHI_API_BASE_URL =
  "https://external-api.kalshi.com/trade-api/v2";
const LIVE_SERIES = [
  "KXBTC15M",
  "KXETH15M",
  "KXSOL15M",
  "KXXRP15M",
  "KXDOGE15M",
  "KXBNB15M",
  "KXHYPE15M",
] as const;
const ASSET_BY_SERIES: Record<(typeof LIVE_SERIES)[number], string> = {
  KXBTC15M: "BTC",
  KXETH15M: "ETH",
  KXSOL15M: "SOL",
  KXXRP15M: "XRP",
  KXDOGE15M: "DOGE",
  KXBNB15M: "BNB",
  KXHYPE15M: "HYPE",
};
const KALSHI_TAKER_FEE_RATE = 0.07;
const SNAPSHOT_CACHE_SECONDS = 30;
const model = modelSnapshot as ValidatedKalshiModel;

type LiveSignal = ReturnType<typeof buildSignal>;
type PaperSignalRow = {
  ticker: string;
  asset: string;
  side: "YES" | "NO";
  entry_price: number;
  model_probability: number;
  estimated_fee: number;
  model_name: string;
  seconds_to_close: number;
  created_at: string;
  result: "yes" | "no" | null;
  settled_at: string | null;
  correct: number | null;
  net_profit: number | null;
};

type ForwardAssetStats = {
  asset: string;
  tracked: number;
  pending: number;
  resolved: number;
  hitRate: number;
  netReturn: number;
  totalProfit: number;
};

type ForwardTrackingStats = Omit<ForwardAssetStats, "asset"> & {
  startedAt: string;
  assets: ForwardAssetStats[];
};

type LiveSnapshot = {
  markets: Array<ReturnType<typeof toDashboardMarket>>;
  signals: LiveSignal[];
  priceHistory: Array<ReturnType<typeof toPricePoint>>;
  asOf: string;
  liveTracking: ForwardTrackingStats;
};

function numberFrom(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rounded(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function midpoint(bid: string | undefined, ask: string | undefined): number {
  const bidValue = numberFrom(bid);
  const askValue = numberFrom(ask);
  if (bidValue > 0 && askValue > 0) return (bidValue + askValue) / 2;
  return askValue || bidValue;
}

function yesPrice(market: KalshiApiMarket): number {
  return clamp(
    midpoint(market.yes_bid_dollars, market.yes_ask_dollars) ||
      numberFrom(market.last_price_dollars),
    0,
    1,
  );
}

function noPrice(market: KalshiApiMarket): number {
  return clamp(
    midpoint(market.no_bid_dollars, market.no_ask_dollars) ||
      1 - yesPrice(market),
    0,
    1,
  );
}

function compactUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function timeToClose(closeTime: string): string {
  const remainingSeconds = Math.max(
    0,
    Math.floor((Date.parse(closeTime) - Date.now()) / 1_000),
  );
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function seriesFor(market: KalshiApiMarket): (typeof LIVE_SERIES)[number] {
  return (
    LIVE_SERIES.find((seriesTicker) =>
      market.ticker.startsWith(seriesTicker),
    ) ?? LIVE_SERIES[0]
  );
}

function assetFor(market: KalshiApiMarket): string {
  return ASSET_BY_SERIES[seriesFor(market)];
}

function toDashboardMarket(market: KalshiApiMarket) {
  return {
    ticker: market.ticker,
    title: market.title,
    category: "Crypto",
    closeTime: market.close_time,
    volume: Math.round(numberFrom(market.volume_fp)),
    yesPrice: rounded(yesPrice(market), 4),
    noPrice: rounded(noPrice(market), 4),
    liquidity: compactUsd(numberFrom(market.liquidity_dollars)),
    status: market.status,
  };
}

function toPricePoint(candle: KalshiApiCandle) {
  return {
    time: new Date(candle.end_period_ts * 1_000).toISOString(),
    yesPrice: rounded(numberFrom(candle.price?.close_dollars), 4),
    volume: Math.round(numberFrom(candle.volume_fp)),
  };
}

function buildSignal(market: KalshiApiMarket, candles: KalshiApiCandle[]) {
  const secondsToClose = Math.max(
    0,
    Math.floor((Date.parse(market.close_time) - Date.now()) / 1_000),
  );
  const prediction = predictLiveMarket(market, candles, model);
  const side = prediction.yesProbability >= 0.5 ? ("YES" as const) : ("NO" as const);
  const marketProbability =
    (side === "YES"
      ? prediction.marketYesProbability
      : 1 - prediction.marketYesProbability) * 100;
  const modelProbability =
    (side === "YES"
      ? prediction.yesProbability
      : 1 - prediction.yesProbability) * 100;
  const quotedEntry =
    side === "YES"
      ? numberFrom(market.yes_ask_dollars)
      : numberFrom(market.no_ask_dollars);
  const entryPrice =
    quotedEntry || (side === "YES" ? yesPrice(market) : noPrice(market));
  const edge = modelProbability - marketProbability;
  const confidence = Math.round(modelProbability);
  const expectedValue =
    entryPrice > 0
      ? ((modelProbability / 100 - entryPrice) / entryPrice) * 100
      : 0;
  const estimatedFee =
    KALSHI_TAKER_FEE_RATE * entryPrice * (1 - entryPrice);
  const netExpectedValue =
    entryPrice > 0
      ? ((modelProbability / 100 - entryPrice - estimatedFee) /
          (entryPrice + estimatedFee)) *
        100
      : 0;
  const asset = assetFor(market);
  const assetHistory = model.assetStats.find((stats) => stats.asset === asset);
  const recommendation =
    assetHistory?.profitable && confidence >= 60 && netExpectedValue >= 3
      ? ("favorable" as const)
      : netExpectedValue > 0
        ? ("wait" as const)
        : ("avoid" as const);
  const status =
    recommendation === "favorable"
      ? ("strong" as const)
      : recommendation === "wait"
        ? ("watch" as const)
        : ("caution" as const);

  return {
    id: `live-${market.ticker}`,
    ticker: market.ticker,
    asset,
    title: market.title,
    category: "Crypto",
    side,
    entryPrice: rounded(entryPrice, 4),
    modelProbability: rounded(modelProbability),
    marketProbability: rounded(marketProbability),
    edge: rounded(edge),
    confidence,
    liquidity: compactUsd(numberFrom(market.liquidity_dollars)),
    timeToClose: timeToClose(market.close_time),
    status,
    expectedValue: rounded(expectedValue),
    estimatedFee: rounded(estimatedFee, 4),
    netExpectedValue: rounded(netExpectedValue),
    recommendation,
    score: rounded(confidence + clamp(netExpectedValue, -20, 20)),
    explanation: `${model.name} estimates ${modelProbability.toFixed(1)}% for ${side}, versus ${marketProbability.toFixed(1)}% implied by the current quote. ${asset} returned an estimated ${assetHistory?.netReturn.toFixed(1) ?? "0.0"}% after fees in its unseen-market test; spread is ${(prediction.spread * 100).toFixed(1)}¢.`,
    updatedAt: new Date(
      (candles.at(-1)?.end_period_ts ?? Math.floor(Date.now() / 1_000)) *
        1_000,
    ).toISOString(),
    secondsToClose,
  };
}

async function kalshiFetch<T>(apiPath: string): Promise<T> {
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${KALSHI_API_BASE_URL}${apiPath}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    lastStatus = response.status;
    if (response.ok) return (await response.json()) as T;

    const shouldRetry = response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === 2) break;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1_000
        : 750 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new Error(
    `Kalshi API returned ${lastStatus ?? "an error"} for the requested resource`,
  );
}

async function fetchActiveMarkets(): Promise<KalshiApiMarket[]> {
  const responses = await Promise.all(
    LIVE_SERIES.map((seriesTicker) =>
      kalshiFetch<{ markets: KalshiApiMarket[] }>(
        `/markets?status=open&limit=10&series_ticker=${seriesTicker}`,
      ),
    ),
  );
  return responses.flatMap((response) => response.markets);
}

async function fetchCandles(market: KalshiApiMarket): Promise<KalshiApiCandle[]> {
  const seriesTicker = seriesFor(market);
  const startTimestamp = Math.floor(Date.parse(market.open_time) / 1_000) - 60;
  const endTimestamp = Math.min(
    Math.floor(Date.now() / 1_000),
    Math.floor(Date.parse(market.close_time) / 1_000),
  );
  const response = await kalshiFetch<{ candlesticks: KalshiApiCandle[] }>(
    `/series/${seriesTicker}/markets/${market.ticker}/candlesticks?start_ts=${startTimestamp}&end_ts=${endTimestamp}&period_interval=1`,
  );
  return response.candlesticks;
}

function summarizeRecords(records: PaperSignalRow[]): ForwardTrackingStats {
  const summarize = (subset: PaperSignalRow[]) => {
    const resolved = subset.filter(
      (record): record is PaperSignalRow & { net_profit: number } =>
        typeof record.net_profit === "number",
    );
    const totalCost = resolved.reduce(
      (sum, record) => sum + record.entry_price + record.estimated_fee,
      0,
    );
    const totalProfit = resolved.reduce(
      (sum, record) => sum + record.net_profit,
      0,
    );
    return {
      tracked: subset.length,
      pending: subset.length - resolved.length,
      resolved: resolved.length,
      hitRate: rounded(
        resolved.length > 0
          ? (resolved.filter((record) => record.correct === 1).length /
              resolved.length) *
              100
          : 0,
      ),
      netReturn: rounded(totalCost > 0 ? (totalProfit / totalCost) * 100 : 0),
      totalProfit: rounded(totalProfit, 2),
    };
  };
  const assets = [...new Set(records.map((record) => record.asset))].sort();

  return {
    startedAt: records.at(-1)?.created_at ?? new Date().toISOString(),
    ...summarize(records),
    assets: assets.map((asset) => ({
      asset,
      ...summarize(records.filter((record) => record.asset === asset)),
    })),
  };
}

async function updatePaperSignalLedger(
  env: Env,
  signals: LiveSignal[],
): Promise<ForwardTrackingStats> {
  const now = new Date().toISOString();
  const eligible = signals.filter(
    (signal) => signal.secondsToClose >= 240 && signal.secondsToClose <= 420,
  );

  if (eligible.length > 0) {
    await env.DB.batch(
      eligible.map((signal) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO paper_signals (
            ticker, asset, side, entry_price, model_probability,
            estimated_fee, model_name, seconds_to_close, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          signal.ticker,
          signal.asset,
          signal.side,
          signal.entryPrice,
          signal.modelProbability,
          signal.estimatedFee,
          model.name,
          signal.secondsToClose,
          now,
        ),
      ),
    );
  }

  const pending = await env.DB.prepare(
    "SELECT * FROM paper_signals WHERE result IS NULL ORDER BY created_at ASC LIMIT 100",
  ).all<PaperSignalRow>();
  if (pending.results.length > 0) {
    try {
      const tickers = encodeURIComponent(
        pending.results.map((record) => record.ticker).join(","),
      );
      const response = await kalshiFetch<{ markets: KalshiApiMarket[] }>(
        `/markets?limit=100&tickers=${tickers}`,
      );
      const resultByTicker = new Map(
        response.markets.map((market) => [market.ticker, market.result]),
      );
      const updates = pending.results.flatMap((record) => {
        const result = resultByTicker.get(record.ticker);
        if (result !== "yes" && result !== "no") return [];
        const correct = record.side.toLowerCase() === result;
        const grossProfit = correct ? 1 - record.entry_price : -record.entry_price;
        const netProfit = grossProfit - record.estimated_fee;
        return [
          env.DB.prepare(
            `UPDATE paper_signals
             SET result = ?, settled_at = ?, correct = ?, net_profit = ?
             WHERE ticker = ? AND result IS NULL`,
          ).bind(result, now, correct ? 1 : 0, netProfit, record.ticker),
        ];
      });
      if (updates.length > 0) await env.DB.batch(updates);
    } catch (error) {
      console.warn("Unable to settle paper signals", error);
    }
  }

  const records = await env.DB.prepare(
    "SELECT * FROM paper_signals ORDER BY created_at DESC LIMIT 5000",
  ).all<PaperSignalRow>();
  return summarizeRecords(records.results);
}

async function buildLiveSnapshot(env: Env): Promise<LiveSnapshot> {
  const apiMarkets = await fetchActiveMarkets();
  const candlesByTicker = new Map<string, KalshiApiCandle[]>();
  await Promise.all(
    apiMarkets.map(async (market) => {
      try {
        candlesByTicker.set(market.ticker, await fetchCandles(market));
      } catch (error) {
        console.warn(`Unable to load candles for ${market.ticker}`, error);
        candlesByTicker.set(market.ticker, []);
      }
    }),
  );
  const preferredChartMarket =
    apiMarkets.find((market) => market.ticker.startsWith("KXBTC15M")) ??
    apiMarkets[0];
  const priceHistory = preferredChartMarket
    ? (candlesByTicker.get(preferredChartMarket.ticker) ?? [])
        .sort((left, right) => left.end_period_ts - right.end_period_ts)
        .map(toPricePoint)
    : [];
  const signals = apiMarkets.map((market) =>
    buildSignal(market, candlesByTicker.get(market.ticker) ?? []),
  );

  return {
    markets: apiMarkets.map(toDashboardMarket),
    signals,
    priceHistory,
    asOf: new Date().toISOString(),
    liveTracking: await updatePaperSignalLedger(env, signals),
  };
}

async function getLiveSnapshot(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<LiveSnapshot> {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/__internal/kalshi-live-snapshot";
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return (await cached.json()) as LiveSnapshot;

  const snapshot = await buildLiveSnapshot(env);
  const cachedResponse = new Response(JSON.stringify(snapshot), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${SNAPSHOT_CACHE_SECONDS}`,
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));
  return snapshot;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function dashboardResponse(snapshot: LiveSnapshot, url: URL) {
  const category = url.searchParams.get("category") ?? "";
  const parsedConfidence = Number(url.searchParams.get("minConfidence") ?? 60);
  const parsedLimit = Number(url.searchParams.get("limit") ?? 8);
  const minConfidence = clamp(
    Number.isFinite(parsedConfidence) ? parsedConfidence : 60,
    0,
    100,
  );
  const limit = Math.floor(
    clamp(Number.isFinite(parsedLimit) ? parsedLimit : 8, 1, 50),
  );
  const signals = snapshot.signals
    .filter((signal) => !category || signal.category === category)
    .filter((signal) => signal.confidence >= minConfidence)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  const markets = snapshot.markets.filter(
    (market) => !category || market.category === category,
  );
  const averageConfidence =
    signals.length > 0
      ? Math.round(
          signals.reduce((sum, signal) => sum + signal.confidence, 0) /
            signals.length,
        )
      : 0;

  return {
    asOf: snapshot.asOf,
    source: `Kalshi public REST API · ${model.name}`,
    isLive: true,
    totalMarkets: markets.length,
    activeSignals: signals.length,
    averageConfidence,
    backtestHitRate: model.hitRate,
    simulatedReturn: model.grossPaperReturn,
    netSimulatedReturn: model.netPaperReturn,
    modelName: model.name,
    modelTrainedAt: model.trainedAt,
    trainingMarkets: model.trainingMarkets,
    backtestSampleSize: model.holdoutMarkets,
    baselineHitRate: model.baselineHitRate,
    brierScore: model.brierScore,
    assetStats: model.assetStats.map((stats) => {
      const current = snapshot.signals.find(
        (signal) => signal.asset === stats.asset,
      );
      const forward = snapshot.liveTracking.assets.find(
        (asset) => asset.asset === stats.asset,
      );
      return {
        ...stats,
        currentSide: current?.side,
        currentProbability: current?.modelProbability,
        currentNetExpectedValue: current?.netExpectedValue,
        recommendation: current?.recommendation,
        forwardTracked: forward?.tracked ?? 0,
        forwardResolved: forward?.resolved ?? 0,
        forwardHitRate: forward?.hitRate ?? 0,
        forwardNetReturn: forward?.netReturn ?? 0,
      };
    }),
    liveTracking: snapshot.liveTracking,
    signals,
    priceHistory: snapshot.priceHistory,
    performance: model.performance,
    markets,
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/kalshi/dashboard") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        const snapshot = await getLiveSnapshot(env, request, ctx);
        return json(dashboardResponse(snapshot, url));
      } catch (error) {
        console.error("Unable to load live Kalshi dashboard", error);
        return json({ error: "Unable to load live Kalshi data" }, 502);
      }
    }

    if (url.pathname === "/api/kalshi/markets") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        const snapshot = await getLiveSnapshot(env, request, ctx);
        return json(snapshot.markets);
      } catch (error) {
        console.error("Unable to list live Kalshi markets", error);
        return json({ error: "Unable to load live Kalshi data" }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
