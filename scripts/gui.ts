// Start the deskpilot control panel and open it in an app-style browser window.
//   npm run gui              # start + open window
//   npm run gui -- --no-open # start only, print the URL
//   npm run gui -- --no-overlay # without the desktop avatars
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR, ensureDir, ROOT } from "../src/core/paths.ts";
import { startOverlay, type Overlay } from "../src/gui/overlay.ts";
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

/** Open the control panel (optionally at a hash route) in an app-style window. */
function openPanel(route = ""): void {
  try {
    // Separate profile from both your normal browser and the agents' browser (data/browser-profile).
    const child = spawn(
      browserExecutable(),
      [`--app=${gui.url}${route}`, `--user-data-dir=${ensureDir(join(DATA_DIR, "gui-profile"))}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,860"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch (err) {
    console.log(`Couldn't open a browser window (${err instanceof Error ? err.message : err}). Open the URL above manually.`);
  }
}

if (!noOpen) openPanel();

let overlay: Overlay | undefined;
if (!process.argv.includes("--no-overlay")) {
  const o = startOverlay(gui.url, (route) => openPanel(route), gui.voiceBridge.events);
  if ("error" in o) console.log(`desktop avatars: ${o.error}`);
  else {
    overlay = o;
    gui.voiceBridge.attach(o.send); // push-to-talk settings go to the helper
  }
}

const shutdown = async () => {
  overlay?.stop();
  await gui.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
