import { describe, expect, it } from "vitest";
import {
  agentAnnouncementHint,
  announcementActionError,
  announcementActionHttpStatus,
  announcementWriteError,
  isAnnouncementUnread,
  nextArchivedFields,
  nextPublishedFields,
  normalizeAnnouncementBody,
  normalizeAnnouncementTitle,
  parseAnnouncementId,
  unreadFromLiveAnnouncement,
  visibleToAgent,
} from "./announcements-core";

describe("normalize announcement text", () => {
  it("标题去空白、换行收成空格", () => {
    expect(normalizeAnnouncementTitle("  维护\n明天  ")).toBe("维护 明天");
  });

  it("正文保留换行，丢掉回车和控制符", () => {
    expect(normalizeAnnouncementBody("第一行\r\n第二行\u0007")).toBe("第一行\n第二行");
  });
});

describe("announcementWriteError", () => {
  it("标题空或超 40 个字", () => {
    expect(announcementWriteError({ title: "   ", body: "有正文", publishing: false })).toBe(
      "标题不能空",
    );
    expect(
      announcementWriteError({ title: "字".repeat(41), body: "", publishing: false }),
    ).toBe("标题最多 40 个字");
  });

  it("草稿允许正文空，发布不行", () => {
    expect(announcementWriteError({ title: "结算", body: "  ", publishing: false })).toBeNull();
    expect(announcementWriteError({ title: "结算", body: "  ", publishing: true })).toBe(
      "正文不能空",
    );
  });

  it("正文超过 800 个字", () => {
    expect(
      announcementWriteError({ title: "维护", body: "哈".repeat(801), publishing: false }),
    ).toBe("正文最多 800 个字");
  });
});

describe("announcementActionError", () => {
  it("状态机：草稿能发能删，生效能改能下线，下线是终态", () => {
    expect(announcementActionError("draft", "publish")).toBeNull();
    expect(announcementActionError("draft", "discard")).toBeNull();
    expect(announcementActionError("published", "edit")).toBeNull();
    expect(announcementActionError("published", "archive")).toBeNull();
    expect(announcementActionError("published", "publish")).toBe("只有草稿能发布");
    expect(announcementActionError("published", "discard")).toBe("只有草稿能删");
    expect(announcementActionError("draft", "archive")).toBe("只有正在生效的能下线");
    expect(announcementActionError("archived", "edit")).toBe("这条已经下线，不能再改");
    expect(announcementActionError("archived", "publish")).toBe("只有草稿能发布");
  });

  it("错状态走 409，找不到走 404", () => {
    expect(announcementActionHttpStatus("只有草稿能删")).toBe(409);
    expect(announcementActionHttpStatus("没有这条公告")).toBe(404);
    expect(announcementActionHttpStatus("标题不能空")).toBe(400);
  });
});

describe("unread and publish fields", () => {
  it("只有生效且没读过才算未读", () => {
    expect(isAnnouncementUnread("published", false)).toBe(true);
    expect(isAnnouncementUnread("published", true)).toBe(false);
    expect(isAnnouncementUnread("archived", false)).toBe(false);
    expect(isAnnouncementUnread("draft", false)).toBe(false);
  });

  it("代理看不到草稿", () => {
    expect(visibleToAgent("published")).toBe(true);
    expect(visibleToAgent("archived")).toBe(true);
    expect(visibleToAgent("draft")).toBe(false);
  });

  it("侧栏 hint", () => {
    expect(agentAnnouncementHint(true)).toBe("有新的");
    expect(agentAnnouncementHint(false)).toBe("平台");
  });

  it("顶栏用当前公告，弹窗只用未读", () => {
    const live = {
      id: 3,
      title: "续费上线",
      body: "临期才能用",
      publishedAt: "2026-09-12T14:07:00.000Z",
      unread: true,
    };
    expect(unreadFromLiveAnnouncement(live)).toEqual({
      id: 3,
      title: "续费上线",
      body: "临期才能用",
      publishedAt: "2026-09-12T14:07:00.000Z",
    });
    expect(unreadFromLiveAnnouncement({ ...live, unread: false })).toBeNull();
    expect(unreadFromLiveAnnouncement(null)).toBeNull();
  });

  it("发布和顶替字段", () => {
    expect(nextPublishedFields("2026-09-12T10:00:00.000Z")).toEqual({
      status: "published",
      liveKey: "live",
      publishedAt: "2026-09-12T10:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-09-12T10:00:00.000Z",
    });
    expect(nextArchivedFields("2026-09-12T11:00:00.000Z")).toEqual({
      status: "archived",
      liveKey: null,
      archivedAt: "2026-09-12T11:00:00.000Z",
      updatedAt: "2026-09-12T11:00:00.000Z",
    });
  });

  it("解析 id", () => {
    expect(parseAnnouncementId("3")).toBe(3);
    expect(parseAnnouncementId("0")).toBeNull();
    expect(parseAnnouncementId("x")).toBeNull();
  });
});
