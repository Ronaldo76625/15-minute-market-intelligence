const SERIES = [
  "KXBTC15M",
  "KXETH15M",
  "KXSOL15M",
  "KXXRP15M",
  "KXDOGE15M",
  "KXBNB15M",
  "KXHYPE15M",
] as const;
const MARKETS_PER_SERIES = 100;
const MAX_CANDLES_PER_BATCH = 9_000;
const HOLDOUT_FRACTION = 0.2;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1_000;
const FEATURE_COUNT = 6 + (SERIES.length - 1);
const KALSHI_TAKER_FEE_RATE = 0.07;

const ASSET_BY_SERIES: Record<(typeof SERIES)[number], string> = {
  KXBTC15M: "BTC",
  KXETH15M: "ETH",
  KXSOL15M: "SOL",
  KXXRP15M: "XRP",
  KXDOGE15M: "DOGE",
  KXBNB15M: "BNB",
  KXHYPE15M: "HYPE",
};

export type KalshiApiMarket = {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  status: string;
  open_time: string;
  close_time: string;
  settlement_ts?: string;
  result?: "yes" | "no" | "";
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  liquidity_dollars?: string;
};

type CandleQuote = {
  open_dollars?: string;
  high_dollars?: string;
  low_dollars?: string;
  close_dollars?: string;
};

export type KalshiApiCandle = {
  end_period_ts: number;
  volume_fp?: string;
  open_interest_fp?: string;
  yes_bid?: CandleQuote;
  yes_ask?: CandleQuote;
  price?: CandleQuote & {
    mean_dollars?: string;
    previous_dollars?: string;
  };
};

export type KalshiFetcher = <T>(path: string) => Promise<T>;

type TrainingSample = {
  features: number[];
  label: 0 | 1;
};

type MarketEvaluation = {
  asset: string;
  seriesTicker: string;
  closeTime: number;
  probability: number;
  marketProbability: number;
  label: 0 | 1;
  correct: boolean;
  baselineCorrect: boolean;
  entryPrice: number;
  profit: number;
  estimatedFee: number;
  netProfit: number;
};

export type ModelPerformancePoint = {
  label: string;
  cumulativeReturn: number;
  hitRate: number;
  trades: number;
};

export type AssetBacktestStats = {
  asset: string;
  seriesTicker: string;
  sampleSize: number;
  hitRate: number;
  grossReturn: number;
  netReturn: number;
  averageNetProfitCents: number;
  maxDrawdown: number;
  profitable: boolean;
};

export type ValidatedKalshiModel = {
  name: string;
  trainedAt: string;
  trainingMarkets: number;
  holdoutMarkets: number;
  hitRate: number;
  baselineHitRate: number;
  brierScore: number;
  grossPaperReturn: number;
  netPaperReturn: number;
  assetStats: AssetBacktestStats[];
  performance: ModelPerformancePoint[];
  weights: number[];
  means: number[];
  standardDeviations: number[];
};

export type LivePrediction = {
  yesProbability: number;
  marketYesProbability: number;
  spread: number;
};

let modelCache:
  | { expiresAt: number; value: ValidatedKalshiModel }
  | undefined;
let trainingPromise: Promise<ValidatedKalshiModel> | undefined;

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

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logit(probability: number): number {
  const safeProbability = clamp(probability, 0.01, 0.99);
  return Math.log(safeProbability / (1 - safeProbability));
}

function assetIndicators(market: KalshiApiMarket): number[] {
  return SERIES.slice(1).map((seriesTicker) =>
    market.ticker.startsWith(seriesTicker) ? 1 : 0,
  );
}

function seriesTickerForMarket(
  market: KalshiApiMarket,
): (typeof SERIES)[number] {
  return (
    SERIES.find((seriesTicker) => market.ticker.startsWith(seriesTicker)) ??
    SERIES[0]
  );
}

function estimatedTakerFee(price: number): number {
  return KALSHI_TAKER_FEE_RATE * price * (1 - price);
}

function quoteFromCandle(candle: KalshiApiCandle) {
  const bid = numberFrom(candle.yes_bid?.close_dollars);
  const ask = numberFrom(candle.yes_ask?.close_dollars);
  const traded = numberFrom(candle.price?.close_dollars);
  const probability =
    bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid || traded;
  return {
    probability: clamp(probability, 0.001, 0.999),
    bid,
    ask,
    spread: bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 0,
  };
}

