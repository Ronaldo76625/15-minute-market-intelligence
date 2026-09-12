import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KalshiApiMarket, KalshiFetcher } from "./kalshi-model";

type PaperSignalInput = {
  ticker: string;
  asset: string;
  side: "YES" | "NO";
  entryPrice: number;
  modelProbability: number;
  estimatedFee: number;
  modelName: string;
  secondsToClose: number;
};

type PaperSignalRecord = PaperSignalInput & {
  createdAt: string;
  result?: "yes" | "no";
  settledAt?: string;
  correct?: boolean;
  netProfit?: number;
};

export type ForwardAssetStats = {
  asset: string;
  tracked: number;
  pending: number;
  resolved: number;
  hitRate: number;
  netReturn: number;
  totalProfit: number;
};

export type ForwardTrackingStats = {
  startedAt: string;
  tracked: number;
  pending: number;
  resolved: number;
  hitRate: number;
  netReturn: number;
  totalProfit: number;
  assets: ForwardAssetStats[];
};

const LEDGER_PATH =
  process.env.KALSHI_LEDGER_PATH ??
  path.resolve(process.cwd(), ".local", "paper-signals.json");

function rounded(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function readLedger(): Promise<PaperSignalRecord[]> {
  try {
    const contents = await readFile(LEDGER_PATH, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    return Array.isArray(parsed) ? (parsed as PaperSignalRecord[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeLedger(records: PaperSignalRecord[]): Promise<void> {
  await mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  const temporaryPath = `${LEDGER_PATH}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  await rename(temporaryPath, LEDGER_PATH);
}

function summarizeRecords(records: PaperSignalRecord[]): ForwardTrackingStats {
  const assets = [...new Set(records.map((record) => record.asset))].sort();
  const summarize = (subset: PaperSignalRecord[]) => {
    const resolved = subset.filter(
      (record): record is PaperSignalRecord & { netProfit: number } =>
        typeof record.netProfit === "number",
    );
    const totalCost = resolved.reduce(
      (sum, record) => sum + record.entryPrice + record.estimatedFee,
      0,
    );
    const totalProfit = resolved.reduce(
      (sum, record) => sum + record.netProfit,
      0,
    );
    return {
      tracked: subset.length,
      pending: subset.length - resolved.length,
      resolved: resolved.length,
      hitRate: rounded(
        resolved.length > 0
          ? (resolved.filter((record) => record.correct).length /
              resolved.length) *
              100
          : 0,
      ),
      netReturn: rounded(
        totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
      ),
      totalProfit: rounded(totalProfit, 2),
    };
  };
  const totals = summarize(records);

  return {
    startedAt: records[0]?.createdAt ?? new Date().toISOString(),
    ...totals,
    assets: assets.map((asset) => ({
      asset,
      ...summarize(records.filter((record) => record.asset === asset)),
    })),
  };
}

export async function updatePaperSignalLedger(
  fetcher: KalshiFetcher,
  signals: PaperSignalInput[],
): Promise<ForwardTrackingStats> {
  const records = await readLedger();
  const knownTickers = new Set(records.map((record) => record.ticker));
  let changed = false;

  for (const signal of signals) {
    if (signal.secondsToClose < 240 || signal.secondsToClose > 420) continue;
    if (knownTickers.has(signal.ticker)) continue;
    records.push({ ...signal, createdAt: new Date().toISOString() });
    knownTickers.add(signal.ticker);
    changed = true;
  }

  const pending = records.filter((record) => !record.result).slice(0, 100);
  if (pending.length > 0) {
    try {
      const tickers = encodeURIComponent(
        pending.map((record) => record.ticker).join(","),
      );
      const response = await fetcher<{ markets: KalshiApiMarket[] }>(
        `/markets?limit=100&tickers=${tickers}`,
      );
      const marketByTicker = new Map(
        response.markets.map((market) => [market.ticker, market]),
      );
      for (const record of pending) {
        const result = marketByTicker.get(record.ticker)?.result;
        if (result !== "yes" && result !== "no") continue;
        record.result = result;
        record.settledAt = new Date().toISOString();
        record.correct = record.side.toLowerCase() === result;
        const grossProfit = record.correct
          ? 1 - record.entryPrice
          : -record.entryPrice;
        record.netProfit = grossProfit - record.estimatedFee;
        changed = true;
      }
    } catch {
      // Live predictions still work if settlement tracking is temporarily unavailable.
    }
  }

  records.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  if (changed) await writeLedger(records);
  return summarizeRecords(records);
}
