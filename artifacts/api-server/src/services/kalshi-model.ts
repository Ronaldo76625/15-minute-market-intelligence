const SERIES = [
  "KXBTC15M",
  "KXETH15M",
  "KXSOL15M",
  "KXXRP15M",
  "KXDOGE15M",
  "KXBNB15M",
  "KXHYPE15M",
] as const;
const MARKETS_PER_SERIES = 1_000;
const MAX_CANDLES_PER_BATCH = 9_000;
const TRAINING_FRACTION = 0.7;
const CALIBRATION_FRACTION = 0.15;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1_000;
const BASE_FEATURE_COUNT = 17;
const FEATURE_COUNT = BASE_FEATURE_COUNT + (SERIES.length - 1);
const KALSHI_TAKER_FEE_RATE = 0.07;
const TRAINING_OFFSETS_SECONDS = [600, 420, 300, 180, 120] as const;

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
  weight: number;
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
  calibrationMarkets: number;
  evaluationMarkets: number;
  holdoutMarkets: number;
  hitRate: number;
  hitRateLowerBound: number;
  baselineHitRate: number;
  brierScore: number;
  marketBrierScore: number;
  brierSkillScore: number;
  logLoss: number;
  expectedCalibrationError: number;
  signalCoverage: number;
  confidenceThreshold: number;
  grossPaperReturn: number;
  netPaperReturn: number;
  assetStats: AssetBacktestStats[];
  performance: ModelPerformancePoint[];
  weights: number[];
  means: number[];
  standardDeviations: number[];
  calibrationIntercept: number;
  calibrationSlope: number;
  marketBlendWeight: number;
  reliableAssets: string[];
};

export type LivePrediction = {
  yesProbability: number;
  marketYesProbability: number;
  spread: number;
};

