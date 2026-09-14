import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  trainAndValidate,
  type KalshiFetcher,
} from "../artifacts/api-server/src/services/kalshi-model";

const KALSHI_API_BASE_URL =
  process.env.KALSHI_API_BASE_URL ??
  "https://external-api.kalshi.com/trade-api/v2";
const outputPath = path.resolve(import.meta.dirname, "model-snapshot.json");

function assertPromotionQuality(
  model: Awaited<ReturnType<typeof trainAndValidate>>,
): void {
  const horizonFailures = model.horizons.flatMap((horizon) => {
    const label = `${horizon.targetSeconds / 60}-minute horizon`;
    return [
      horizon.evaluationMarkets < 500
        ? `${label} has fewer than 500 untouched evaluation markets`
        : "",
      horizon.holdoutMarkets < 40
        ? `${label} has fewer than 40 qualified evaluation signals`
        : "",
      horizon.brierScore > 0.3 ? `${label} Brier score is above 0.30` : "",
      horizon.expectedCalibrationError > 10
        ? `${label} calibration gap is above 10 percentage points`
        : "",
    ].filter(Boolean);
  });
  const failures = [
    model.horizons.length < 11
      ? "fewer than 11 independently validated horizons"
      : "",
    model.evaluationMarkets < 500
      ? "fewer than 500 untouched evaluation markets"
      : "",
    model.holdoutMarkets < 100
      ? "fewer than 100 qualified evaluation signals"
      : "",
    model.signalCoverage < 15 ? "qualified coverage below 15%" : "",
    model.hitRateLowerBound < 80 ? "95% hit-rate lower bound below 80%" : "",
    model.brierScore > 0.2 ? "Brier score above 0.20" : "",
    model.brierSkillScore < -2
      ? "Brier skill more than 2% below the market quote"
      : "",
    model.expectedCalibrationError > 8
      ? "calibration gap above 8 percentage points"
      : "",
    ...horizonFailures,
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new Error(`Model failed promotion gates: ${failures.join(", ")}`);
  }
}

const fetchKalshi: KalshiFetcher = async <T>(apiPath: string): Promise<T> => {
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${KALSHI_API_BASE_URL}${apiPath}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    lastStatus = response.status;
    if (response.ok) return (await response.json()) as T;

    const shouldRetry = response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : 1_000 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new Error(
    `Kalshi API returned ${lastStatus ?? "an error"} while exporting the model`,
  );
};

async function main(): Promise<void> {
  const model = await trainAndValidate(fetchKalshi);
  assertPromotionQuality(model);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");

  console.log(
    `Exported ${model.name}: ${model.trainingMarkets} train / ${model.calibrationMarkets} calibration / ${model.evaluationMarkets} evaluation markets.`,
  );
}

void main();