function quoteFromMarket(market: KalshiApiMarket) {
  const bid = numberFrom(market.yes_bid_dollars);
  const ask = numberFrom(market.yes_ask_dollars);
  const traded = numberFrom(market.last_price_dollars);
  const probability =
    bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid || traded;
  return {
    probability: clamp(probability, 0.001, 0.999),
    bid,
    ask,
    spread: bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 0,
  };
}

function orderedCandles(candles: KalshiApiCandle[]): KalshiApiCandle[] {
  return [...candles].sort(
    (left, right) => left.end_period_ts - right.end_period_ts,
  );
}

function featuresAtIndex(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  index: number,
): number[] | undefined {
  const current = candles[index];
  if (!current) return undefined;
  const currentQuote = quoteFromCandle(current);
  const firstQuote = quoteFromCandle(candles[0]);
  const shortQuote = quoteFromCandle(candles[Math.max(0, index - 3)]);
  const openTimestamp = Date.parse(market.open_time) / 1_000;
  const closeTimestamp = Date.parse(market.close_time) / 1_000;
  const duration = Math.max(1, closeTimestamp - openTimestamp);
  const elapsed = clamp(
    (current.end_period_ts - openTimestamp) / duration,
    0,
    1,
  );
  const volume = candles
    .slice(0, index + 1)
    .reduce((sum, candle) => sum + numberFrom(candle.volume_fp), 0);

  if (!Number.isFinite(currentQuote.probability)) return undefined;
  return [
    logit(currentQuote.probability),
    (currentQuote.probability - firstQuote.probability) * 10,
    (currentQuote.probability - shortQuote.probability) * 10,
    currentQuote.spread * 10,
    elapsed,
    Math.log1p(volume) / 10,
    ...assetIndicators(market),
  ];
}

function trainingSamplesForMarket(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
): TrainingSample[] {
  if (market.result !== "yes" && market.result !== "no") return [];
  const ordered = orderedCandles(candles);
  const openTimestamp = Date.parse(market.open_time) / 1_000;
  const closeTimestamp = Date.parse(market.close_time) / 1_000;
  const label = market.result === "yes" ? 1 : 0;
  const samples: TrainingSample[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const timestamp = ordered[index].end_period_ts;
    if (timestamp < openTimestamp + 120 || timestamp > closeTimestamp - 120) {
      continue;
    }
    const features = featuresAtIndex(market, ordered, index);
    if (features) samples.push({ features, label });
  }
  return samples;
}

function fiveMinuteObservation(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
) {
  const ordered = orderedCandles(candles);
  const targetTimestamp = Date.parse(market.close_time) / 1_000 - 300;
  let selectedIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].end_period_ts <= targetTimestamp) selectedIndex = index;
  }
  if (selectedIndex < 1) return undefined;
  const features = featuresAtIndex(market, ordered, selectedIndex);
  if (!features) return undefined;
  return { features, candle: ordered[selectedIndex] };
}

function featureStatistics(samples: TrainingSample[]) {
  const means = Array.from({ length: FEATURE_COUNT }, () => 0);
  for (const sample of samples) {
    sample.features.forEach((value, index) => {
      means[index] += value / samples.length;
    });
  }
  const standardDeviations = means.map((mean, index) => {
    const variance = samples.reduce(
      (sum, sample) => sum + (sample.features[index] - mean) ** 2,
      0,
    );
    return Math.max(Math.sqrt(variance / samples.length), 1e-6);
  });
  return { means, standardDeviations };
}

function standardizedFeatures(
  features: number[],
  means: number[],
  standardDeviations: number[],
): number[] {
  return features.map(
    (value, index) =>
      (value - means[index]) / standardDeviations[index],
  );
}

function trainLogisticRegression(
  samples: TrainingSample[],
  means: number[],
  standardDeviations: number[],
): number[] {
  const weights = Array.from({ length: FEATURE_COUNT + 1 }, () => 0);
  const learningRate = 0.08;
  const regularization = 0.004;

  for (let iteration = 0; iteration < 700; iteration += 1) {
    const gradients = Array.from({ length: weights.length }, () => 0);
    for (const sample of samples) {
      const features = standardizedFeatures(
        sample.features,
        means,
        standardDeviations,
      );
      const score = features.reduce(
        (sum, feature, index) => sum + feature * weights[index + 1],
        weights[0],
      );
      const error = sigmoid(score) - sample.label;
      gradients[0] += error;
      features.forEach((feature, index) => {
        gradients[index + 1] += error * feature;
      });
    }

    weights[0] -= (learningRate * gradients[0]) / samples.length;
    for (let index = 1; index < weights.length; index += 1) {
      const gradient =
        gradients[index] / samples.length + regularization * weights[index];
      weights[index] -= learningRate * gradient;
    }
  }
  return weights;
}

