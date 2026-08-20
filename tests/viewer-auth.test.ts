import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ViewerAuthError, ViewerAuthenticator, verifyTelegramInitData } from "../src/viewer-auth.js";

function signedInitData(token: string, authDate: number, userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "query-1",
    user: JSON.stringify({ id: userId, first_name: "Ada" }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function nonCanonicalBase64UrlAlias(value: string): string {
  const decoded = Buffer.from(value, "base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const character of alphabet) {
    const candidate = `${value.slice(0, -1)}${character}`;
    if (
      candidate !== value &&
      Buffer.from(candidate, "base64url").equals(decoded) &&
      Buffer.from(candidate, "base64url").toString("base64url") !== candidate
    ) {
      return candidate;
    }
  }
  throw new Error("could not construct a non-canonical base64url alias");
}

test("validates Telegram Mini App init data and its age", () => {
  const now = 1_786_500_000;
  const raw = signedInitData("bot-token", now - 10, 42);
  assert.equal(verifyTelegramInitData(raw, "bot-token", 300, now), 42);
  assert.throws(
    () => verifyTelegramInitData(raw, "wrong-token", 300, now),
    (error) => error instanceof ViewerAuthError && error.message.includes("signature"),
  );
  assert.throws(
    () => verifyTelegramInitData(raw, "bot-token", 5, now),
    (error) => error instanceof ViewerAuthError && error.message.includes("expired"),
  );
});

test("accepts the explicit SSH tunnel bearer token", () => {
  const auth = new ViewerAuthenticator("bot-token", 300, "local-secret");
  assert.equal(auth.authenticate({ authorization: "Bearer local-secret" }), 0);
  assert.throws(() => auth.authenticate({ authorization: "Bearer wrong" }), ViewerAuthError);
});

test("issues bounded tamper-evident artifact download grants", () => {
  const now = 1_786_500_000;
  const auth = new ViewerAuthenticator("bot-token", 300);
  const issued = auth.createArtifactDownloadGrant({
    conversationId: "tg-0123456789abcdefabcd",
    jobId: "25b42bab-c0f5-4801-9a21-edaaeff2b408",
    name: "report.html",
    userId: 42,
  }, now);

  assert.equal(issued.expiresAt, now + 300);
  assert.deepEqual(auth.verifyArtifactDownloadGrant(issued.token, now + 299), {
    conversationId: "tg-0123456789abcdefabcd",
    expiresAt: now + 300,
    issuedAt: now,
    jobId: "25b42bab-c0f5-4801-9a21-edaaeff2b408",
    name: "report.html",
    userId: 42,
    version: 1,
  });
  const [nonce, ciphertext, tag] = issued.token.split(".") as [string, string, string];
  const tamperedNonce = `${nonce.startsWith("A") ? "B" : "A"}${nonce.slice(1)}`;
  assert.throws(
    () => auth.verifyArtifactDownloadGrant(`${tamperedNonce}.${ciphertext}.${tag}`, now),
    (error) => error instanceof ViewerAuthError && error.message.includes("invalid"),
  );
  const aliasedTag = nonCanonicalBase64UrlAlias(tag);
  assert.ok(Buffer.from(aliasedTag, "base64url").equals(Buffer.from(tag, "base64url")));
  assert.throws(
    () => auth.verifyArtifactDownloadGrant(`${nonce}.${ciphertext}.${aliasedTag}`, now),
    (error) => error instanceof ViewerAuthError && error.message.includes("invalid"),
  );
  assert.throws(
    () => auth.verifyArtifactDownloadGrant(issued.token, now + 301),
    (error) => error instanceof ViewerAuthError && error.message.includes("expired"),
  );
  assert.throws(
    () => new ViewerAuthenticator("other-token", 300).verifyArtifactDownloadGrant(issued.token, now),
    ViewerAuthError,
  );
});
