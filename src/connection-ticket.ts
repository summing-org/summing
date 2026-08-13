import { randomUUID, sign, verify } from "node:crypto";
import {
  parseIntegrationManifest,
  type IntegrationDeclaration,
} from "./integration-manifest.js";

const MAXIMUM_TICKET_SECONDS = 600;

export interface ConnectionTicketPayload {
  version: 1;
  jti: string;
  userId: number;
  projectId: string;
  integration: IntegrationDeclaration;
  issuedAt: number;
  expiresAt: number;
}

export class ConnectionTicketError extends Error {}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ConnectionTicketError("connection ticket is malformed");
  }
}

export function issueConnectionTicket(
  privateKey: string | Buffer,
  userId: number,
  projectId: string,
  integration: IntegrationDeclaration,
  now = Math.floor(Date.now() / 1_000),
  lifetimeSeconds = 300,
): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ConnectionTicketError("connection ticket user is invalid");
  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 30 || lifetimeSeconds > MAXIMUM_TICKET_SECONDS) {
    throw new ConnectionTicketError("connection ticket lifetime must be between 30 and 600 seconds");
  }
  const header = encode({ alg: "EdDSA", typ: "SUMMING-CONNECTION", version: 1 });
  const payload: ConnectionTicketPayload = {
    version: 1,
    jti: randomUUID(),
    userId,
    projectId,
    integration,
    issuedAt: now,
    expiresAt: now + lifetimeSeconds,
  };
  const body = `${header}.${encode(payload)}`;
  const signature = sign(null, Buffer.from(body), privateKey).toString("base64url");
  return `${body}.${signature}`;
}

export function verifyConnectionTicket(
  publicKey: string | Buffer,
  ticket: string,
  now = Math.floor(Date.now() / 1_000),
): ConnectionTicketPayload {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ConnectionTicketError("connection ticket is malformed");
  }
  const header = decode(parts[0]!) as Record<string, unknown>;
  if (header.alg !== "EdDSA" || header.typ !== "SUMMING-CONNECTION" || header.version !== 1) {
    throw new ConnectionTicketError("connection ticket header is invalid");
  }
  const body = `${parts[0]}.${parts[1]}`;
  if (!verify(null, Buffer.from(body), publicKey, Buffer.from(parts[2]!, "base64url"))) {
    throw new ConnectionTicketError("connection ticket signature is invalid");
  }
  const payload = decode(parts[1]!) as Partial<ConnectionTicketPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.jti !== "string" ||
    !/^[0-9a-f-]{36}$/.test(payload.jti) ||
    !Number.isSafeInteger(payload.userId) ||
    Number(payload.userId) <= 0 ||
    typeof payload.projectId !== "string" ||
    !payload.integration ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    Number(payload.expiresAt) <= Number(payload.issuedAt) ||
    Number(payload.expiresAt) - Number(payload.issuedAt) > MAXIMUM_TICKET_SECONDS
  ) {
    throw new ConnectionTicketError("connection ticket payload is invalid");
  }
  if (Number(payload.issuedAt) > now + 30 || Number(payload.expiresAt) < now) {
    throw new ConnectionTicketError("connection ticket has expired or is not active");
  }
  try {
    const integration = parseIntegrationManifest({
      version: 1,
      integrations: [payload.integration],
    }).integrations[0];
    if (!integration) throw new Error("missing integration");
    payload.integration = integration;
  } catch {
    throw new ConnectionTicketError("connection ticket integration is invalid");
  }
  return payload as ConnectionTicketPayload;
}
