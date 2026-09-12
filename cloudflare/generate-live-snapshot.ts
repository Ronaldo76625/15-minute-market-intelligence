import { readFile, writeFile } from "node:fs/promises";
import type { ValidatedKalshiModel } from "../artifacts/api-server/src/services/kalshi-model";
import { fetchRecentSettlements, generateLiveMarketSnapshot } from "./worker";

const outputPath =
  process.env.KALSHI_SNAPSHOT_OUTPUT ?? "/tmp/kalshi-live-data.json";

async function main(): Promise<void> {
  const modelInput = process.env.KALSHI_MODEL_INPUT;
  const selectedModel = modelInput
    ? (JSON.parse(await readFile(modelInput, "utf8")) as ValidatedKalshiModel)
    : undefined;
  const snapshot = await generateLiveMarketSnapshot(selectedModel);
  const settlements = await fetchRecentSettlements();

  await writeFile(
    outputPath,
    `${JSON.stringify({ snapshot, settlements })}\n`,
    "utf8",
  );

  console.log(
    `Generated ${snapshot.markets.length} live markets at ${snapshot.asOf}.`,
  );
}

void main();
