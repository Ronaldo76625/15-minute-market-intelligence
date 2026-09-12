import { Router, type IRouter } from "express";
import {
  GetKalshiDashboardQueryParams,
  GetKalshiDashboardResponse,
  ListKalshiMarketsResponse,
} from "@workspace/api-zod";
import {
  getValidatedKalshiModel,
  predictLiveMarket,
  type KalshiApiCandle,
  type KalshiApiMarket,
  type ValidatedKalshiModel,
} from "../services/kalshi-model";
import {
  updatePaperSignalLedger,
  type ForwardTrackingStats,
} from "../services/paper-signal-ledger";

const router: IRouter = Router();

const KALSHI_API_BASE_URL =
  process.env.KALSHI_API_BASE_URL ??
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
const CACHE_TTL_MS = 5_000;

type LiveMarket = ReturnType<typeof toDashboardMarket>;
type LiveSignal = ReturnType<typeof buildSignal>;
type PricePoint = ReturnType<typeof toPricePoint>;
type LiveSnapshot = {
  markets: LiveMarket[];
  signals: LiveSignal[];
  priceHistory: PricePoint[];
  asOf: string;
  model: ValidatedKalshiModel;
  liveTracking: ForwardTrackingStats;
};

let snapshotCache: { expiresAt: number; value: LiveSnapshot } | undefined;
let snapshotPromise: Promise<LiveSnapshot> | undefined;

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

function buildSignal(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  model: ValidatedKalshiModel,
) {
  const secondsToClose = Math.max(
    0,
    Math.floor((Date.parse(market.close_time) - Date.now()) / 1_000),
  );
  const prediction = predictLiveMarket(market, candles, model);
  const side =
    prediction.yesProbability >= 0.5 ? ("YES" as const) : ("NO" as const);
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
  const estimatedFee = KALSHI_TAKER_FEE_RATE * entryPrice * (1 - entryPrice);
  const netExpectedValue =
    entryPrice > 0
      ? ((modelProbability / 100 - entryPrice - estimatedFee) /
          (entryPrice + estimatedFee)) *
        100
      : 0;
  const asset = assetFor(market);
  const assetHistory = model.assetStats.find((stats) => stats.asset === asset);
  const qualifiedConfidence = confidence >= (model.confidenceThreshold ?? 60);
  const validationApproved = (model.reliableAssets ?? []).includes(asset);
  const recommendation =
    validationApproved && qualifiedConfidence && netExpectedValue >= 3
      ? ("favorable" as const)
      : qualifiedConfidence && netExpectedValue > 0
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
      (candles.at(-1)?.end_period_ts ?? Math.floor(Date.now() / 1_000)) * 1_000,
    ).toISOString(),
    secondsToClose,
  };
}

async function kalshiFetch<T>(path: string): Promise<T> {
  const safePath = path.length > 180 ? `${path.slice(0, 177)}...` : path;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${KALSHI_API_BASE_URL}${path}`, {
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
    `Kalshi API returned ${lastStatus ?? "an error"} for ${safePath}`,
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

async function fetchCandles(
  market: KalshiApiMarket,
): Promise<KalshiApiCandle[]> {
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

async function buildLiveSnapshot(): Promise<LiveSnapshot> {
  const [apiMarkets, model] = await Promise.all([
    fetchActiveMarkets(),
    getValidatedKalshiModel(kalshiFetch),
  ]);
  const candlesByTicker = new Map<string, KalshiApiCandle[]>();
  await Promise.all(
    apiMarkets.map(async (market) => {
      try {
        candlesByTicker.set(market.ticker, await fetchCandles(market));
      } catch {
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
    buildSignal(market, candlesByTicker.get(market.ticker) ?? [], model),
  );
  const liveTracking = await updatePaperSignalLedger(
    kalshiFetch,
    signals.map((signal) => ({
      ticker: signal.ticker,
      asset: signal.asset,
      side: signal.side,
      entryPrice: signal.entryPrice,
      modelProbability: signal.modelProbability,
      estimatedFee: signal.estimatedFee,
      modelName: model.name,
      secondsToClose: signal.secondsToClose,
    })),
  );
  const value: LiveSnapshot = {
    markets: apiMarkets.map(toDashboardMarket),
    signals,
    priceHistory,
    asOf: new Date().toISOString(),
    model,
    liveTracking,
  };
  snapshotCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}

async function getLiveSnapshot(): Promise<LiveSnapshot> {
  if (snapshotCache && snapshotCache.expiresAt > Date.now()) {
    return snapshotCache.value;
  }
  if (snapshotPromise) return snapshotPromise;

  snapshotPromise = buildLiveSnapshot().finally(() => {
    snapshotPromise = undefined;
  });
  return snapshotPromise;
}

router.get("/kalshi/dashboard", async (req, res): Promise<void> => {
  const parsed = GetKalshiDashboardQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Invalid Kalshi dashboard query",
    );
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const { category, minConfidence, limit } = parsed.data;
    const snapshot = await getLiveSnapshot();
    const filteredSignals = snapshot.signals
      .filter((signal) => !category || signal.category === category)
      .filter((signal) => signal.confidence >= minConfidence)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    const filteredMarkets = snapshot.markets.filter(
      (market) => !category || market.category === category,
    );
    const averageConfidence =
      filteredSignals.length > 0
        ? Math.round(
            filteredSignals.reduce(
              (sum, signal) => sum + signal.confidence,
              0,
            ) / filteredSignals.length,
          )
        : 0;

    res.json(
      GetKalshiDashboardResponse.parse({
        asOf: snapshot.asOf,
        source: `Kalshi public REST API · ${snapshot.model.name}`,
        isLive: true,
        totalMarkets: filteredMarkets.length,
        activeSignals: filteredSignals.length,
        averageConfidence,
        backtestHitRate: snapshot.model.hitRate,
        hitRateLowerBound: snapshot.model.hitRateLowerBound,
        simulatedReturn: snapshot.model.grossPaperReturn,
        netSimulatedReturn: snapshot.model.netPaperReturn,
        modelName: snapshot.model.name,
        modelTrainedAt: snapshot.model.trainedAt,
        trainingMarkets: snapshot.model.trainingMarkets,
        calibrationMarkets: snapshot.model.calibrationMarkets,
        evaluationMarkets: snapshot.model.evaluationMarkets,
        backtestSampleSize: snapshot.model.holdoutMarkets,
        baselineHitRate: snapshot.model.baselineHitRate,
        brierScore: snapshot.model.brierScore,
        marketBrierScore: snapshot.model.marketBrierScore,
        brierSkillScore: snapshot.model.brierSkillScore,
        logLoss: snapshot.model.logLoss,
        expectedCalibrationError: snapshot.model.expectedCalibrationError,
        signalCoverage: snapshot.model.signalCoverage,
        confidenceThreshold: snapshot.model.confidenceThreshold,
        assetStats: snapshot.model.assetStats.map((stats) => {
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
        signals: filteredSignals,
        priceHistory: snapshot.priceHistory,
        performance: snapshot.model.performance,
        markets: filteredMarkets,
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to load live Kalshi data");
    res.status(502).json({ error: "Unable to load live Kalshi data" });
  }
});

router.get("/kalshi/markets", async (req, res): Promise<void> => {
  try {
    const snapshot = await getLiveSnapshot();
    res.json(ListKalshiMarketsResponse.parse(snapshot.markets));
  } catch (error) {
    req.log.error({ err: error }, "Unable to list live Kalshi markets");
    res.status(502).json({ error: "Unable to list live Kalshi markets" });
  }
});

export default router;
