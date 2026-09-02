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

export function isProcessingStatus(status?: string) {
  return (
    status === "pending" ||
    status === "issuing" ||
    status === "preparing" ||
    status === "submitted" ||
    status === "processing"
  );
}
