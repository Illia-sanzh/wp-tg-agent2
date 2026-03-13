import * as fs from "fs";
import { log, DATA_DIR, THREADS_DB, MAX_THREAD_HISTORY, MAX_THREADS } from "./config";
import { state } from "./state";
import type { ThreadRecord } from "./types";

export function loadThreads(): void {
  try {
    if (fs.existsSync(THREADS_DB)) {
      const data = JSON.parse(fs.readFileSync(THREADS_DB, "utf8"));
      for (const [k, v] of Object.entries(data)) state.threadStore.set(k, v as ThreadRecord);
      log.info(`[threads] Loaded ${state.threadStore.size} thread(s) from disk`);
    }
  } catch (e) {
    log.warn(`[threads] Failed to load: ${e}`);
  }
}

export function saveThreads(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, ThreadRecord> = {};
    for (const [k, v] of state.threadStore) obj[k] = v;
    fs.writeFileSync(THREADS_DB, JSON.stringify(obj), "utf8");
  } catch (e) {
    log.warn(`[threads] Failed to save: ${e}`);
  }
}

export function getThread(channel: string, threadId: string): ThreadRecord {
  const key = `${channel}:${threadId}`;
  if (!state.threadStore.has(key)) {
    state.threadStore.set(key, { channel, thread_id: threadId, history: [], updated: Date.now() });
  }
  return state.threadStore.get(key)!;
}

export function appendToThread(channel: string, threadId: string, role: "user" | "assistant", content: string): void {
  const thread = getThread(channel, threadId);
  thread.history.push({ role, content });
  if (thread.history.length > MAX_THREAD_HISTORY) {
    thread.history = thread.history.slice(-MAX_THREAD_HISTORY);
  }
  thread.updated = Date.now();

  if (state.threadStore.size > MAX_THREADS) {
    let oldest: [string, ThreadRecord] | null = null;
    for (const entry of state.threadStore) {
      if (!oldest || entry[1].updated < oldest[1].updated) oldest = entry;
    }
    if (oldest) state.threadStore.delete(oldest[0]);
  }

  saveThreads();
}
