import type { ToolDef } from "../core/tool.ts";
import { applescriptRun } from "./applescript.ts";
import { browserClick, browserClose, browserFill, browserOpen, browserSnapshot } from "./browser.ts";
import { inputClick, inputHotkey, inputType } from "./input.ts";
import { screenshot } from "./screenshot.ts";
import { shellRun } from "./shell.ts";
import { uiCheckAccess, uiDumpTree, uiFind, uiListApps, uiPress, uiSetValue } from "./ui.ts";

const ALL: ToolDef[] = [
  shellRun,
  applescriptRun,
  uiCheckAccess,
  uiListApps,
  uiDumpTree,
  uiFind,
  uiPress,
  uiSetValue,
  inputType,
  inputHotkey,
  inputClick,
  screenshot,
  browserOpen,
  browserSnapshot,
  browserClick,
  browserFill,
  browserClose,
] as ToolDef[];

/** Tools available on this OS. */
export function availableTools(platform: NodeJS.Platform = process.platform): ToolDef[] {
  return ALL.filter((t) => !t.platforms || t.platforms.includes(platform));
}
