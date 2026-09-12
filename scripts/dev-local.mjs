import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const apiPort = process.env.API_PORT ?? "5051";
const webPort = process.env.WEB_PORT ?? "5173";

const build = spawnSync(
  pnpm,
  ["--filter", "@workspace/api-server", "build"],
  { cwd: root, stdio: "inherit" },
);

if (build.status !== 0) process.exit(build.status ?? 1);

const api = spawn(
  pnpm,
  ["--filter", "@workspace/api-server", "start"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PORT: apiPort },
  },
);
const web = spawn(
  pnpm,
  ["--filter", "@workspace/kalshi-predictor", "dev"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: webPort,
      BASE_PATH: "/",
      API_PROXY_TARGET: `http://localhost:${apiPort}`,
    },
  },
);

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250);
}

api.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`API stopped (${signal ?? code ?? "unknown"}).`);
    stop(code ?? 1);
  }
});
web.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`Web app stopped (${signal ?? code ?? "unknown"}).`);
    stop(code ?? 1);
  }
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`Local app: http://localhost:${webPort}`);
console.log("The first dashboard request trains and validates the model.");