function predictWithWeights(
  features: number[],
  weights: number[],
  means: number[],
  standardDeviations: number[],
): number {
  const standardized = standardizedFeatures(
    features,
    means,
    standardDeviations,
  );
  const score = standardized.reduce(
    (sum, feature, index) => sum + feature * weights[index + 1],
    weights[0],
  );
  return clamp(sigmoid(score), 0.01, 0.99);
}

function evaluateMarket(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  weights: number[],
  means: number[],
  standardDeviations: number[],
): MarketEvaluation | undefined {
  if (market.result !== "yes" && market.result !== "no") return undefined;
  const observation = fiveMinuteObservation(market, candles);
  if (!observation) return undefined;
  const probability = predictWithWeights(
    observation.features,
    weights,
    means,
    standardDeviations,
  );
  const quote = quoteFromCandle(observation.candle);
  const label = market.result === "yes" ? 1 : 0;
  const predictsYes = probability >= 0.5;
  const baselinePredictsYes = quote.probability >= 0.5;
  const yesAsk = quote.ask || quote.probability;
  const noAsk = quote.bid > 0 ? 1 - quote.bid : 1 - quote.probability;
  const entryPrice = clamp(predictsYes ? yesAsk : noAsk, 0.001, 0.999);
  const correct = predictsYes === (label === 1);
  const profit = correct ? 1 - entryPrice : -entryPrice;
  const estimatedFee = estimatedTakerFee(entryPrice);
  const seriesTicker = seriesTickerForMarket(market);

  return {
    asset: ASSET_BY_SERIES[seriesTicker],
    seriesTicker,
    closeTime: Date.parse(market.close_time),
    probability,
    marketProbability: quote.probability,
    label,
    correct,
    baselineCorrect: baselinePredictsYes === (label === 1),
    entryPrice,
    profit,
    estimatedFee,
    netProfit: profit - estimatedFee,
  };
}

function aggregatePerformance(
  evaluations: MarketEvaluation[],
): ModelPerformancePoint[] {
  const ordered = [...evaluations].sort(
    (left, right) => left.closeTime - right.closeTime,
  );
  const points: ModelPerformancePoint[] = [];
  const pointCount = Math.min(8, ordered.length);
  let previousEnd = 0;

  for (let point = 1; point <= pointCount; point += 1) {
    const end = Math.ceil((ordered.length * point) / pointCount);
    if (end === previousEnd) continue;
    const included = ordered.slice(0, end);
    const totalCost = included.reduce(
      (sum, evaluation) =>
        sum + evaluation.entryPrice + evaluation.estimatedFee,
      0,
    );
    const totalProfit = included.reduce(
      (sum, evaluation) => sum + evaluation.netProfit,
      0,
    );
    const lastDate = new Date(included.at(-1)!.closeTime);
    points.push({
      label: lastDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
      }),
      cumulativeReturn: rounded(
        totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
      ),
      hitRate: rounded(
        (included.filter((evaluation) => evaluation.correct).length /
          included.length) *
          100,
      ),
      trades: included.length,
    });
    previousEnd = end;
  }
  return points;
}

