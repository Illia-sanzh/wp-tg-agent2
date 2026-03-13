import { Context, SessionFlavor } from "grammy";

export interface ChatMessage {
  role: string;
  content: string;
}

export interface SessionData {
  model?: string;
  history?: ChatMessage[];
  skillStep?: string;
  skillDraft?: Record<string, any>;
  pendingSkillDelete?: string;
  mcpStep?: string;
  mcpDraft?: Record<string, any>;
  pendingMedia?: { bytes: number[]; filename: string; contentType: string };
  mediaStep?: string;
  skillBrowseStep?: string;
  skillBrowseFiles?: string[];
  skillBrowseRepo?: { owner: string; repo: string; branch: string };
  cancelledAt?: number;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export interface EnvDef {
  name: string;
  hint: string;
  required: boolean;
}

export interface McpEntry {
  package: string;
  description: string;
  category: string;
  env: EnvDef[];
}
