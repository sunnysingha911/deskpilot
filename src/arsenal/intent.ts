// Is something the user said (or typed to the orb) a question for A.R.S.E.N.A.L, or a task to run?
// Browser-safe: the desktop orb uses it too. A question only makes the voice talk, so guessing
// "question" is harmless; a task always waits for the user to confirm it.

const ABOUT_ME = /\b(you|your|arsenal|agents?|tasks?|runs?|suggest(ion|ions|ed)?|learn(ed|t)?|score|provider|model|budget)\b/i;
const QUESTION_START = /^(what|which|who|why|how|when|where|did|does|do|is|are|was|were|has|have|can you tell|tell me)\b/i;
const TASK_START = /^(please\s+)?(open|find|search|look up|write|create|make|send|draft|read|check|run|list|count|summari[sz]e|download|book|apply|fix|build|install|delete|move|copy|go to|start|close|play|compose|reply|email|schedule|clean)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (TASK_START.test(t)) return false;
  if (/\?\s*$/.test(t)) return true;
  return QUESTION_START.test(t) && ABOUT_ME.test(t);
}
