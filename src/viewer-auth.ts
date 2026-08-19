import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class ViewerAuthError extends Error {}

export interface ViewerArtifactDownloadGrant {
  conversationId: string;
  expiresAt: number;
  issuedAt: number;
  jobId: string;
  name: string;
  userId: number;
  version: 1;
}

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

  createArtifactDownloadGrant(
    input: Pick<ViewerArtifactDownloadGrant, "conversationId" | "jobId" | "name" | "userId">,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): { expiresAt: number; token: string } {
    const maximumAgeSeconds = Math.max(1, Math.min(this.maximumAgeSeconds, 900));
    const grant: ViewerArtifactDownloadGrant = {
      ...input,
      expiresAt: nowSeconds + maximumAgeSeconds,
      issuedAt: nowSeconds,
      version: 1,
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.artifactKey(), nonce);
    cipher.setAAD(Buffer.from("summing-viewer-artifact-download-v1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(grant), "utf8"),
      cipher.final(),
    ]);
    return {
      expiresAt: grant.expiresAt,
      token: [nonce, ciphertext, cipher.getAuthTag()]
        .map((part) => part.toString("base64url"))
        .join("."),
    };
  }

  verifyArtifactDownloadGrant(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): ViewerArtifactDownloadGrant {
    const [nonceText = "", ciphertextText = "", tagText = "", extra] = token.split(".");
    if (
      extra !== undefined ||
      !/^[A-Za-z0-9_-]{16}$/.test(nonceText) ||
      !/^[A-Za-z0-9_-]+$/.test(ciphertextText) ||
      !/^[A-Za-z0-9_-]{22}$/.test(tagText)
    ) {
      throw new ViewerAuthError("Artifact download link is invalid");
    }
    let value: unknown;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.artifactKey(),
        Buffer.from(nonceText, "base64url"),
      );
      decipher.setAAD(Buffer.from("summing-viewer-artifact-download-v1", "utf8"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64url")),
        decipher.final(),
      ]);
      value = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new ViewerAuthError("Artifact download link is invalid");
    }
    const grant = value as Partial<ViewerArtifactDownloadGrant> | null;
    const maximumAgeSeconds = Math.max(1, Math.min(this.maximumAgeSeconds, 900));
    if (
      !grant ||
      grant.version !== 1 ||
      !Number.isSafeInteger(grant.userId) ||
      Number(grant.userId) < 0 ||
      typeof grant.conversationId !== "string" ||
      !/^tg-[0-9a-f]{20}$/.test(grant.conversationId) ||
      typeof grant.jobId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(grant.jobId) ||
      typeof grant.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(grant.name) ||
      !Number.isSafeInteger(grant.issuedAt) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      Number(grant.issuedAt) > nowSeconds + 30 ||
      Number(grant.expiresAt) <= Number(grant.issuedAt) ||
      Number(grant.expiresAt) - Number(grant.issuedAt) > maximumAgeSeconds
    ) {
      throw new ViewerAuthError("Artifact download link is invalid");
    }
    if (nowSeconds > Number(grant.expiresAt)) {
      throw new ViewerAuthError("Artifact download link has expired");
    }
    return grant as ViewerArtifactDownloadGrant;
  }

  private artifactKey(): Buffer {
    return createHmac("sha256", this.botToken)
      .update("summing-viewer-artifact-download-v1")
      .digest();
  }
}
