// Show recent action-log rows:  npm run logs -- [count]
import { ActionLogger } from "../src/core/logger.ts";

const n = Number(process.argv[2] ?? 20);
const logger = new ActionLogger();
const rows = logger.recent(n).reverse();
logger.close();

for (const r of rows) {
  const input = r.input_json.length > 90 ? r.input_json.slice(0, 90) + "…" : r.input_json;
  console.log(
    `#${r.id} ${r.ts} ${r.os} ${r.caller.padEnd(6)} ${r.tool.padEnd(16)} ${r.risk.padEnd(12)} ${r.status.padEnd(7)} ${String(r.duration_ms).padStart(5)}ms ${r.approved_by ?? ""}`,
  );
  console.log(`     in:  ${input}`);
  if (r.error) console.log(`     err: ${r.error.slice(0, 160)}`);
}
