import { homedir } from "node:os";
import { resolve } from "node:path";
import { startServer } from "./server";

const rawPort = process.env.CODEX_OBS_PORT ?? "3004";
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error("CODEX_OBS_PORT must be an integer from 1 to 65535");
  process.exit(1);
}
const app = startServer({
  home: resolve(process.env.CODEX_HOME || `${homedir()}/.codex`),
  port: Number(rawPort),
});
console.error(`Codex OBS overlay listening on ${app.server.url}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  });
}
