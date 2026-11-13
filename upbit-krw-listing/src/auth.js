import crypto from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function queryString(params) {
  if (!params) return "";
  return Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signJwt(accessKey, secret, query = "") {
  const payload = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (query) {
    payload.query_hash = crypto.createHash("sha512").update(query).digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const header = base64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = crypto.createHmac("sha512", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function readJwtPayload(token) {
  const [, body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}