let modelCache: { expiresAt: number; value: ValidatedKalshiModel } | undefined;
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
  const previous = numberFrom(candle.price?.previous_dollars);
  const rawProbability =
    bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid || traded || previous;
  return {
    probability:
      rawProbability > 0 && rawProbability < 1
        ? clamp(rawProbability, 0.001, 0.999)
        : Number.NaN,
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

function quoteAtOrBefore(candles: KalshiApiCandle[], index: number) {
  for (
    let cursor = Math.min(index, candles.length - 1);
    cursor >= 0;
    cursor -= 1
  ) {
    const quote = quoteFromCandle(candles[cursor]);
    if (Number.isFinite(quote.probability)) return quote;
  }
  return undefined;
}

function firstQuoteAtOrBefore(candles: KalshiApiCandle[], index: number) {
  for (
    let cursor = 0;
    cursor <= Math.min(index, candles.length - 1);
    cursor += 1
  ) {
    const quote = quoteFromCandle(candles[cursor]);
    if (Number.isFinite(quote.probability)) return quote;
  }
  return undefined;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function featuresAtIndex(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  index: number,
): number[] | undefined {
  const current = candles[index];
  if (!current) return undefined;
  const currentQuote = quoteAtOrBefore(candles, index);
  const firstQuote = firstQuoteAtOrBefore(candles, index);
  const oneMinuteQuote = quoteAtOrBefore(candles, index - 1);
  const threeMinuteQuote = quoteAtOrBefore(candles, index - 3);
  const fiveMinuteQuote = quoteAtOrBefore(candles, index - 5);
  const sixMinuteQuote = quoteAtOrBefore(candles, index - 6);
  if (
    !currentQuote ||
    !firstQuote ||
    !oneMinuteQuote ||
    !threeMinuteQuote ||
    !fiveMinuteQuote
  ) {
    return undefined;
  }
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
  const recentCandles = candles.slice(Math.max(0, index - 4), index + 1);
  const recentVolume = recentCandles.reduce(
    (sum, candle) => sum + numberFrom(candle.volume_fp),
    0,
  );
  const recentProbabilities = recentCandles
    .map(
      (_, offset) =>
        quoteAtOrBefore(candles, Math.max(0, index - 4) + offset)?.probability,
    )
    .filter((value): value is number => Number.isFinite(value));
  const recentChanges = recentProbabilities
    .slice(1)
    .map((value, offset) => value - recentProbabilities[offset]);
  const range = recentProbabilities.length
    ? Math.max(...recentProbabilities) - Math.min(...recentProbabilities)
    : 0;
  const currentHour = new Date(current.end_period_ts * 1_000).getUTCHours();
  const hourAngle = (2 * Math.PI * currentHour) / 24;
  const oneMinuteMomentum =
    currentQuote.probability - oneMinuteQuote.probability;
  const threeMinuteMomentum =
    currentQuote.probability - threeMinuteQuote.probability;
  const priorThreeMinuteMomentum = sixMinuteQuote
    ? threeMinuteQuote.probability - sixMinuteQuote.probability
    : 0;
  const openInterest = numberFrom(current.open_interest_fp);

  return [
    logit(currentQuote.probability),
    (currentQuote.probability - firstQuote.probability) * 10,
    oneMinuteMomentum * 20,
    threeMinuteMomentum * 10,
    (currentQuote.probability - fiveMinuteQuote.probability) * 10,
    currentQuote.spread * 10,
    elapsed,
    Math.log1p(volume) / 10,
    Math.log1p(recentVolume) / 10,
    recentVolume / Math.max(volume, 1),
    standardDeviation(recentChanges) * 20,
    range * 10,
    (threeMinuteMomentum - priorThreeMinuteMomentum) * 10,
    Math.log1p(openInterest) / 10,
    Math.abs(currentQuote.probability - 0.5) * 2,
    Math.sin(hourAngle),
    Math.cos(hourAngle),
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

  for (const offsetSeconds of TRAINING_OFFSETS_SECONDS) {
    const targetTimestamp = closeTimestamp - offsetSeconds;
    if (targetTimestamp < openTimestamp + 60) continue;
    let selectedIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].end_period_ts <= targetTimestamp)
        selectedIndex = index;
    }
    if (selectedIndex < 0) continue;
    const features = featuresAtIndex(market, ordered, selectedIndex);
    if (features) samples.push({ features, label, weight: 1 });
  }
  const weight = samples.length > 0 ? 1 / samples.length : 0;
  samples.forEach((sample) => {
    sample.weight = weight;
  });
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
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const means = Array.from({ length: FEATURE_COUNT }, () => 0);
  for (const sample of samples) {
    sample.features.forEach((value, index) => {
      means[index] += (value * sample.weight) / totalWeight;
    });
  }
  const standardDeviations = means.map((mean, index) => {
    const variance = samples.reduce(
      (sum, sample) =>
        sum + sample.weight * (sample.features[index] - mean) ** 2,
      0,
    );
    return Math.max(Math.sqrt(variance / totalWeight), 1e-6);
  });
  return { means, standardDeviations };
}

function standardizedFeatures(
  features: number[],
  means: number[],
  standardDeviations: number[],
): number[] {
  return features.map(
    (value, index) => (value - means[index]) / standardDeviations[index],
  );
}

