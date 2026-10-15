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

/** 兑换只收 Session；邮箱密码方式已下线，老客户端还传 mailbox 时回这句。 */
export const MAILBOX_REDEEM_REMOVED = "已不支持邮箱密码兑换，请改用 Session 兑换";

export type AgentCredential = {
  mode: "session";
  session?: string;
  email?: string;
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
