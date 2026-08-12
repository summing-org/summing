import { createHmac, timingSafeEqual } from "node:crypto";

export class ViewerAuthError extends Error {}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  maximumAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): number {
  const params = new URLSearchParams(raw);
  const suppliedHash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(suppliedHash)) {
    throw new ViewerAuthError("Telegram init data has no valid hash");
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!safeEqual(suppliedHash.toLowerCase(), expectedHash)) {
    throw new ViewerAuthError("Telegram init data signature is invalid");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate)) {
    throw new ViewerAuthError("Telegram init data has no valid auth_date");
  }
  if (authDate > nowSeconds + 30 || nowSeconds - authDate > maximumAgeSeconds) {
    throw new ViewerAuthError("Telegram init data has expired");
  }

  let user: unknown;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    throw new ViewerAuthError("Telegram init data has invalid user JSON");
  }
  const userId = Number(
    user && typeof user === "object" && !Array.isArray(user)
      ? (user as Record<string, unknown>).id
      : 0,
  );
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ViewerAuthError("Telegram init data has no valid user id");
  }
  return userId;
}

export class ViewerAuthenticator {
  constructor(
    readonly botToken: string,
    readonly maximumAgeSeconds: number,
    readonly localToken = "",
  ) {}

  authenticate(headers: Record<string, string | string[] | undefined>): number {
    const authorization = String(headers.authorization ?? "");
    const bearer = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (this.localToken && bearer && safeEqual(bearer, this.localToken)) return 0;

    const rawHeader = headers["x-telegram-init-data"];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] ?? "" : rawHeader ?? "";
    if (!raw) throw new ViewerAuthError("Authentication is required");
    return verifyTelegramInitData(raw, this.botToken, this.maximumAgeSeconds);
  }
}
