import modelSnapshot from "./model-snapshot.json";
import {
  predictLiveMarket,
  type KalshiApiCandle,
  type KalshiApiMarket,
  type ValidatedKalshiModel,
} from "../artifacts/api-server/src/services/kalshi-model";

const KALSHI_API_BASE_URLS = [
  "https://external-api.kalshi.com/trade-api/v2",
  "https://api.elections.kalshi.com/trade-api/v2",
] as const;
const LIVE_SERIES = [
  "KXBTC15M",
  "KXETH15M",
  "KXSOL15M",
  "KXXRP15M",
  "KXDOGE15M",
  "KXBNB15M",
  "KXHYPE15M",
] as const;
type LiveSeries = (typeof LIVE_SERIES)[number];
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
const FRESH_SNAPSHOT_MS = 7 * 60 * 1_000;
const DELAYED_SNAPSHOT_MS = 15 * 60 * 1_000;
const MAX_CANDLE_AGE_SECONDS = 6 * 60;
const MIN_CANDLE_COUNT = 1;
const MAX_SUPPORTED_SPREAD = 0.1;
const MARKET_INTERVAL_MS = 15 * 60 * 1_000;
const EARLY_INITIAL_MAX_SECONDS_TO_CLOSE = 855;
const EARLY_INITIAL_MIN_SECONDS_TO_CLOSE = 795;
const EARLY_CONFIRMATION_MAX_SECONDS_TO_CLOSE = 794;
const EARLY_CONFIRMATION_MIN_SECONDS_TO_CLOSE = 705;
const EARLY_INITIAL_TARGET_SECONDS_TO_CLOSE = 14 * 60;
const EARLY_CONFIRMATION_TARGET_SECONDS_TO_CLOSE = 13 * 60;
const DIRECT_EARLY_REFRESH_MAX_AGE_MS = 55 * 1_000;
const MARKET_TIME_ZONE = "America/New_York";
const PUBLISHED_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/Ronaldo76625/15-minute-market-intelligence/live-data/live-data.json";
const bundledModel = modelSnapshot as ValidatedKalshiModel;

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

type EarlyForecastObservation = {
  side: "YES" | "NO";
  yesProbability: number;
  noProbability: number;
  confidence: number;
  marketYesProbability: number;
  netExpectedValue: number;
  recommendation: "favorable" | "wait" | "avoid";
  observedAt: string;
  secondsToClose: number;
  horizonMinutes: number;
  horizonHitRate: number;
  horizonHitRateLowerBound: number;
  horizonSampleSize: number;
  horizonConfidenceThreshold: number;
  isQualified: boolean;
  qualificationReason: LiveSignal["qualificationReason"];
};

