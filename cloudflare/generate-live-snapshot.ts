import { writeFile } from "node:fs/promises";
import {
  fetchRecentSettlements,
  generateLiveMarketSnapshot,
} from "./worker";

const outputPath =
  process.env.KALSHI_SNAPSHOT_OUTPUT ?? "/tmp/kalshi-live-data.json";

async function main(): Promise<void> {
  const snapshot = await generateLiveMarketSnapshot();
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