function summarizeAssetEvaluations(
  evaluations: MarketEvaluation[],
): AssetBacktestStats[] {
  return SERIES.map((seriesTicker) => {
    const assetEvaluations = evaluations
      .filter((evaluation) => evaluation.seriesTicker === seriesTicker)
      .sort((left, right) => left.closeTime - right.closeTime);
    const grossCost = assetEvaluations.reduce(
      (sum, evaluation) => sum + evaluation.entryPrice,
      0,
    );
    const netCost = assetEvaluations.reduce(
      (sum, evaluation) =>
        sum + evaluation.entryPrice + evaluation.estimatedFee,
      0,
    );
    const grossProfit = assetEvaluations.reduce(
      (sum, evaluation) => sum + evaluation.profit,
      0,
    );
    const netProfit = assetEvaluations.reduce(
      (sum, evaluation) => sum + evaluation.netProfit,
      0,
    );
    let cumulativeProfit = 0;
    let peakProfit = 0;
    let largestDrawdown = 0;
    for (const evaluation of assetEvaluations) {
      cumulativeProfit += evaluation.netProfit;
      peakProfit = Math.max(peakProfit, cumulativeProfit);
      largestDrawdown = Math.max(largestDrawdown, peakProfit - cumulativeProfit);
    }
    const netReturn = netCost > 0 ? (netProfit / netCost) * 100 : 0;

    return {
      asset: ASSET_BY_SERIES[seriesTicker],
      seriesTicker,
      sampleSize: assetEvaluations.length,
      hitRate: rounded(
        assetEvaluations.length > 0
          ? (assetEvaluations.filter((evaluation) => evaluation.correct).length /
              assetEvaluations.length) *
              100
          : 0,
      ),
      grossReturn: rounded(
        grossCost > 0 ? (grossProfit / grossCost) * 100 : 0,
      ),
      netReturn: rounded(netReturn),
      averageNetProfitCents: rounded(
        assetEvaluations.length > 0
          ? (netProfit / assetEvaluations.length) * 100
          : 0,
        2,
      ),
      maxDrawdown: rounded(
        netCost > 0 ? (largestDrawdown / netCost) * 100 : 0,
      ),
      profitable: assetEvaluations.length >= 10 && netReturn > 0,
    };
  });
}

async function fetchSettledMarkets(
  fetcher: KalshiFetcher,
): Promise<KalshiApiMarket[]> {
  const responses = await Promise.all(
    SERIES.map((seriesTicker) =>
      fetcher<{ markets: KalshiApiMarket[] }>(
        `/markets?status=settled&limit=${MARKETS_PER_SERIES}&series_ticker=${seriesTicker}`,
      ),
    ),
  );
  return responses
    .flatMap((response) => response.markets)
    .filter((market) => market.result === "yes" || market.result === "no")
    .sort(
      (left, right) => Date.parse(left.close_time) - Date.parse(right.close_time),
    );
}

