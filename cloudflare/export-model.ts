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

const model = await trainAndValidate(fetchKalshi);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");

console.log(
  `Exported ${model.name}: ${model.trainingMarkets} train / ${model.holdoutMarkets} holdout markets.`,
);
