import { describe, expect, it } from "vitest";
import { backupFileName, backupsToDelete, latestBackupAt, sqlStringLiteral } from "./db-backup-core";

describe("db backup helpers", () => {
  it("names backups by UTC time", () => {
    expect(backupFileName(new Date("2026-10-13T03:07:00.000Z"))).toBe("kaimi-20261013-0307.db");
  });

  it("keeps the newest backups and ignores foreign files", () => {
    const names = [
      "kaimi-20261010-0300.db",
      "kaimi-20261012-0300.db",
      "kaimi-20261011-0300.db",
      "kaimi.db",
      "notes.txt",
    ];
    expect(backupsToDelete(names, 2)).toEqual(["kaimi-20261010-0300.db"]);
    expect(backupsToDelete(names, 0)).toEqual(["kaimi-20261010-0300.db", "kaimi-20261011-0300.db"]);
  });

  it("escapes quotes in paths", () => {
    expect(sqlStringLiteral("/data/o'brien/x.db")).toBe("'/data/o''brien/x.db'");
  });
});

describe("latestBackupAt", () => {
  it("reads the newest backup time from file names", () => {
    expect(latestBackupAt(["kaimi-20261011-0300.db", "kaimi-20261012-0415.db", "x.db"])?.toISOString()).toBe(
      "2026-10-12T04:15:00.000Z",
    );
    expect(latestBackupAt(["kaimi.db"])).toBeNull();
  });
});
