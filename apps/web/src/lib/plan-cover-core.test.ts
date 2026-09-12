import { describe, expect, it } from "vitest";
import {
  COVER_MIN_SIDE,
  agentCoverPublicPath,
  coverImageError,
  inspectCoverImage,
  normalizeStoredCoverUrl,
  storedCoverError,
} from "./plan-cover-core";

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("inspectCoverImage", () => {
  it("reads a PNG header", () => {
    expect(inspectCoverImage(pngHeader(1280, 720))).toEqual({
      ext: "png",
      width: 1280,
      height: 720,
    });
  });

  it("rejects an unknown blob", () => {
    expect(inspectCoverImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("coverImageError", () => {
  it("rejects a short side under 450", () => {
    expect(coverImageError(pngHeader(400, 800))).toContain("短边至少");
  });

  it("accepts a 16:9 cover", () => {
    expect(coverImageError(pngHeader(1280, 720))).toBeNull();
  });

  it("rejects an oversized buffer", () => {
    const huge = new Uint8Array(COVER_MIN_SIDE * 0 + 1024 * 1024 + 1);
    expect(coverImageError(huge)).toBe("图片不能超过 1MB");
  });
});

describe("stored cover url", () => {
  it("keeps an uploaded path and an https link", () => {
    expect(normalizeStoredCoverUrl("/uploads/agent/3/plan/plus.webp?v=1")).toBe(
      "/uploads/agent/3/plan/plus.webp?v=1",
    );
    expect(normalizeStoredCoverUrl("https://cdn.example.com/plus.png")).toBe(
      "https://cdn.example.com/plus.png",
    );
  });

  it("drops empty, http, and junk", () => {
    expect(normalizeStoredCoverUrl("")).toBe("");
    expect(normalizeStoredCoverUrl("http://evil.example/x.png")).toBe("");
    expect(normalizeStoredCoverUrl("javascript:alert(1)")).toBe("");
    expect(storedCoverError("http://x.com/a.png")).toBe("外链只要 https");
    expect(storedCoverError("/uploads/agent/1/plan/plus.svg")).toBe(
      "请填 https 链接，或先上传到本店",
    );
  });

  it("builds a cache-busted public path", () => {
    expect(agentCoverPublicPath(8, "pro_20x", "jpeg", 99)).toBe(
      "/uploads/agent/8/plan/pro_20x.jpg?v=99",
    );
  });
});
