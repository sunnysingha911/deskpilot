import { macosBackend } from "./macos.ts";
import type { DesktopBackend } from "./types.ts";

/** Desktop backend for the current OS, or null if not implemented yet. */
export function desktopBackend(): DesktopBackend | null {
  switch (process.platform) {
    case "darwin":
      return macosBackend;
    // case "win32": Phase 3 (C# UI Automation helper)
    // case "linux": Phase 3 (AT-SPI helper + xdotool)
    default:
      return null;
  }
}

/** Platforms that have a desktop backend. Tools that need one declare these. */
export const DESKTOP_PLATFORMS: NodeJS.Platform[] = ["darwin"];

export function requireBackend(): DesktopBackend {
  const b = desktopBackend();
  if (!b) throw new Error(`no desktop backend for ${process.platform} yet`);
  return b;
}
