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
