import { BUG_TTL_MS } from "./config";
import { state } from "./state";

export function cleanExpiredBugs(): void {
  const now = Date.now();
  for (const [key, bug] of state.pendingBugs) {
    if (now - bug.timestamp > BUG_TTL_MS) state.pendingBugs.delete(key);
  }
}
