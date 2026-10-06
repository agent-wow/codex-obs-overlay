export interface Session {
  id: string;
  title: string;
  cwd: string;
  rolloutPath: string;
}

export type ActivityState = "waiting" | "working" | "idle" | "interrupted" | "unavailable";
export type EntryKind = "user" | "assistant" | "reasoning" | "action";

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  timestamp: string;
  outcome?: "running" | "completed" | "failed";
}

export interface Snapshot {
  session: { id: string; title: string } | null;
  status: ActivityState;
  lastActivity: string | null;
  entries: Entry[];
}
