import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { parseNotepad } from "./notepad.js";

const PREFIX = "enc1";

function derive(password, salt) {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptKeys(keys, password) {
  if (String(password || "").length < 8) throw new Error("Mật khẩu cần ít nhất 8 ký tự.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(password, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, salt.toString("base64url"), iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(":");
}

export function decryptKeys(payload, password) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error("Khóa mã hóa hỏng.");
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const iv = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const body = Buffer.from(parts[4], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", derive(password, salt), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const keys = JSON.parse(json);
    if (!Array.isArray(keys) || keys.some((key) => !/^0x[a-fA-F0-9]{64}$/.test(key))) throw new Error("hỏng");
    return keys;
  } catch (error) {
    if (error.message === "Khóa mã hóa hỏng.") throw error;
    throw new Error("Mật khẩu không đúng.");
  }
}

const SECRET_NAMES = new Set(["key", "vi", "private_key", "privatekey", "keys_enc", "keysenc", "key_count"]);

export function lockNotepad(text, password) {
  const config = parseNotepad(text, { allowEmptyKeys: true });
  if (!config.keys.length) {
    if (!config.keysEnc) throw new Error("Chưa điền private key.");
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  const payload = encryptKeys(config.keys, password);
  const kept = String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return true;
      if (/^(0x)?[a-fA-F0-9]{64}$/.test(trimmed)) return false;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return true;
      return !SECRET_NAMES.has(trimmed.slice(0, eq).trim().toLowerCase());
    });
  kept.push(`key_count=${config.keys.length}`);
  kept.push(`keys_enc=${payload}`);
  return `${kept.join("\n")}\n`;
}