function trainLogisticRegression(
  samples: TrainingSample[],
  means: number[],
  standardDeviations: number[],
): number[] {
  const weights = Array.from({ length: FEATURE_COUNT + 1 }, () => 0);
  const learningRate = 0.05;
  const regularization = 0.01;
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);

  for (let iteration = 0; iteration < 900; iteration += 1) {
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
      gradients[0] += error * sample.weight;
      features.forEach((feature, index) => {
        gradients[index + 1] += error * feature * sample.weight;
      });
    }

    weights[0] -= (learningRate * gradients[0]) / totalWeight;
    for (let index = 1; index < weights.length; index += 1) {
      const gradient =
        gradients[index] / totalWeight + regularization * weights[index];
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

type CalibrationParameters = {
  intercept: number;
  slope: number;
  marketBlendWeight: number;
};

type CalibrationObservation = {
  baseProbability: number;
  marketProbability: number;
  label: 0 | 1;
};

function fitPlattCalibration(
  observations: CalibrationObservation[],
): Omit<CalibrationParameters, "marketBlendWeight"> {
  let intercept = 0;
  let slope = 1;
  const learningRate = 0.04;
  const regularization = 0.002;

  for (let iteration = 0; iteration < 1_200; iteration += 1) {
    let interceptGradient = 0;
    let slopeGradient = 0;
    for (const observation of observations) {
      const feature = logit(observation.baseProbability);
      const error = sigmoid(intercept + slope * feature) - observation.label;
      interceptGradient += error;
      slopeGradient += error * feature;
    }
    intercept -=
      (learningRate * interceptGradient) / Math.max(1, observations.length);
    slope -=
      learningRate *
      (slopeGradient / Math.max(1, observations.length) +
        regularization * (slope - 1));
    slope = clamp(slope, 0.1, 3);
  }

  return { intercept, slope };
}

function probabilityWithCalibration(
  baseProbability: number,
  marketProbability: number,
  calibration: CalibrationParameters,
): number {
  const calibratedModel = sigmoid(
    calibration.intercept + calibration.slope * logit(baseProbability),
  );
  return clamp(
    calibration.marketBlendWeight * marketProbability +
      (1 - calibration.marketBlendWeight) * calibratedModel,
    0.01,
    0.99,
  );
}

function brierScoreFor(
  observations: CalibrationObservation[],
  calibration: CalibrationParameters,
): number {
  return (
    observations.reduce((sum, observation) => {
      const probability = probabilityWithCalibration(
        observation.baseProbability,
        observation.marketProbability,
        calibration,
      );
      return sum + (probability - observation.label) ** 2;
    }, 0) / Math.max(1, observations.length)
  );
}

function selectCalibration(
  observations: CalibrationObservation[],
): CalibrationParameters {
  const splitIndex = Math.max(1, Math.floor(observations.length / 2));
  const fittingSet = observations.slice(0, splitIndex);
  const selectionSet = observations.slice(splitIndex);
  const platt = fitPlattCalibration(fittingSet);
  const candidates = Array.from({ length: 11 }, (_, index) => index / 10).map(
    (marketBlendWeight) => ({ ...platt, marketBlendWeight }),
  );
  const best = candidates.reduce((currentBest, candidate) =>
    brierScoreFor(selectionSet, candidate) <
    brierScoreFor(selectionSet, currentBest)
      ? candidate
      : currentBest,
  );
  const marketOnly = { ...platt, marketBlendWeight: 1 };
  const marketScore = brierScoreFor(selectionSet, marketOnly);
  const bestScore = brierScoreFor(selectionSet, best);
  const relativeImprovement =
    marketScore > 0 ? (marketScore - bestScore) / marketScore : 0;

  return relativeImprovement >= 0.05 ? best : marketOnly;
}

function evaluateMarket(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  weights: number[],
  means: number[],
  standardDeviations: number[],
  calibration: CalibrationParameters,
): MarketEvaluation | undefined {
  if (market.result !== "yes" && market.result !== "no") return undefined;
  const observation = fiveMinuteObservation(market, candles);
  if (!observation) return undefined;
  const baseProbability = predictWithWeights(
    observation.features,
    weights,
    means,
    standardDeviations,
  );
  const quote = quoteFromCandle(observation.candle);
  if (!Number.isFinite(quote.probability)) return undefined;
  const probability = probabilityWithCalibration(
    baseProbability,
    quote.probability,
    calibration,
  );
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

function calibrationObservationForMarket(
  market: KalshiApiMarket,
  candles: KalshiApiCandle[],
  weights: number[],
  means: number[],
  standardDeviations: number[],
): CalibrationObservation | undefined {
  if (market.result !== "yes" && market.result !== "no") return undefined;
  const observation = fiveMinuteObservation(market, candles);
  if (!observation) return undefined;
  const quote = quoteFromCandle(observation.candle);
  if (!Number.isFinite(quote.probability)) return undefined;
  return {
    baseProbability: predictWithWeights(
      observation.features,
      weights,
      means,
      standardDeviations,
    ),
    marketProbability: quote.probability,
    label: market.result === "yes" ? 1 : 0,
  };
}

function predictionConfidence(evaluation: MarketEvaluation): number {
  return Math.max(evaluation.probability, 1 - evaluation.probability);
}

function wilsonLowerBound(correct: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const proportion = correct / total;
  const denominator = 1 + z ** 2 / total;
  const center = proportion + z ** 2 / (2 * total);
  const margin =
    z *
    Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * total)) / total);
  return (center - margin) / denominator;
}