type EarlyForecastRow = {
  ticker: string;
  asset: string;
  title: string;
  close_time: string;
  previous_result: "YES" | "NO" | null;
  initial_payload: string | null;
  confirmation_payload: string | null;
  result: "yes" | "no" | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

type EarlyForecast = {
  ticker: string;
  asset: string;
  title: string;
  closeTime: string;
  previousResult?: "YES" | "NO";
  phase: "preliminary" | "initial" | "confirmed";
  agreement: "pending" | "confirmed" | "revised";
  recommendation: "favorable" | "wait" | "avoid";
  initial?: EarlyForecastObservation;
  confirmation?: EarlyForecastObservation;
  current: EarlyForecastObservation;
};

type StoredOpeningObservations = {
  ticker: string;
  initial?: EarlyForecastObservation;
  confirmation?: EarlyForecastObservation;
};

type StoredSnapshot = {
  markets: Array<ReturnType<typeof toDashboardMarket>>;
  signals: LiveSignal[];
  priceHistory: Array<ReturnType<typeof toPricePoint>>;
  openingObservations?: StoredOpeningObservations[];
  asOf: string;
  model: ValidatedKalshiModel;
};
type DataFreshness = "live" | "delayed" | "stale";
type LiveSnapshot = StoredSnapshot & {
  liveTracking: ForwardTrackingStats;
  earlyForecasts: EarlyForecast[];
  dataFreshness: DataFreshness;
  dataAgeSeconds: number;
};
export type KalshiSettlement = {
  ticker: string;
  result: "yes" | "no";
  asset?: string;
  closeTime?: string;
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

function timeToClose(closeTime: string, referenceTimeMs = Date.now()): string {
  const remainingSeconds = Math.max(
    0,
    Math.floor((Date.parse(closeTime) - referenceTimeMs) / 1_000),
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

function marketTickerSuffix(closeTimestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIME_ZONE,
    year: "2-digit",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(closeTimestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const minute = part("minute");
  return `${part("year")}${part("month").toUpperCase()}${part("day")}${part("hour")}${minute}-${minute}`;
}

function marketTickersForClose(
  closeTimestamp: number,
  seriesTickers: readonly LiveSeries[],
): string[] {
  const suffix = marketTickerSuffix(closeTimestamp);
  return seriesTickers.map((seriesTicker) => `${seriesTicker}-${suffix}`);
}

function toDashboardMarket(market: KalshiApiMarket) {
  return {
    ticker: market.ticker,
    asset: assetFor(market),
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

function refreshSignalTimers(
  signals: LiveSignal[],
  markets: StoredSnapshot["markets"],
): LiveSignal[] {
  const closeTimeByTicker = new Map(
    markets.map((market) => [market.ticker, market.closeTime]),
  );
  return signals.flatMap((signal) => {
    const closeTime = closeTimeByTicker.get(signal.ticker);
    if (!closeTime) return [];
    const secondsToClose = Math.max(
      0,
      Math.floor((Date.parse(closeTime) - Date.now()) / 1_000),
    );
    if (secondsToClose <= 0) return [];
    const latestCandleAgeSeconds = Math.floor(
      (Date.now() - Date.parse(signal.updatedAt)) / 1_000,
    );
    const candlesAreRecent =
      Number.isFinite(latestCandleAgeSeconds) &&
      latestCandleAgeSeconds >= -60 &&
      latestCandleAgeSeconds <= MAX_CANDLE_AGE_SECONDS;
    const dataQualityOk = signal.dataQualityOk && candlesAreRecent;
    const isQualified = dataQualityOk;
    return [
      {
        ...signal,
        secondsToClose,
        timeToClose: timeToClose(closeTime),
        latestCandleAgeSeconds,
        dataQualityOk,
        isQualified,
        qualificationReason: !candlesAreRecent
          ? "stale_candles"
          : !signal.dataQualityOk
            ? signal.qualificationReason
            : "ready",
        recommendation: isQualified ? signal.recommendation : "wait",
        status: isQualified ? signal.status : "watch",
      },
    ];
  });
}

function buildSignal(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  selectedModel: ValidatedKalshiModel = bundledModel,
  observedAtMs = Date.now(),
) {
  const secondsToClose = Math.max(
    0,
    Math.floor((Date.parse(market.close_time) - observedAtMs) / 1_000),
  );
  const prediction = predictLiveMarket(
    market,
    candles,
    selectedModel,
    observedAtMs,
  );
  const horizon = prediction.horizon;
  const rawYesProbability = prediction.yesProbability;
  const calibrationPenalty = clamp(
    horizon.expectedCalibrationError / 100,
    0.005,
    0.15,
  );
  const finiteSamplePenalty = clamp(
    1.96 *
      Math.sqrt(
        (rawYesProbability * (1 - rawYesProbability)) /
          Math.max(30, horizon.evaluationMarkets),
      ),
    0,
    0.08,
  );
  const uncertaintyMargin = clamp(
    calibrationPenalty + finiteSamplePenalty + prediction.spread / 2,
    0.01,
    0.2,
  );
  const conservativeYesProbability =
    rawYesProbability >= 0.5
      ? Math.max(0.5, rawYesProbability - uncertaintyMargin)
      : Math.min(0.5, rawYesProbability + uncertaintyMargin);
  const side = rawYesProbability >= 0.5 ? ("YES" as const) : ("NO" as const);
  const marketProbability =
    (side === "YES"
      ? prediction.marketYesProbability
      : 1 - prediction.marketYesProbability) * 100;
  const modelProbability =
    (side === "YES"
      ? conservativeYesProbability
      : 1 - conservativeYesProbability) * 100;
  const quotedEntry =
    side === "YES"
      ? numberFrom(market.yes_ask_dollars)
      : numberFrom(market.no_ask_dollars);
  const entryPrice =
    quotedEntry || (side === "YES" ? yesPrice(market) : noPrice(market));
  const edge = modelProbability - marketProbability;
  const confidence = rounded(modelProbability);
  const expectedValue =
    entryPrice > 0
      ? ((modelProbability / 100 - entryPrice) / entryPrice) * 100
      : 0;
  const estimatedFee = KALSHI_TAKER_FEE_RATE * entryPrice * (1 - entryPrice);
  const netExpectedValue =
    entryPrice > 0
      ? ((modelProbability / 100 - entryPrice - estimatedFee) /
          (entryPrice + estimatedFee)) *
        100
      : 0;
  const asset = assetFor(market);
  const assetHistory = horizon.assetStats.find(
    (stats) => stats.asset === asset,
  );
  const latestCandleTimestamp = candles.at(-1)?.end_period_ts;
  const latestCandleAgeSeconds = latestCandleTimestamp
    ? Math.floor(observedAtMs / 1_000 - latestCandleTimestamp)
    : Number.POSITIVE_INFINITY;
  const hasEnoughCandles = candles.length >= MIN_CANDLE_COUNT;
  const candlesAreRecent =
    latestCandleAgeSeconds >= -60 &&
    latestCandleAgeSeconds <= MAX_CANDLE_AGE_SECONDS;
  const spreadIsSupported = prediction.spread <= MAX_SUPPORTED_SPREAD;
  const dataQualityOk =
    hasEnoughCandles && candlesAreRecent && spreadIsSupported;
  const qualificationReason = !hasEnoughCandles
    ? ("insufficient_history" as const)
    : !candlesAreRecent
      ? ("stale_candles" as const)
      : !spreadIsSupported
        ? ("wide_spread" as const)
        : ("ready" as const);
  const isQualified = dataQualityOk;
  const qualifiedConfidence = confidence >= (horizon.confidenceThreshold ?? 60);
  const validationApproved = (horizon.reliableAssets ?? []).includes(asset);
  const recommendation =
    isQualified &&
    validationApproved &&
    qualifiedConfidence &&
    netExpectedValue >= 3
      ? ("favorable" as const)
      : isQualified && qualifiedConfidence && netExpectedValue > 0
        ? ("wait" as const)
        : isQualified
          ? ("avoid" as const)
          : ("wait" as const);
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
    yesProbability: rounded(conservativeYesProbability * 100),
    noProbability: rounded((1 - conservativeYesProbability) * 100),
    rawYesProbability: rounded(rawYesProbability * 100),
    rawNoProbability: rounded((1 - rawYesProbability) * 100),
    marketYesProbability: rounded(prediction.marketYesProbability * 100),
    marketNoProbability: rounded((1 - prediction.marketYesProbability) * 100),
    uncertaintyMargin: rounded(uncertaintyMargin * 100),
    edge: rounded(edge),
    confidence,
    liquidity: compactUsd(numberFrom(market.liquidity_dollars)),
    timeToClose: timeToClose(market.close_time, observedAtMs),
    status,
    expectedValue: rounded(expectedValue),
    estimatedFee: rounded(estimatedFee, 4),
    netExpectedValue: rounded(netExpectedValue),
    recommendation,
    score: rounded(confidence + clamp(netExpectedValue, -20, 20)),
    explanation: `${selectedModel.name} selected the independently calibrated ${horizon.targetSeconds / 60}-minute horizon and estimates ${(rawYesProbability * 100).toFixed(1)}% YES before a conservative ${(uncertaintyMargin * 100).toFixed(1)} point uncertainty adjustment. That horizon scored ${horizon.hitRate.toFixed(1)}% across ${horizon.holdoutMarkets} qualified unseen signals. ${asset} returned an estimated ${assetHistory?.netReturn.toFixed(1) ?? "0.0"}% after fees at this horizon; spread is ${(prediction.spread * 100).toFixed(1)}¢.`,
    updatedAt: new Date(
      (candles.at(-1)?.end_period_ts ?? Math.floor(Date.now() / 1_000)) * 1_000,
    ).toISOString(),
    secondsToClose,
    latestCandleAgeSeconds: Number.isFinite(latestCandleAgeSeconds)
      ? latestCandleAgeSeconds
      : -1,
    dataQualityOk,
    isQualified,
    qualificationReason,
    horizonMinutes: rounded(horizon.targetSeconds / 60),
    horizonHitRate: horizon.hitRate,
    horizonHitRateLowerBound: horizon.hitRateLowerBound,
    horizonSampleSize: horizon.holdoutMarkets,
    horizonConfidenceThreshold: horizon.confidenceThreshold,
  };
}

async function kalshiFetch<T>(apiPath: string): Promise<T> {
  let lastStatus: number | undefined;

  for (const baseUrl of KALSHI_API_BASE_URLS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}${apiPath}`, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      });
      lastStatus = response.status;
      if (response.ok) return (await response.json()) as T;
      if (response.status === 429) {
        console.warn("Kalshi rate limit", {
          host: new URL(baseUrl).host,
          retryAfter: response.headers.get("retry-after") ?? "not-provided",
        });
        break;
      }
      const shouldRetry = response.status >= 500;
      if (!shouldRetry || attempt === 1) break;
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : 750 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // A translated-origin read-through uses a different public egress route
  // when Kalshi throttles Cloudflare's shared addresses. Source and target are
  // both English so the response body remains the official JSON unchanged.
  try {
    const separator = apiPath.includes("?") ? "&" : "?";
    const translatedUrl =
      `https://external--api-kalshi-com.translate.goog/trade-api/v2${apiPath}` +
      `${separator}_x_tr_sl=en&_x_tr_tl=en&_x_tr_hl=en`;
    const response = await fetch(translatedUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    lastStatus = response.status;
    if (response.ok) {
      console.warn("Using the public Kalshi translated-origin fallback");
      return (await response.json()) as T;
    }
  } catch (error) {
    console.warn("Kalshi translated-origin fallback failed", error);
  }

  // Kalshi can throttle shared Cloudflare egress IPs even at a low request
  // volume. Reader is used only as a public, read-only transport fallback;
  // the requested resource remains the official Kalshi REST endpoint.
  try {
    const targetUrl = `${KALSHI_API_BASE_URLS[0]}${apiPath}`;
    const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        Accept: "application/json",
        "X-Engine": "direct",
        "X-No-Cache": "true",
        "X-Return-Format": "text",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) {
      const reader = (await response.json()) as {
        data?: {
          url?: string;
          text?: string;
          httpStatus?: number;
        };
      };
      if (
        reader.data?.httpStatus === 200 &&
        reader.data.url?.startsWith(KALSHI_API_BASE_URLS[0]) &&
        typeof reader.data.text === "string"
      ) {
        console.warn("Using the public Kalshi read-through fallback");
        return JSON.parse(reader.data.text) as T;
      }
    }
    lastStatus = response.status;
  } catch (error) {
    console.warn("Kalshi read-through fallback failed", error);
  }

  throw new Error(
    `Kalshi API returned ${lastStatus ?? "an error"} for ${apiPath.slice(0, 160)}`,
  );
}

async function fetchActiveMarkets(
  seriesTickers: readonly LiveSeries[] = LIVE_SERIES,
): Promise<KalshiApiMarket[]> {
  const now = Date.now();
  const currentClose =
    (Math.floor(now / MARKET_INTERVAL_MS) + 1) * MARKET_INTERVAL_MS;
  const tickers = marketTickersForClose(currentClose, seriesTickers);
  const response = await kalshiFetch<{ markets: KalshiApiMarket[] }>(
    `/markets?limit=${tickers.length}&tickers=${encodeURIComponent(tickers.join(","))}`,
  );
  return response.markets.filter(
    (market) =>
      Number.isFinite(Date.parse(market.close_time)) &&
      Date.parse(market.close_time) > now &&
      Date.parse(market.open_time) <= now,
  );
}

async function fetchCandlesForMarkets(
  markets: KalshiApiMarket[],
): Promise<Map<string, KalshiApiCandle[]>> {
  const candlesByTicker = new Map<string, KalshiApiCandle[]>();
  if (markets.length === 0) return candlesByTicker;
  const startTimestamp =
    Math.floor(
      Math.min(...markets.map((market) => Date.parse(market.open_time))) /
        1_000,
    ) - 60;
  const endTimestamp = Math.floor(Date.now() / 1_000);
  const tickers = markets.map((market) => market.ticker).join(",");
  const response = await kalshiFetch<{
    markets: Array<{
      market_ticker: string;
      candlesticks: KalshiApiCandle[];
    }>;
  }>(
    `/markets/candlesticks?market_tickers=${encodeURIComponent(tickers)}&start_ts=${startTimestamp}&end_ts=${endTimestamp}&period_interval=1`,
  );
  response.markets.forEach((market) => {
    candlesByTicker.set(market.market_ticker, market.candlesticks);
  });
  return candlesByTicker;
}

async function fetchCandlesForMarket(
  market: KalshiApiMarket,
): Promise<KalshiApiCandle[]> {
  const startTimestamp = Math.floor(Date.parse(market.open_time) / 1_000) - 60;
  const endTimestamp = Math.min(
    Math.floor(Date.now() / 1_000),
    Math.floor(Date.parse(market.close_time) / 1_000),
  );
  const response = await kalshiFetch<{ candlesticks: KalshiApiCandle[] }>(
    `/series/${seriesFor(market)}/markets/${market.ticker}/candlesticks?start_ts=${startTimestamp}&end_ts=${endTimestamp}&period_interval=1`,
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
  settlements: KalshiSettlement[] = [],
  modelName = bundledModel.name,
): Promise<ForwardTrackingStats> {
  const now = new Date().toISOString();
  const eligible = signals.filter(
    (signal) =>
      signal.isQualified &&
      signal.secondsToClose >= 30 &&
      signal.secondsToClose <= 900,
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
          modelName,
          signal.secondsToClose,
          now,
        ),
      ),
    );
  }

  if (settlements.length > 0) {
    const pending = await env.DB.prepare(
      "SELECT * FROM paper_signals WHERE result IS NULL ORDER BY created_at ASC LIMIT 100",
    ).all<PaperSignalRow>();
    const resultByTicker = new Map(
      settlements.map((settlement) => [settlement.ticker, settlement.result]),
    );
    const updates = pending.results.flatMap((record) => {
      const result = resultByTicker.get(record.ticker);
      if (!result) return [];
      const correct = record.side.toLowerCase() === result;
      const grossProfit = correct
        ? 1 - record.entry_price
        : -record.entry_price;
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
  }

  const records = await env.DB.prepare(
    "SELECT * FROM paper_signals ORDER BY created_at DESC LIMIT 5000",
  ).all<PaperSignalRow>();
  return summarizeRecords(records.results);
}

function toEarlyObservation(signal: LiveSignal): EarlyForecastObservation {
  return {
    side: signal.side,
    yesProbability: signal.yesProbability,
    noProbability: signal.noProbability,
    confidence: signal.confidence,
    marketYesProbability: signal.marketYesProbability,
    netExpectedValue: signal.netExpectedValue,
    recommendation: signal.recommendation,
    observedAt: signal.updatedAt,
    secondsToClose: signal.secondsToClose,
    horizonMinutes: signal.horizonMinutes,
    horizonHitRate: signal.horizonHitRate,
    horizonHitRateLowerBound: signal.horizonHitRateLowerBound,
    horizonSampleSize: signal.horizonSampleSize,
    horizonConfidenceThreshold: signal.horizonConfidenceThreshold,
    isQualified: signal.isQualified,
    qualificationReason: signal.qualificationReason,
  };
}

function historicalMarketAtCandle(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  candle: KalshiApiCandle,
): KalshiApiMarket | undefined {
  const traded = numberFrom(candle.price?.close_dollars);
  const rawBid = numberFrom(candle.yes_bid?.close_dollars);
  const rawAsk = numberFrom(candle.yes_ask?.close_dollars);
  const yesBid = rawBid || traded || rawAsk;
  const yesAsk = rawAsk || traded || rawBid;
  if (yesBid <= 0 || yesAsk <= 0 || yesBid >= 1 || yesAsk >= 1) {
    return undefined;
  }
  const volume = candles.reduce(
    (sum, item) => sum + numberFrom(item.volume_fp),
    0,
  );
  return {
    ...market,
    yes_bid_dollars: yesBid.toFixed(4),
    yes_ask_dollars: yesAsk.toFixed(4),
    no_bid_dollars: clamp(1 - yesAsk, 0.001, 0.999).toFixed(4),
    no_ask_dollars: clamp(1 - yesBid, 0.001, 0.999).toFixed(4),
    last_price_dollars: (traded || (yesBid + yesAsk) / 2).toFixed(4),
    volume_fp: volume.toFixed(2),
  };
}

function historicalOpeningObservation(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  targetSecondsToClose: number,
  selectedModel: ValidatedKalshiModel,
): EarlyForecastObservation | undefined {
  const closeTimeMs = Date.parse(market.close_time);
  const openTimeMs = Date.parse(market.open_time);
  if (!Number.isFinite(closeTimeMs) || !Number.isFinite(openTimeMs)) {
    return undefined;
  }
  const observedAtMs = closeTimeMs - targetSecondsToClose * 1_000;
  if (Date.now() < observedAtMs) return undefined;
  const exactCandle = candles.find(
    (candle) => Math.abs(candle.end_period_ts * 1_000 - observedAtMs) < 1_000,
  );
  if (!exactCandle) return undefined;
  const availableCandles = candles
    .filter(
      (candle) =>
        candle.end_period_ts * 1_000 > openTimeMs &&
        candle.end_period_ts * 1_000 <= observedAtMs,
    )
    .sort((left, right) => left.end_period_ts - right.end_period_ts);
  const historicalMarket = historicalMarketAtCandle(
    market,
    availableCandles,
    exactCandle,
  );
  if (!historicalMarket || availableCandles.length === 0) return undefined;
  return toEarlyObservation(
    buildSignal(
      historicalMarket,
      availableCandles,
      selectedModel,
      observedAtMs,
    ),
  );
}

function buildOpeningObservations(
  markets: KalshiApiMarket[],
  candlesByTicker: Map<string, KalshiApiCandle[]>,
  selectedModel: ValidatedKalshiModel,
): StoredOpeningObservations[] {
  return markets.map((market) => {
    const candles = candlesByTicker.get(market.ticker) ?? [];
    return {
      ticker: market.ticker,
      initial: historicalOpeningObservation(
        market,
        candles,
        EARLY_INITIAL_TARGET_SECONDS_TO_CLOSE,
        selectedModel,
      ),
      confirmation: historicalOpeningObservation(
        market,
        candles,
        EARLY_CONFIRMATION_TARGET_SECONDS_TO_CLOSE,
        selectedModel,
      ),
    };
  });
}

function parseEarlyObservation(
  payload: string | null,
): EarlyForecastObservation | undefined {
  if (!payload) return undefined;
  try {
    const value = JSON.parse(payload) as Partial<EarlyForecastObservation>;
    return value &&
      (value.side === "YES" || value.side === "NO") &&
      Number.isFinite(value.yesProbability) &&
      Number.isFinite(value.noProbability) &&
      Number.isFinite(value.confidence) &&
      typeof value.observedAt === "string"
      ? (value as EarlyForecastObservation)
      : undefined;
  } catch {
    return undefined;
  }
}

function previousResultForMarket(
  market: StoredSnapshot["markets"][number],
  settlements: KalshiSettlement[],
): "YES" | "NO" | undefined {
  const currentClose = Date.parse(market.closeTime);
  const previous = settlements
    .filter(
      (settlement) =>
        settlement.asset === market.asset &&
        typeof settlement.closeTime === "string" &&
        Date.parse(settlement.closeTime) < currentClose,
    )
    .sort(
      (left, right) =>
        Date.parse(right.closeTime ?? "") - Date.parse(left.closeTime ?? ""),
    )[0];
  return previous ? (previous.result === "yes" ? "YES" : "NO") : undefined;
}

function earlyRecommendation(
  initial: EarlyForecastObservation | undefined,
  confirmation: EarlyForecastObservation | undefined,
): "favorable" | "wait" | "avoid" {
  if (!initial || !confirmation) return "wait";
  if (initial.side !== confirmation.side) return "avoid";
  const bothQualified = initial.isQualified && confirmation.isQualified;
  const bothAboveThreshold =
    initial.confidence >= initial.horizonConfidenceThreshold &&
    confirmation.confidence >= confirmation.horizonConfidenceThreshold;
  const conservativeEvidence =
    initial.horizonHitRateLowerBound >= 60 &&
    confirmation.horizonHitRateLowerBound >= 60;
  if (
    bothQualified &&
    bothAboveThreshold &&
    conservativeEvidence &&
    initial.recommendation === "favorable" &&
    confirmation.recommendation === "favorable" &&
    confirmation.netExpectedValue >= 3
  ) {
    return "favorable";
  }
  return confirmation.recommendation === "avoid" ? "avoid" : "wait";
}

async function updateEarlyForecastLedger(
  env: Env,
  signals: LiveSignal[],
  markets: StoredSnapshot["markets"],
  settlements: KalshiSettlement[] = [],
  recoveredObservations: StoredOpeningObservations[] = [],
): Promise<EarlyForecast[]> {
  if (settlements.length > 0) {
    const pending = await env.DB.prepare(
      "SELECT ticker FROM early_forecasts WHERE result IS NULL ORDER BY close_time DESC LIMIT 100",
    ).all<{ ticker: string }>();
    const resultByTicker = new Map(
      settlements.map((settlement) => [settlement.ticker, settlement.result]),
    );
    const resolvedAt = new Date().toISOString();
    const resolutions = pending.results.flatMap((row) => {
      const result = resultByTicker.get(row.ticker);
      return result
        ? [
            env.DB.prepare(
              "UPDATE early_forecasts SET result = ?, settled_at = ?, updated_at = ? WHERE ticker = ? AND result IS NULL",
            ).bind(result, resolvedAt, resolvedAt, row.ticker),
          ]
        : [];
    });
    if (resolutions.length > 0) await env.DB.batch(resolutions);
  }

  const signalByTicker = new Map(
    signals.map((signal) => [signal.ticker, signal]),
  );
  const currentMarkets = markets.filter((market) =>
    signalByTicker.has(market.ticker),
  );
  if (currentMarkets.length === 0) return [];

  const tickers = currentMarkets.map((market) => market.ticker);
  const placeholders = tickers.map(() => "?").join(", ");
  const existingResult = await env.DB.prepare(
    `SELECT * FROM early_forecasts WHERE ticker IN (${placeholders})`,
  )
    .bind(...tickers)
    .all<EarlyForecastRow>();
  const existingByTicker = new Map(
    existingResult.results.map((row) => [row.ticker, row]),
  );
  const recoveredByTicker = new Map(
    recoveredObservations.map((observation) => [
      observation.ticker,
      observation,
    ]),
  );
  const now = new Date().toISOString();
  const statements = currentMarkets.map((market) => {
    const signal = signalByTicker.get(market.ticker)!;
    const existing = existingByTicker.get(market.ticker);
    const observation = toEarlyObservation(signal);
    const existingInitial = parseEarlyObservation(
      existing?.initial_payload ?? null,
    );
    const recovered = recoveredByTicker.get(market.ticker);
    const candidateInitial = recovered?.initial;
    const candidateConfirmation = recovered?.confirmation;
    const observationsAreSeparated =
      Boolean(existingInitial) &&
      Date.parse(observation.observedAt) -
        Date.parse(existingInitial?.observedAt ?? observation.observedAt) >=
        45 * 1_000;
    const canRecord = signal.isQualified;
    const initialPayload =
      !existing?.initial_payload && candidateInitial
        ? JSON.stringify(candidateInitial)
        : !existing?.initial_payload &&
            canRecord &&
            signal.secondsToClose <= EARLY_INITIAL_MAX_SECONDS_TO_CLOSE &&
            signal.secondsToClose >= EARLY_INITIAL_MIN_SECONDS_TO_CLOSE
          ? JSON.stringify(observation)
          : null;
    const initialForConfirmation = existingInitial ?? candidateInitial;
    const recoveredObservationsAreSeparated =
      Boolean(initialForConfirmation && candidateConfirmation) &&
      Date.parse(candidateConfirmation?.observedAt ?? "") -
        Date.parse(initialForConfirmation?.observedAt ?? "") >=
        45 * 1_000;
    const confirmationPayload =
      !existing?.confirmation_payload &&
      candidateConfirmation &&
      recoveredObservationsAreSeparated
        ? JSON.stringify(candidateConfirmation)
        : !existing?.confirmation_payload &&
            observationsAreSeparated &&
            canRecord &&
            signal.secondsToClose <= EARLY_CONFIRMATION_MAX_SECONDS_TO_CLOSE &&
            signal.secondsToClose >= EARLY_CONFIRMATION_MIN_SECONDS_TO_CLOSE
          ? JSON.stringify(observation)
          : null;
    const previousResult = previousResultForMarket(market, settlements);
    return env.DB.prepare(
      `INSERT INTO early_forecasts (
        ticker, asset, title, close_time, previous_result,
        initial_payload, confirmation_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        previous_result = COALESCE(excluded.previous_result, early_forecasts.previous_result),
        initial_payload = COALESCE(early_forecasts.initial_payload, excluded.initial_payload),
        confirmation_payload = COALESCE(early_forecasts.confirmation_payload, excluded.confirmation_payload),
        updated_at = excluded.updated_at`,
    ).bind(
      market.ticker,
      market.asset,
      market.title,
      market.closeTime,
      previousResult ?? null,
      initialPayload,
      confirmationPayload,
      now,
      now,
    );
  });
  await env.DB.batch(statements);

  const saved = await env.DB.prepare(
    `SELECT * FROM early_forecasts WHERE ticker IN (${placeholders})`,
  )
    .bind(...tickers)
    .all<EarlyForecastRow>();
  const savedByTicker = new Map(saved.results.map((row) => [row.ticker, row]));

  return currentMarkets.map((market) => {
    const signal = signalByTicker.get(market.ticker)!;
    const row = savedByTicker.get(market.ticker);
    const initial = parseEarlyObservation(row?.initial_payload ?? null);
    const confirmation = parseEarlyObservation(
      row?.confirmation_payload ?? null,
    );
    return {
      ticker: market.ticker,
      asset: market.asset,
      title: market.title,
      closeTime: market.closeTime,
      previousResult: row?.previous_result ?? undefined,
      phase: confirmation ? "confirmed" : initial ? "initial" : "preliminary",
      agreement: confirmation
        ? initial?.side === confirmation.side
          ? "confirmed"
          : "revised"
        : "pending",
      recommendation: earlyRecommendation(initial, confirmation),
      initial,
      confirmation,
      current: toEarlyObservation(signal),
    } satisfies EarlyForecast;
  });
}

export async function generateLiveMarketSnapshot(
  selectedModel: ValidatedKalshiModel = bundledModel,
  seriesTickers: readonly LiveSeries[] = LIVE_SERIES,
): Promise<StoredSnapshot> {
  const apiMarkets = await fetchActiveMarkets(seriesTickers);
  let candlesByTicker = new Map<string, KalshiApiCandle[]>();
  try {
    candlesByTicker = await fetchCandlesForMarkets(apiMarkets);
  } catch (error) {
    console.warn("Unable to load live candlesticks", error);
    const fallbackResults = await Promise.allSettled(
      apiMarkets.map(async (market) => ({
        ticker: market.ticker,
        candles: await fetchCandlesForMarket(market),
      })),
    );
    fallbackResults.forEach((result) => {
      if (result.status === "fulfilled") {
        candlesByTicker.set(result.value.ticker, result.value.candles);
      } else {
        console.warn(
          "Unable to load individual candle fallback",
          result.reason,
        );
      }
    });
  }
  const preferredChartMarket =
    apiMarkets.find((market) => market.ticker.startsWith("KXBTC15M")) ??
    apiMarkets[0];
  const priceHistory = preferredChartMarket
    ? (candlesByTicker.get(preferredChartMarket.ticker) ?? [])
        .sort((left, right) => left.end_period_ts - right.end_period_ts)
        .map(toPricePoint)
    : [];
  const signals = apiMarkets.map((market) =>
    buildSignal(
      market,
      candlesByTicker.get(market.ticker) ?? [],
      selectedModel,
    ),
  );
  const openingObservations = buildOpeningObservations(
    apiMarkets,
    candlesByTicker,
    selectedModel,
  );

  return {
    markets: apiMarkets.map(toDashboardMarket),
    signals,
    priceHistory,
    openingObservations,
    asOf: new Date().toISOString(),
    model: selectedModel,
  };
}

export async function fetchRecentSettlements(
  seriesTickers: readonly LiveSeries[] = LIVE_SERIES,
): Promise<KalshiSettlement[]> {
  const latestClosed =
    Math.floor(Date.now() / MARKET_INTERVAL_MS) * MARKET_INTERVAL_MS;
  const tickers = Array.from({ length: 8 }, (_, index) =>
    marketTickersForClose(
      latestClosed - index * MARKET_INTERVAL_MS,
      seriesTickers,
    ),
  ).flat();
  const response = await kalshiFetch<{ markets: KalshiApiMarket[] }>(
    `/markets?limit=${tickers.length}&tickers=${encodeURIComponent(tickers.join(","))}`,
  );
  return response.markets.flatMap((market) =>
    market.result === "yes" || market.result === "no"
      ? [
          {
            ticker: market.ticker,
            result: market.result,
            asset: assetFor(market),
            closeTime: market.close_time,
          },
        ]
      : [],
  );
}

async function readStoredSnapshot(
  env: Env,
): Promise<StoredSnapshot | undefined> {
  const row = await env.DB.prepare(
    "SELECT payload FROM live_snapshots WHERE id = 1",
  ).first<{ payload: string }>();
  if (!row) return undefined;
  const parsed: unknown = JSON.parse(row.payload);
  // Keep the last verified D1 snapshot as a resilience fallback if GitHub or
  // Kalshi is temporarily unavailable. Freshness is enforced for published
  // snapshots, while the UI still exposes the original `asOf` timestamp.
  return isStoredSnapshot(parsed, true) ? parsed : undefined;
}

async function writeStoredSnapshot(
  env: Env,
  snapshot: StoredSnapshot,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO live_snapshots (id, payload, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(snapshot), snapshot.asOf)
    .run();
}

function snapshotAgeMs(snapshot: StoredSnapshot): number {
  return Math.max(0, Date.now() - Date.parse(snapshot.asOf));
}

function snapshotFreshness(snapshot: StoredSnapshot): DataFreshness {
  const age = snapshotAgeMs(snapshot);
  if (age <= FRESH_SNAPSHOT_MS) return "live";
  if (age <= DELAYED_SNAPSHOT_MS) return "delayed";
  return "stale";
}

function removeExpiredMarkets(snapshot: StoredSnapshot): StoredSnapshot {
  const now = Date.now();
  const markets = snapshot.markets.filter(
    (market) =>
      Number.isFinite(Date.parse(market.closeTime)) &&
      Date.parse(market.closeTime) > now,
  );
  const tickers = new Set(markets.map((market) => market.ticker));
  return {
    ...snapshot,
    markets,
    openingObservations: snapshot.openingObservations?.filter((observation) =>
      tickers.has(observation.ticker),
    ),
    signals: refreshSignalTimers(
      snapshot.signals.filter((signal) => tickers.has(signal.ticker)),
      markets,
    ),
  };
}

function isUsableFreshSnapshot(
  snapshot: StoredSnapshot | undefined,
): snapshot is StoredSnapshot {
  if (!snapshot || snapshotAgeMs(snapshot) > FRESH_SNAPSHOT_MS) return false;
  return snapshot.markets.some(
    (market) => Date.parse(market.closeTime) > Date.now(),
  );
}

async function fetchPublishedSnapshot(): Promise<{
  snapshot: StoredSnapshot;
  settlements: KalshiSettlement[];
}> {
  const publishedUrl = new URL(PUBLISHED_SNAPSHOT_URL);
  publishedUrl.searchParams.set(
    "refresh",
    Math.floor(Date.now() / 60_000).toString(),
  );
  const response = await fetch(publishedUrl, {
    headers: { Accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 60 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const published = (await response.json()) as {
    snapshot?: unknown;
    settlements?: unknown;
  };
  if (!isStoredSnapshot(published.snapshot)) {
    throw new Error("Published snapshot is invalid or stale");
  }
  const settlements = Array.isArray(published.settlements)
    ? published.settlements.filter(
        (item): item is KalshiSettlement =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as KalshiSettlement).ticker === "string" &&
          ((item as KalshiSettlement).result === "yes" ||
            (item as KalshiSettlement).result === "no"),
      )
    : [];
  return { snapshot: published.snapshot, settlements };
}

function mergeSnapshots(
  previous: StoredSnapshot | undefined,
  incoming: StoredSnapshot,
  refreshedSeries: readonly LiveSeries[],
): StoredSnapshot {
  if (!previous) return incoming;
  const refreshedAssets = new Set(
    refreshedSeries.map((seriesTicker) => ASSET_BY_SERIES[seriesTicker]),
  );
  const currentPrevious = removeExpiredMarkets(previous);
  return {
    ...incoming,
    markets: [
      ...currentPrevious.markets.filter(
        (market) => !refreshedAssets.has(market.asset),
      ),
      ...incoming.markets,
    ],
    signals: [
      ...currentPrevious.signals.filter(
        (signal) => !refreshedAssets.has(signal.asset),
      ),
      ...incoming.signals,
    ],
    openingObservations: [
      ...(currentPrevious.openingObservations ?? []).filter((observation) => {
        const market = currentPrevious.markets.find(
          (candidate) => candidate.ticker === observation.ticker,
        );
        return market && !refreshedAssets.has(market.asset);
      }),
      ...(incoming.openingObservations ?? []),
    ],
    priceHistory: refreshedAssets.has("BTC")
      ? incoming.priceHistory
      : currentPrevious.priceHistory,
  };
}

async function refreshLiveSnapshot(
  env: Env,
  seriesTickers: readonly LiveSeries[] = LIVE_SERIES,
  includeSettlements = true,
): Promise<void> {
  const incoming = await generateLiveMarketSnapshot(
    bundledModel,
    seriesTickers,
  );
  let previous: StoredSnapshot | undefined;
  try {
    previous = await readStoredSnapshot(env);
  } catch (error) {
    console.warn("Unable to merge the previous snapshot", error);
  }
  const snapshot = mergeSnapshots(previous, incoming, seriesTickers);
  let settlements: KalshiSettlement[] = [];
  if (includeSettlements) {
    try {
      settlements = await fetchRecentSettlements(seriesTickers);
    } catch (error) {
      console.warn("Unable to refresh recent settlements", error);
    }
  }
  await writeStoredSnapshot(env, snapshot);
  const current = removeExpiredMarkets(snapshot);
  await updatePaperSignalLedger(
    env,
    current.signals,
    settlements,
    snapshot.model.name,
  );
  await updateEarlyForecastLedger(
    env,
    current.signals,
    current.markets,
    settlements,
    current.openingObservations,
  );
}

function isEarlyContractWindow(snapshot: StoredSnapshot): boolean {
  return snapshot.markets.some((market) => {
    const secondsToClose = Math.floor(
      (Date.parse(market.closeTime) - Date.now()) / 1_000,
    );
    return (
      secondsToClose >= EARLY_CONFIRMATION_MIN_SECONDS_TO_CLOSE &&
      secondsToClose <= EARLY_INITIAL_MAX_SECONDS_TO_CLOSE
    );
  });
}

async function refreshDirectlyWhenNeeded(
  env: Env,
  stored: StoredSnapshot | undefined,
): Promise<StoredSnapshot | undefined> {
  const current = stored ? removeExpiredMarkets(stored) : undefined;
  const needsCurrentContract = !current?.markets.length;
  const needsEarlyReading =
    Boolean(current?.markets.length) &&
    isEarlyContractWindow(current!) &&
    snapshotAgeMs(current!) > DIRECT_EARLY_REFRESH_MAX_AGE_MS;
  if (!needsCurrentContract && !needsEarlyReading) return stored;

  try {
    const incoming = await generateLiveMarketSnapshot();
    const merged = mergeSnapshots(stored, incoming, LIVE_SERIES);
    await writeStoredSnapshot(env, merged);
    return merged;
  } catch (error) {
    console.warn(
      "Unable to obtain the rollover or early Kalshi reading",
      error,
    );
    return stored;
  }
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

  let stored: StoredSnapshot | undefined;
  let settlements: KalshiSettlement[] = [];
  try {
    stored = await readStoredSnapshot(env);
  } catch (error) {
    console.warn("Unable to read the stored Kalshi snapshot", error);
  }
  if (!isUsableFreshSnapshot(stored)) {
    try {
      const published = await fetchPublishedSnapshot();
      if (isUsableFreshSnapshot(published.snapshot)) {
        stored = published.snapshot;
        settlements = published.settlements;
        await writeStoredSnapshot(env, stored);
      }
    } catch (error) {
      console.warn("Unable to load a fresh published Kalshi snapshot", error);
    }
  }
  if (!stored) {
    try {
      const live = await generateLiveMarketSnapshot();
      stored = live;
      await writeStoredSnapshot(env, live);
    } catch (error) {
      console.error("Unable to refresh directly from Kalshi", error);
    }
  }
  stored = await refreshDirectlyWhenNeeded(env, stored);
  if (!stored) throw new Error("No verified Kalshi snapshot is available");
  const current = removeExpiredMarkets(stored);
  const dataFreshness = snapshotFreshness(current);
  const currentSignals = current.signals;
  const liveTracking = await updatePaperSignalLedger(
    env,
    currentSignals,
    settlements,
    stored.model.name,
  );
  const earlyForecasts = await updateEarlyForecastLedger(
    env,
    currentSignals,
    current.markets,
    settlements,
    current.openingObservations,
  );
  const snapshot: LiveSnapshot = {
    ...current,
    signals: currentSignals,
    dataFreshness,
    dataAgeSeconds: Math.floor(snapshotAgeMs(current) / 1_000),
    liveTracking,
    earlyForecasts,
  };
  const cachedResponse = new Response(JSON.stringify(snapshot), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${SNAPSHOT_CACHE_SECONDS}`,
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));
  return snapshot;
}

async function syncPublishedSnapshot(env: Env): Promise<void> {
  const published = await fetchPublishedSnapshot();
  if (!isUsableFreshSnapshot(published.snapshot)) return;

  const stored = await readStoredSnapshot(env);
  if (
    stored &&
    Date.parse(stored.asOf) >= Date.parse(published.snapshot.asOf)
  ) {
    return;
  }

  await writeStoredSnapshot(env, published.snapshot);
  const current = removeExpiredMarkets(published.snapshot);
  await updatePaperSignalLedger(
    env,
    current.signals,
    published.settlements,
    published.snapshot.model.name,
  );
  await updateEarlyForecastLedger(
    env,
    current.signals,
    current.markets,
    published.settlements,
    current.openingObservations,
  );
}

async function maintainLiveSnapshot(env: Env): Promise<void> {
  try {
    await syncPublishedSnapshot(env);
  } catch (error) {
    console.warn("Unable to synchronize the published Kalshi snapshot", error);
  }

  let stored: StoredSnapshot | undefined;
  try {
    stored = await readStoredSnapshot(env);
  } catch (error) {
    console.warn(
      "Unable to read the snapshot during scheduled maintenance",
      error,
    );
  }
  const current = stored ? removeExpiredMarkets(stored) : undefined;
  if (
    !current?.markets.length ||
    (isEarlyContractWindow(current) &&
      snapshotAgeMs(current) > DIRECT_EARLY_REFRESH_MAX_AGE_MS)
  ) {
    await refreshLiveSnapshot(env);
  }
}

function isStoredSnapshot(
  value: unknown,
  allowStale = false,
): value is StoredSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSnapshot>;
  const timestamp = Date.parse(candidate.asOf ?? "");
  return (
    Number.isFinite(timestamp) &&
    timestamp <= Date.now() + 5 * 60 * 1_000 &&
    (allowStale || timestamp >= Date.now() - 2 * 60 * 60 * 1_000) &&
    Array.isArray(candidate.markets) &&
    Array.isArray(candidate.signals) &&
    candidate.signals.every(
      (signal) =>
        Number.isFinite(signal.yesProbability) &&
        Number.isFinite(signal.noProbability) &&
        typeof signal.dataQualityOk === "boolean" &&
        typeof signal.isQualified === "boolean",
    ) &&
    Array.isArray(candidate.priceHistory) &&
    (candidate.openingObservations === undefined ||
      (Array.isArray(candidate.openingObservations) &&
        candidate.openingObservations.every(
          (observation) =>
            Boolean(observation) &&
            typeof observation.ticker === "string" &&
            (observation.initial === undefined ||
              isEarlyObservation(observation.initial)) &&
            (observation.confirmation === undefined ||
              isEarlyObservation(observation.confirmation)),
        ))) &&
    isValidatedModel(candidate.model)
  );
}

function isEarlyObservation(value: unknown): value is EarlyForecastObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Partial<EarlyForecastObservation>;
  return (
    (observation.side === "YES" || observation.side === "NO") &&
    Number.isFinite(observation.yesProbability) &&
    Number.isFinite(observation.noProbability) &&
    Number.isFinite(observation.confidence) &&
    typeof observation.observedAt === "string" &&
    Number.isFinite(Date.parse(observation.observedAt))
  );
}

function isValidatedModel(value: unknown): value is ValidatedKalshiModel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ValidatedKalshiModel>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.trainedAt === "string" &&
    Number.isFinite(candidate.trainingMarkets) &&
    Number.isFinite(candidate.calibrationMarkets) &&
    Number.isFinite(candidate.evaluationMarkets) &&
    Number.isFinite(candidate.hitRate) &&
    Number.isFinite(candidate.hitRateLowerBound) &&
    Number.isFinite(candidate.brierScore) &&
    Number.isFinite(candidate.marketBrierScore) &&
    Number.isFinite(candidate.brierSkillScore) &&
    Number.isFinite(candidate.expectedCalibrationError) &&
    Number.isFinite(candidate.confidenceThreshold) &&
    Array.isArray(candidate.weights) &&
    Array.isArray(candidate.means) &&
    Array.isArray(candidate.standardDeviations) &&
    candidate.weights.length === candidate.means.length + 1 &&
    candidate.means.length === candidate.standardDeviations.length &&
    Array.isArray(candidate.assetStats) &&
    Array.isArray(candidate.reliableAssets) &&
    Array.isArray(candidate.horizons) &&
    // Accept the immediately preceding eight-horizon snapshot during a
    // rolling deploy. Publication gates still require all nine v5 horizons,
    // so this only prevents a transient outage while edge caches converge.
    candidate.horizons.length >= 8 &&
    candidate.horizons.every(
      (horizon) =>
        Number.isFinite(horizon.targetSeconds) &&
        Number.isFinite(horizon.evaluationMarkets) &&
        Number.isFinite(horizon.holdoutMarkets) &&
        Number.isFinite(horizon.hitRate) &&
        Number.isFinite(horizon.hitRateLowerBound) &&
        Number.isFinite(horizon.expectedCalibrationError) &&
        Number.isFinite(horizon.confidenceThreshold) &&
        Array.isArray(horizon.reliableAssets) &&
        Array.isArray(horizon.assetStats),
    )
  );
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function dashboardResponse(snapshot: LiveSnapshot, url: URL) {
  const activeModel = snapshot.model;
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
  const rankedSignals = snapshot.signals
    .filter((signal) => !category || signal.category === category)
    .sort((left, right) => right.score - left.score);
  const filteredSignals = rankedSignals.filter(
    (signal) => signal.confidence >= minConfidence,
  );
  const filterFallbackActive =
    filteredSignals.length === 0 && rankedSignals.length > 0;
  const signals = (
    filterFallbackActive ? rankedSignals : filteredSignals
  ).slice(0, limit);
  const horizonMinutes = signals[0]?.horizonMinutes;
  const activeHorizon = activeModel.horizons.find(
    (horizon) => horizon.targetSeconds === (horizonMinutes ?? 5) * 60,
  );
  const evaluation = activeHorizon ?? activeModel;
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
    source: `Kalshi public REST API · continuous GitHub refresh synchronized by Cloudflare · ${activeModel.name}`,
    isLive: snapshot.dataFreshness === "live" && markets.length > 0,
    dataFreshness: snapshot.dataFreshness,
    dataAgeSeconds: snapshot.dataAgeSeconds,
    hasUsablePredictions: signals.some((signal) => signal.isQualified),
    filterFallbackActive,
    totalMarkets: markets.length,
    activeSignals: signals.length,
    averageConfidence,
    backtestHitRate: evaluation.hitRate,
    hitRateLowerBound: evaluation.hitRateLowerBound,
    simulatedReturn: evaluation.grossPaperReturn,
    netSimulatedReturn: evaluation.netPaperReturn,
    modelName: activeModel.name,
    modelTrainedAt: activeModel.trainedAt,
    trainingMarkets: activeModel.trainingMarkets,
    calibrationMarkets: activeModel.calibrationMarkets,
    evaluationMarkets: evaluation.evaluationMarkets,
    backtestSampleSize: evaluation.holdoutMarkets,
    baselineHitRate: evaluation.baselineHitRate,
    brierScore: evaluation.brierScore,
    marketBrierScore: evaluation.marketBrierScore,
    brierSkillScore: evaluation.brierSkillScore,
    logLoss: evaluation.logLoss,
    expectedCalibrationError: evaluation.expectedCalibrationError,
    signalCoverage: evaluation.signalCoverage,
    confidenceThreshold: evaluation.confidenceThreshold,
    assetStats: evaluation.assetStats.map((stats) => {
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
    earlyForecasts: snapshot.earlyForecasts,
    signals,
    priceHistory: snapshot.priceHistory,
    performance: evaluation.performance,
    markets,
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/kalshi/dashboard") {
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      try {
        const snapshot = await getLiveSnapshot(env, request, ctx);
        return json(dashboardResponse(snapshot, url));
      } catch (error) {
        console.error("Unable to load live Kalshi dashboard", error);
        return json({ error: "Unable to load live Kalshi data" }, 502);
      }
    }

    if (url.pathname === "/api/kalshi/markets") {
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
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
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(maintainLiveSnapshot(env));
  },
} satisfies ExportedHandler<Env>;
