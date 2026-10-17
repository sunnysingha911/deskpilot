export const RISK_LEVELS = ["read_only", "reversible", "irreversible"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

export function maxRisk(...risks: Risk[]): Risk {
  let best = 0;
  for (const r of risks) best = Math.max(best, RISK_LEVELS.indexOf(r));
  return RISK_LEVELS[best]!;
}

/** Labels on buttons/links/menu items that usually mean "this can't be undone". */
const IRREVERSIBLE_LABEL =
  /\b(send|submit|delete|remove|erase|destroy|discard|purchase|buy|pay|checkout|check out|place order|order now|subscribe|unsubscribe|publish|post|transfer|confirm|empty trash|sign out|log out|apply|book|reply|forward|merge|deploy|uninstall)\b/i;

/** Classify a UI target (AX element, DOM element) from its visible label. */
export function riskFromLabel(...labels: Array<string | undefined | null>): Risk {
  const text = labels.filter(Boolean).join(" ");
  return IRREVERSIBLE_LABEL.test(text) ? "irreversible" : "reversible";
}