function selectSignalThreshold(evaluations: MarketEvaluation[]): number {
  const minimumSample = Math.max(100, Math.floor(evaluations.length * 0.15));
  const candidates = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
  let bestThreshold = 0.6;
  let bestScore = -Infinity;

  for (const threshold of candidates) {
    const selected = evaluations.filter(
      (evaluation) => predictionConfidence(evaluation) >= threshold,
    );
    if (selected.length < minimumSample) continue;
    const correct = selected.filter((evaluation) => evaluation.correct).length;
    const conservativeAccuracy = wilsonLowerBound(correct, selected.length);
    const coverageBonus = (selected.length / evaluations.length) * 0.01;
    const score = conservativeAccuracy + coverageBonus;
    if (score > bestScore) {
      bestScore = score;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

function selectedEvaluations(
  evaluations: MarketEvaluation[],
  threshold: number,
): MarketEvaluation[] {
  return evaluations.filter(
    (evaluation) => predictionConfidence(evaluation) >= threshold,
  );
}

function expectedCalibrationError(evaluations: MarketEvaluation[]): number {
  if (evaluations.length === 0) return 0;
  const bins = 10;
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const subset = evaluations.filter((evaluation) =>
      bin === bins - 1
        ? evaluation.probability >= lower && evaluation.probability <= upper
        : evaluation.probability >= lower && evaluation.probability < upper,
    );
    if (subset.length === 0) continue;
    const meanProbability =
      subset.reduce((sum, evaluation) => sum + evaluation.probability, 0) /
      subset.length;
    const observedRate =
      subset.reduce((sum, evaluation) => sum + evaluation.label, 0) /
      subset.length;
    error +=
      (subset.length / evaluations.length) *
      Math.abs(meanProbability - observedRate);
  }
  return error;
}

function reliableAssetsFromCalibration(
  evaluations: MarketEvaluation[],
  threshold: number,
): string[] {
  const selected = selectedEvaluations(evaluations, threshold);
  return SERIES.flatMap((seriesTicker) => {
    const subset = selected.filter(
      (evaluation) => evaluation.seriesTicker === seriesTicker,
    );
    if (subset.length < 20) return [];
    const totalCost = subset.reduce(
      (sum, evaluation) =>
        sum + evaluation.entryPrice + evaluation.estimatedFee,
      0,
    );
    const totalProfit = subset.reduce(
      (sum, evaluation) => sum + evaluation.netProfit,
      0,
    );
    const lowerBound = wilsonLowerBound(
      subset.filter((evaluation) => evaluation.correct).length,
      subset.length,
    );
    return totalCost > 0 && totalProfit > 0 && lowerBound > 0.5
      ? [ASSET_BY_SERIES[seriesTicker]]
      : [];
  });
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
      largestDrawdown = Math.max(
        largestDrawdown,
        peakProfit - cumulativeProfit,
      );
    }
    const netReturn = netCost > 0 ? (netProfit / netCost) * 100 : 0;

    return {
      asset: ASSET_BY_SERIES[seriesTicker],
      seriesTicker,
      sampleSize: assetEvaluations.length,
      hitRate: rounded(
        assetEvaluations.length > 0
          ? (assetEvaluations.filter((evaluation) => evaluation.correct)
              .length /
              assetEvaluations.length) *
              100
          : 0,
      ),
      grossReturn: rounded(grossCost > 0 ? (grossProfit / grossCost) * 100 : 0),
      netReturn: rounded(netReturn),
      averageNetProfitCents: rounded(
        assetEvaluations.length > 0
          ? (netProfit / assetEvaluations.length) * 100
          : 0,
        2,
      ),
      maxDrawdown: rounded(netCost > 0 ? (largestDrawdown / netCost) * 100 : 0),
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
      (left, right) =>
        Date.parse(left.close_time) - Date.parse(right.close_time),
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
    const startTimestamp =
      Math.floor(
        Math.min(...group.map((market) => Date.parse(market.open_time))) /
          1_000,
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
  if (markets.length < 1_000) {
    throw new Error(`Only ${markets.length} settled markets were available`);
  }
  const candlesByTicker = await fetchCandleHistory(fetcher, markets);
  const trainingSplitIndex = Math.floor(markets.length * TRAINING_FRACTION);
  const calibrationSplitIndex = Math.floor(
    markets.length * (TRAINING_FRACTION + CALIBRATION_FRACTION),
  );
  const trainingCutoffTime = Date.parse(markets[trainingSplitIndex].close_time);
  const calibrationCutoffTime = Date.parse(
    markets[calibrationSplitIndex].close_time,
  );
  const trainingMarkets = markets.filter(
    (market) => Date.parse(market.close_time) < trainingCutoffTime,
  );
  const calibrationMarkets = markets.filter(
    (market) =>
      Date.parse(market.close_time) >= trainingCutoffTime &&
      Date.parse(market.close_time) < calibrationCutoffTime,
  );
  const holdoutMarkets = markets.filter(
    (market) => Date.parse(market.close_time) >= calibrationCutoffTime,
  );
  const trainingSamples = trainingMarkets.flatMap((market) =>
    trainingSamplesForMarket(market, candlesByTicker.get(market.ticker) ?? []),
  );
  if (trainingSamples.length < 2_000) {
    throw new Error(
      `Only ${trainingSamples.length} training samples were available`,
    );
  }

  const { means, standardDeviations } = featureStatistics(trainingSamples);
  const weights = trainLogisticRegression(
    trainingSamples,
    means,
    standardDeviations,
  );
  const calibrationObservations = calibrationMarkets
    .map((market) =>
      calibrationObservationForMarket(
        market,
        candlesByTicker.get(market.ticker) ?? [],
        weights,
        means,
        standardDeviations,
      ),
    )
    .filter((observation): observation is CalibrationObservation =>
      Boolean(observation),
    );
  if (calibrationObservations.length < 100) {
    throw new Error(
      `Only ${calibrationObservations.length} calibration markets were available`,
    );
  }
  const calibration = selectCalibration(calibrationObservations);
  const calibrationEvaluations = calibrationMarkets
    .map((market) =>
      evaluateMarket(
        market,
        candlesByTicker.get(market.ticker) ?? [],
        weights,
        means,
        standardDeviations,
        calibration,
      ),
    )
    .filter((evaluation): evaluation is MarketEvaluation =>
      Boolean(evaluation),
    );
  const signalThreshold = selectSignalThreshold(calibrationEvaluations);
  const reliableAssets = reliableAssetsFromCalibration(
    calibrationEvaluations,
    signalThreshold,
  );
  const evaluations = holdoutMarkets
    .map((market) =>
      evaluateMarket(
        market,
        candlesByTicker.get(market.ticker) ?? [],
        weights,
        means,
        standardDeviations,
        calibration,
      ),
    )
    .filter((evaluation): evaluation is MarketEvaluation =>
      Boolean(evaluation),
    );
  if (evaluations.length < 40) {
    throw new Error(
      `Only ${evaluations.length} holdout markets were available`,
    );
  }
  const qualifiedEvaluations = selectedEvaluations(
    evaluations,
    signalThreshold,
  );
  if (qualifiedEvaluations.length < 20) {
    throw new Error(
      `Only ${qualifiedEvaluations.length} qualified holdout markets were available`,
    );
  }

  const correct = qualifiedEvaluations.filter(
    (evaluation) => evaluation.correct,
  ).length;
  const baselineCorrect = qualifiedEvaluations.filter(
    (evaluation) => evaluation.baselineCorrect,
  ).length;
  const totalCost = qualifiedEvaluations.reduce(
    (sum, evaluation) => sum + evaluation.entryPrice,
    0,
  );
  const totalProfit = qualifiedEvaluations.reduce(
    (sum, evaluation) => sum + evaluation.profit,
    0,
  );
  const totalNetCost = qualifiedEvaluations.reduce(
    (sum, evaluation) => sum + evaluation.entryPrice + evaluation.estimatedFee,
    0,
  );
  const totalNetProfit = qualifiedEvaluations.reduce(
    (sum, evaluation) => sum + evaluation.netProfit,
    0,
  );
  const brierScore =
    evaluations.reduce(
      (sum, evaluation) =>
        sum + (evaluation.probability - evaluation.label) ** 2,
      0,
    ) / evaluations.length;
  const marketBrierScore =
    evaluations.reduce(
      (sum, evaluation) =>
        sum + (evaluation.marketProbability - evaluation.label) ** 2,
      0,
    ) / evaluations.length;
  const logLoss =
    evaluations.reduce((sum, evaluation) => {
      const probability = clamp(evaluation.probability, 0.001, 0.999);
      return (
        sum -
        (evaluation.label * Math.log(probability) +
          (1 - evaluation.label) * Math.log(1 - probability))
      );
    }, 0) / evaluations.length;

  return {
    name: "Calibrated multi-horizon market ensemble v3",
    trainedAt: new Date().toISOString(),
    trainingMarkets: trainingMarkets.length,
    calibrationMarkets: calibrationObservations.length,
    evaluationMarkets: evaluations.length,
    holdoutMarkets: qualifiedEvaluations.length,
    hitRate: rounded((correct / qualifiedEvaluations.length) * 100),
    hitRateLowerBound: rounded(
      wilsonLowerBound(correct, qualifiedEvaluations.length) * 100,
    ),
    baselineHitRate: rounded(
      (baselineCorrect / qualifiedEvaluations.length) * 100,
    ),
    brierScore: rounded(brierScore, 4),
    marketBrierScore: rounded(marketBrierScore, 4),
    brierSkillScore: rounded(
      marketBrierScore > 0 ? (1 - brierScore / marketBrierScore) * 100 : 0,
      2,
    ),
    logLoss: rounded(logLoss, 4),
    expectedCalibrationError: rounded(
      expectedCalibrationError(evaluations) * 100,
      2,
    ),
    signalCoverage: rounded(
      (qualifiedEvaluations.length / evaluations.length) * 100,
    ),
    confidenceThreshold: rounded(signalThreshold * 100),
    grossPaperReturn: rounded(
      totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    ),
    netPaperReturn: rounded(
      totalNetCost > 0 ? (totalNetProfit / totalNetCost) * 100 : 0,
    ),
    assetStats: summarizeAssetEvaluations(qualifiedEvaluations),
    performance: aggregatePerformance(qualifiedEvaluations),
    weights,
    means,
    standardDeviations,
    calibrationIntercept: calibration.intercept,
    calibrationSlope: calibration.slope,
    marketBlendWeight: calibration.marketBlendWeight,
    reliableAssets,
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
  const marketQuote = quoteFromMarket(market);
  const currentHour = new Date().getUTCHours();
  const hourAngle = (2 * Math.PI * currentHour) / 24;
  const normalizedVolume = Math.log1p(numberFrom(market.volume_fp)) / 10;
  const candleFeatures = featuresAtIndex(market, ordered, latestIndex) ?? [
    logit(marketQuote.probability),
    0,
    0,
    0,
    0,
    marketQuote.spread * 10,
    clamp(
      (Date.now() - Date.parse(market.open_time)) /
        Math.max(
          1,
          Date.parse(market.close_time) - Date.parse(market.open_time),
        ),
      0,
      1,
    ),
    normalizedVolume,
    normalizedVolume,
    1,
    0,
    0,
    0,
    0,
    Math.abs(marketQuote.probability - 0.5) * 2,
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    ...assetIndicators(market),
  ];
  candleFeatures[0] = logit(marketQuote.probability);
  candleFeatures[5] = marketQuote.spread * 10;
  candleFeatures[7] = normalizedVolume;

  const baseProbability = predictWithWeights(
    candleFeatures,
    model.weights,
    model.means,
    model.standardDeviations,
  );
  const calibratedProbability = probabilityWithCalibration(
    baseProbability,
    marketQuote.probability,
    {
      intercept: model.calibrationIntercept ?? 0,
      slope: model.calibrationSlope ?? 1,
      marketBlendWeight: model.marketBlendWeight ?? 0,
    },
  );

  return {
    yesProbability: calibratedProbability,
    marketYesProbability: marketQuote.probability,
    spread: marketQuote.spread,
  };
}
