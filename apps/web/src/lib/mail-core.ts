import { z } from "zod";

/** 发件人显示名：去掉 CR/LF 与双引号，防止头部注入或破坏 "name" <addr> 格式。 */
export function mailDisplayName(value: string) {
  return value.replace(/[\r\n"]/g, "").trim();
}

const emailSchema = z.string().email();

/** 空串视为"未填写"（回退到 SMTP 用户名），其余必须是合法邮箱。 */
export function isValidMailFrom(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return emailSchema.safeParse(trimmed).success;
}

/** nodemailer 的 from：有显示名时传 { name, address }，否则只传地址。 */
export function buildMailFrom(name: string, address: string): string | { name: string; address: string } {
  const cleanName = mailDisplayName(name);
  const cleanAddress = address.trim();
  return cleanName ? { name: cleanName, address: cleanAddress } : cleanAddress;
}
