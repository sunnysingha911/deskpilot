// Start the deskpilot control panel and open it in an app-style browser window.
//   npm run gui              # start + open window
//   npm run gui -- --no-open # start only, print the URL
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR, ensureDir, ROOT } from "../src/core/paths.ts";
import { startGuiServer } from "../src/gui/server.ts";
import { browserExecutable } from "../src/tools/browser.ts";

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* no .env yet: keys can be added from the Providers screen */
}

const noOpen = process.argv.includes("--no-open");
const port = Number(process.env.DESKPILOT_GUI_PORT ?? 4747);
const gui = await startGuiServer({ port });
console.log(`deskpilot control panel: ${gui.url}`);
console.log("(the URL contains this session's access token; it changes every launch)");

if (!noOpen) {
  try {
    // Separate profile from both your normal browser and the agents' browser (data/browser-profile).
    const child = spawn(
      browserExecutable(),
      [`--app=${gui.url}`, `--user-data-dir=${ensureDir(join(DATA_DIR, "gui-profile"))}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,860"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch (err) {
    console.log(`Couldn't open a browser window (${err instanceof Error ? err.message : err}). Open the URL above manually.`);
  }
}

const shutdown = async () => {
  await gui.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