async function fetchCandleHistory(
  fetcher: KalshiFetcher,
  markets: KalshiApiMarket[],
): Promise<Map<string, KalshiApiCandle[]>> {
  const groups: KalshiApiMarket[][] = [];
  let currentGroup: KalshiApiMarket[] = [];
  for (const market of markets) {
    const candidate = [...currentGroup, market];
    const startTimestamp = Math.min(
      ...candidate.map((item) => Date.parse(item.open_time) / 1_000),
    );
    const endTimestamp = Math.max(
      ...candidate.map((item) => Date.parse(item.close_time) / 1_000),
    );
    const requestedCandles =
      (Math.ceil((endTimestamp - startTimestamp) / 60) + 2) * candidate.length;
    if (
      currentGroup.length > 0 &&
      (candidate.length > 100 || requestedCandles > MAX_CANDLES_PER_BATCH)
    ) {
      groups.push(currentGroup);
      currentGroup = [market];
    } else {
      currentGroup = candidate;
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const candlesByTicker = new Map<string, KalshiApiCandle[]>();
  for (const group of groups) {
    const startTimestamp = Math.floor(
      Math.min(...group.map((market) => Date.parse(market.open_time))) / 1_000,
    ) - 60;
    const endTimestamp = Math.ceil(
      Math.max(...group.map((market) => Date.parse(market.close_time))) / 1_000,
    );
    const tickers = group.map((market) => market.ticker).join(",");
    const response = await fetcher<{
        markets: Array<{
          market_ticker: string;
          candlesticks: KalshiApiCandle[];
        }>;
      }>(
      `/markets/candlesticks?market_tickers=${tickers}&start_ts=${startTimestamp}&end_ts=${endTimestamp}&period_interval=1`,
    );
    response.markets.forEach((market) => {
      candlesByTicker.set(market.market_ticker, market.candlesticks);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return candlesByTicker;
}

export async function trainAndValidate(
  fetcher: KalshiFetcher,
): Promise<ValidatedKalshiModel> {
  const markets = await fetchSettledMarkets(fetcher);
  if (markets.length < 200) {
    throw new Error(`Only ${markets.length} settled markets were available`);
  }
  const candlesByTicker = await fetchCandleHistory(fetcher, markets);
  const splitIndex = Math.floor(markets.length * (1 - HOLDOUT_FRACTION));
  const cutoffTime = Date.parse(markets[splitIndex].close_time);
  const trainingMarkets = markets.filter(
    (market) => Date.parse(market.close_time) < cutoffTime,
  );
  const holdoutMarkets = markets.filter(
    (market) => Date.parse(market.close_time) >= cutoffTime,
  );
  const trainingSamples = trainingMarkets.flatMap((market) =>
    trainingSamplesForMarket(
      market,
      candlesByTicker.get(market.ticker) ?? [],
    ),
  );
  if (trainingSamples.length < 500) {
    throw new Error(`Only ${trainingSamples.length} training samples were available`);
  }

  const { means, standardDeviations } = featureStatistics(trainingSamples);
  const weights = trainLogisticRegression(
    trainingSamples,
    means,
    standardDeviations,
  );
  const evaluations = holdoutMarkets
    .map((market) =>
      evaluateMarket(
        market,
        candlesByTicker.get(market.ticker) ?? [],
        weights,
        means,
        standardDeviations,
      ),
    )
    .filter((evaluation): evaluation is MarketEvaluation => Boolean(evaluation));
  if (evaluations.length < 40) {
    throw new Error(`Only ${evaluations.length} holdout markets were available`);
  }

  const correct = evaluations.filter((evaluation) => evaluation.correct).length;
  const baselineCorrect = evaluations.filter(
    (evaluation) => evaluation.baselineCorrect,
  ).length;
  const totalCost = evaluations.reduce(
    (sum, evaluation) => sum + evaluation.entryPrice,
    0,
  );
  const totalProfit = evaluations.reduce(
    (sum, evaluation) => sum + evaluation.profit,
    0,
  );
  const totalNetCost = evaluations.reduce(
    (sum, evaluation) =>
      sum + evaluation.entryPrice + evaluation.estimatedFee,
    0,
  );
  const totalNetProfit = evaluations.reduce(
    (sum, evaluation) => sum + evaluation.netProfit,
    0,
  );
  const brierScore =
    evaluations.reduce(
      (sum, evaluation) =>
        sum + (evaluation.probability - evaluation.label) ** 2,
      0,
    ) / evaluations.length;

  return {
    name: "Multi-asset time-split logistic baseline v2",
    trainedAt: new Date().toISOString(),
    trainingMarkets: trainingMarkets.length,
    holdoutMarkets: evaluations.length,
    hitRate: rounded((correct / evaluations.length) * 100),
    baselineHitRate: rounded((baselineCorrect / evaluations.length) * 100),
    brierScore: rounded(brierScore, 4),
    grossPaperReturn: rounded(
      totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    ),
    netPaperReturn: rounded(
      totalNetCost > 0 ? (totalNetProfit / totalNetCost) * 100 : 0,
    ),
    assetStats: summarizeAssetEvaluations(evaluations),
    performance: aggregatePerformance(evaluations),
    weights,
    means,
    standardDeviations,
  };
}

export async function getValidatedKalshiModel(
  fetcher: KalshiFetcher,
): Promise<ValidatedKalshiModel> {
  if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.value;
  if (trainingPromise) return trainingPromise;
  trainingPromise = trainAndValidate(fetcher)
    .then((model) => {
      modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, value: model };
      return model;
    })
    .finally(() => {
      trainingPromise = undefined;
    });
  return trainingPromise;
}

export function predictLiveMarket(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  model: ValidatedKalshiModel,
): LivePrediction {
  const ordered = orderedCandles(candles);
  const latestIndex = Math.max(0, ordered.length - 1);
  const candleFeatures =
    featuresAtIndex(market, ordered, latestIndex) ??
    [
      logit(quoteFromMarket(market).probability),
      0,
      0,
      quoteFromMarket(market).spread * 10,
      clamp(
        (Date.now() - Date.parse(market.open_time)) /
          Math.max(1, Date.parse(market.close_time) - Date.parse(market.open_time)),
        0,
        1,
      ),
      Math.log1p(numberFrom(market.volume_fp)) / 10,
      ...assetIndicators(market),
    ];
  const marketQuote = quoteFromMarket(market);
  candleFeatures[0] = logit(marketQuote.probability);
  candleFeatures[3] = marketQuote.spread * 10;
  candleFeatures[5] = Math.log1p(numberFrom(market.volume_fp)) / 10;

  return {
    yesProbability: predictWithWeights(
      candleFeatures,
      model.weights,
      model.means,
      model.standardDeviations,
    ),
    marketYesProbability: marketQuote.probability,
    spread: marketQuote.spread,
  };
}
