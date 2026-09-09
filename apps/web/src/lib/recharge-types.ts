export type ItemStatus =
  | "pending"
  | "issuing"
  | "preparing"
  | "submitted"
  | "processing"
  | "success"
  | "failed"
  | "skipped"
  | "unknown";

export type CredMode = "session" | "mailbox";

export type AgentCredential = {
  mode: CredMode;
  session?: string;
  email?: string;
  password?: string;
  email_password?: string;
};

export function isTerminalStatus(status?: string) {
  return (
    status === "success" ||
    status === "failed" ||
    status === "skipped" ||
    status === "unknown"
  );
}

/** 状态刚变成终态（含 unknown → success）才推送，避免轮询把同一条再推一遍。 */
export function shouldNotifyTerminalTransition(prev?: string, next?: string) {
  return Boolean(next) && isTerminalStatus(next) && prev !== next;
}

export function isProcessingStatus(status?: string) {
  return (
    status === "pending" ||
    status === "issuing" ||
    status === "preparing" ||
    status === "submitted" ||
    status === "processing"
  );
}
