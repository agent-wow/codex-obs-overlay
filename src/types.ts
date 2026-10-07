export interface Session {
  id: string;
  title: string;
  cwd: string;
  rolloutPath: string;
}

export type ActivityState = "waiting" | "working" | "idle" | "interrupted" | "unavailable" | "needs-input";
export type EntryKind = "user" | "assistant" | "reasoning" | "action" | "plan" | "event";

export interface Section {
  label: string;
  text: string;
  format: "text" | "code" | "json" | "diff";
}

export interface Attachment {
  id: string;
  kind: "image" | "audio" | "file";
  label: string;
}

// Kept server-side; the browser receives only a project/session-scoped asset ID.
export interface MediaSource {
  kind: "image" | "audio";
  mime: string;
  data?: string;
  path?: string;
}

export interface SessionInfo {
  model?: string;
  effort?: string;
  contextWindow?: number;
  contextTokens?: number;
  totalTokens?: number;
}

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  timestamp: string;
  outcome?: "running" | "completed" | "failed";
  phase?: string;
  sections?: Section[];
  attachments?: Attachment[];
}

export interface Snapshot {
  session: { id: string; title: string } | null;
  status: ActivityState;
  lastActivity: string | null;
  entries: Entry[];
  epoch: string;
  info: SessionInfo;
}

export interface FeedUpdate extends Snapshot {
  reset: boolean;
}
