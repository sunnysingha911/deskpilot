// UI development: core server on :4747 + Vite dev server on :5173 with instant reload.
// Vite proxies /api to the core; open the printed URL (it carries this session's token).
import { join } from "node:path";
import { createServer } from "vite";
import { ROOT } from "../src/core/paths.ts";
import { startGuiServer } from "../src/gui/server.ts";

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* no .env */
}
const port = Number(process.env.DESKPILOT_GUI_PORT ?? 4747);
const core = await startGuiServer({ port });
const vite = await createServer({ configFile: join(ROOT, "ui", "vite.config.ts") });
await vite.listen();
console.log(`core API:  http://127.0.0.1:${port}`);
console.log(`dev UI:    http://127.0.0.1:5173/?t=${core.token}`);

const shutdown = async () => {
  await vite.close();
  await core.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
