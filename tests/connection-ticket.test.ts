import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { issueConnectionTicket, verifyConnectionTicket } from "../src/connection-ticket.js";
import { parseIntegrationManifest } from "../src/integration-manifest.js";

const integration = parseIntegrationManifest({
  version: 1,
  integrations: [{
    id: "mail",
    provider: "resend",
    auth: "api_key",
    mode: "gateway",
    capabilities: ["email.send"],
    scopes: [],
    actions: ["run"],
    secrets: [{ name: "api_key" }],
    gateway: { methods: ["POST"], pathPrefixes: ["/emails"] },
  }],
}).integrations[0]!;

test("issues short-lived Ed25519 connection tickets bound to user/project/integration", () => {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const ticket = issueConnectionTicket(privateKey, 42, "demo", integration, 1_000, 300);
  const payload = verifyConnectionTicket(publicKey, ticket, 1_100);
  assert.equal(payload.userId, 42);
  assert.equal(payload.projectId, "demo");
  assert.equal(payload.integration.id, "mail");
  assert.equal(payload.expiresAt, 1_300);
  assert.throws(() => verifyConnectionTicket(publicKey, ticket, 1_301), /expired/);

  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => verifyConnectionTicket(other, ticket, 1_100), /signature/);
});
