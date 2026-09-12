export const COVER_MAX_BYTES = 1024 * 1024;
export const COVER_MIN_SIDE = 450;
export const COVER_URL_MAX = 1000;

export const COVER_EXTS = ["png", "jpg", "jpeg", "webp"] as const;
export type CoverExt = (typeof COVER_EXTS)[number];

const UPLOAD_PATH =
  /^\/uploads\/agent\/(\d+)\/plan\/([a-z0-9_:-]+)\.(png|jpe?g|webp)(\?v=\d+)?$/i;

export type CoverImageInfo = {
  ext: CoverExt;
  width: number;
  height: number;
};

function readU32be(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readU16be(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readU24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function pngSize(bytes: Uint8Array): CoverImageInfo | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== "PNG") return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  const width = readU32be(bytes, 16);
  const height = readU32be(bytes, 20);
  if (!width || !height) return null;
  return { ext: "png", width, height };
}

function jpegSize(bytes: Uint8Array): CoverImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readU16be(bytes, offset + 2);
    if (length < 2) return null;
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      const height = readU16be(bytes, offset + 5);
      const width = readU16be(bytes, offset + 7);
      if (!width || !height) return null;
      return { ext: "jpg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): CoverImageInfo | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") {
    const width = readU24le(bytes, 24) + 1;
    const height = readU24le(bytes, 27) + 1;
    if (!width || !height) return null;
    return { ext: "webp", width, height };
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    const start = 20;
    if (bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      const width = bytes[start + 6] | ((bytes[start + 7] & 0x3f) << 8);
      const height = bytes[start + 8] | ((bytes[start + 9] & 0x3f) << 8);
      if (!width || !height) return null;
      return { ext: "webp", width, height };
    }
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { ext: "webp", width, height };
  }
  return null;
}

/** 只认 PNG / JPG / WEBP 的文件头，不信上传时的 Content-Type。 */
export function inspectCoverImage(bytes: Uint8Array): CoverImageInfo | null {
  return pngSize(bytes) || jpegSize(bytes) || webpSize(bytes);
}

export function coverImageError(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return "请选一张图片";
  if (bytes.byteLength > COVER_MAX_BYTES) return "图片不能超过 1MB";
  const info = inspectCoverImage(bytes);
  if (!info) return "只接受 PNG、JPG 或 WEBP";
  if (Math.min(info.width, info.height) < COVER_MIN_SIDE) {
    return `短边至少 ${COVER_MIN_SIDE} 像素，这张是 ${info.width}×${info.height}`;
  }
  return null;
}

export function isSafePlanKey(planKey: string) {
  return /^[a-z0-9_:-]+$/i.test(planKey);
}

export function isSafeCoverFileName(fileName: string) {
  return /^[a-z0-9_:-]+\.(png|jpe?g|webp)$/i.test(fileName);
}

/** 空串表示用平台默认图。外链只收 https，本站上传走 /uploads/agent/... */
export function storedCoverError(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > COVER_URL_MAX) return "图片链接太长";
  if (UPLOAD_PATH.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "请填 https 链接，或先上传到本店";
  }
  if (parsed.protocol !== "https:") return "外链只要 https";
  return null;
}

export function normalizeStoredCoverUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || storedCoverError(raw)) return "";
  return raw;
}

export function agentCoverPublicPath(
  agentId: number,
  planKey: string,
  ext: CoverExt,
  version = Date.now(),
) {
  const suffix = ext === "jpeg" ? "jpg" : ext;
  return `/uploads/agent/${agentId}/plan/${planKey}.${suffix}?v=${version}`;
}
