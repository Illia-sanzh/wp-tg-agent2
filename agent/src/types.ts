import type OpenAI from "openai";

export interface ThreadEntry {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ThreadRecord {
  channel: string;
  thread_id: string;
  history: ThreadEntry[];
  updated: number;
}

export interface PendingBug {
  title: string;
  content: string;
  author: any;
  metadata: any;
  timestamp: number;
}

export interface StoredJob {
  id: string;
  name: string;
  task: string;
  cron_expr: string | null;
  run_at: string | null;
  created_at: string;
}

export interface TaskProfile {
  name: string;
  tools: string[];
  promptSections: string[];
  knowledgePatterns: string[];
  skillFileSections: string[];
  maxSteps: number;
  maxTokens: number;
  maxOutputChars: number;
  model?: string;
  singleShot?: boolean;
  effort?: "low" | "medium" | "high";
}

export interface MarkdownSkill {
  name: string;
  filename: string;
  content: string;
}

export interface AgentEvent {
  type: "thinking" | "progress" | "result";
  text?: string;
  elapsed?: number;
  model?: string;
  images?: string[];
}

export interface ChatMessage {
  role: string;
  content: string;
}
