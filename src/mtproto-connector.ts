import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getTdjson } from "prebuilt-tdlib";
import * as tdl from "tdl";
import type { Client } from "tdl";
import { Deferred } from "./async-primitives.js";
import type { KnowledgeSyncConfig } from "./config.js";
import {
  type MtprotoConnectorRecord,
  type KnowledgeSyncStore,
} from "./knowledge-sync-store.js";

tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });

export interface MtprotoAuthorizationStatus {
  connectorId: string;
  state: "starting" | "wait_code" | "wait_password" | "ready" | "failed";
  passwordHint: string;
  expiresAt: number;
  error: string;
}

export interface MtprotoUpdateHandler {
  (connectorId: string, update: Record<string, unknown>): void | Promise<void>;
}

export interface MtprotoFileReference {
  fileId: number;
  remoteFileId: string;
  uniqueFileId: string;
  size: number;
}

const HISTORY_REQUEST_INTERVAL_MS = 500;

export const MTPROTO_PERSISTENCE_PARAMETERS = Object.freeze({
  use_message_database: false,
  use_chat_info_database: false,
  use_file_database: true,
  use_secret_chats: false,
});

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function mtprotoFloodWaitSeconds(error: unknown): number | null {
  const details = record(error);
  const parameters = record(details.parameters);
  for (const value of [
    details.retry_after,
    details.retryAfter,
    parameters.retry_after,
    parameters.retryAfter,
  ]) {
    const seconds = positiveInteger(value);
    if (seconds !== null) return seconds;
  }
  const text = [details.message, details.error_message, String(error)]
    .filter((value) => typeof value === "string")
    .join(" ");
  const flood = text.match(/FLOOD_(?:PREMIUM_)?WAIT[_\s:-]*(\d+)/i);
  if (flood) return positiveInteger(flood[1]);
  if (positiveInteger(details.code) === 429 || /\b429\b/.test(text)) {
    const retry = text.match(/(?:retry|wait)(?:\s+after|\s*[:=_-])?\s*(\d+)\s*(?:s|sec(?:ond)?s?)?\b/i);
    if (retry) return positiveInteger(retry[1]);
  }
  return null;
}

export function mtprotoRetryDelaySeconds(error: unknown): number {
  const floodWait = mtprotoFloodWaitSeconds(error);
  return floodWait === null ? 60 : floodWait + 3;
}

export class MtprotoHistoryScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(
    readonly intervalMs = HISTORY_REQUEST_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  ) {}

  async run<T>(connectorId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(connectorId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const waitMs = Math.max(
        0,
        (this.lastStartedAt.get(connectorId) ?? -this.intervalMs) + this.intervalMs - this.now(),
      );
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastStartedAt.set(connectorId, this.now());
      return operation();
    });
    const tail = task.then(() => {}, () => {});
    this.tails.set(connectorId, tail);
    try {
      return await task;
    } finally {
      if (this.tails.get(connectorId) === tail) this.tails.delete(connectorId);
    }
  }

  forget(connectorId: string): void {
    this.lastStartedAt.delete(connectorId);
  }
}

interface AuthorizationChallenge {
  connectorId: string;
  phone: string;
  state: MtprotoAuthorizationStatus["state"];
  passwordHint: string;
  expiresAt: number;
  error: string;
  code: Deferred<string> | null;
  password: Deferred<string> | null;
}

function parseMasterKey(path: string): Buffer {
  const value = readFileSync(path);
  const text = value.toString("utf8").trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : value;
  if (key.length !== 32) throw new Error(`${path} must contain exactly 32 bytes or 64 hex characters`);
  return key;
}

export class MtprotoSecretVault {
  private readonly key: Buffer;

  constructor(readonly keyPath: string) {
    this.key = parseMasterKey(keyPath);
  }

  encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  decrypt(value: string): string {
    const packed = Buffer.from(value, "base64url");
    if (packed.length < 29) throw new Error("encrypted MTProto secret is invalid");
    const nonce = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
  }

  databaseKey(connectorId: string): string {
    return Buffer.from(hkdfSync("sha256", this.key, connectorId, "summing-tdlib-db", 32))
      .toString("base64");
  }
}

function phoneMask(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return `***${digits}`;
  return `+${digits.slice(0, 2)}***${digits.slice(-4)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fileReference(value: unknown): MtprotoFileReference {
  const file = record(value);
  const remote = record(file.remote);
  const fileId = Number(file.id ?? 0);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    throw new Error("TDLib returned an invalid file identifier");
  }
  return {
    fileId,
    remoteFileId: String(remote.id ?? ""),
    uniqueFileId: String(remote.unique_id ?? ""),
    size: Number(file.size ?? file.expected_size ?? 0),
  };
}

export class MtprotoConnectorManager {
  private readonly clients = new Map<string, Client>();
  private readonly challenges = new Map<string, AuthorizationChallenge>();
  private readonly challengeTimers = new Map<string, NodeJS.Timeout>();
  private readonly vault: MtprotoSecretVault;
  private readonly historyScheduler = new MtprotoHistoryScheduler();
  private updateHandler: MtprotoUpdateHandler = () => {};

  constructor(
    readonly config: KnowledgeSyncConfig,
    readonly store: KnowledgeSyncStore,
  ) {
    this.vault = new MtprotoSecretVault(config.mtprotoMasterKeyPath);
  }

  onUpdate(handler: MtprotoUpdateHandler): void {
    this.updateHandler = handler;
  }

  async restore(): Promise<void> {
    await Promise.allSettled(
      this.store.listConnectors()
        .filter((connector) => connector.state === "ready" || connector.state === "degraded")
        .map((connector) => this.restoreConnector(connector)),
    );
  }

  private async restoreConnector(connector: MtprotoConnectorRecord): Promise<void> {
    try {
      const client = this.createClient(connector, this.vault.decrypt(connector.encryptedApiHash));
      await client.login({
        type: "user",
        getPhoneNumber: async () => { throw new Error("MTProto session requires reauthorization"); },
        getAuthCode: async () => { throw new Error("MTProto session requires reauthorization"); },
        getPassword: async () => { throw new Error("MTProto session requires reauthorization"); },
        getEmailAddress: async () => { throw new Error("email authentication is not configured"); },
        getEmailCode: async () => { throw new Error("email authentication is not configured"); },
        confirmOnAnotherDevice: () => {},
        getName: async () => ({ firstName: "SUMMING" }),
      });
      this.store.updateConnector(connector.id, "ready", { lastUpdateAt: Date.now() / 1_000 });
    } catch (error) {
      this.store.updateConnector(connector.id, "degraded", { error: String(error) });
      await this.closeClient(connector.id);
    }
  }

  beginAuthorization(input: { apiId: number; apiHash: string; phone: string }): MtprotoAuthorizationStatus {
    if (!Number.isSafeInteger(input.apiId) || input.apiId <= 0) throw new Error("apiId must be positive");
    if (!/^[0-9a-f]{32}$/i.test(input.apiHash.trim())) throw new Error("apiHash must be 32 hexadecimal characters");
    const phone = input.phone.trim();
    if (!/^\+?[0-9]{7,20}$/.test(phone)) throw new Error("phone must be in international format");
    const connectorId = randomUUID();
    const databaseDirectory = join(dirname(this.config.spoolRoot), "tdlib", connectorId, "db");
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    const connector = this.store.createConnector({
      id: connectorId,
      apiId: input.apiId,
      encryptedApiHash: this.vault.encrypt(input.apiHash.trim()),
      phoneMask: phoneMask(phone),
      databaseDirectory,
    });
    const challenge: AuthorizationChallenge = {
      connectorId,
      phone,
      state: "starting",
      passwordHint: "",
      expiresAt: Date.now() / 1_000 + 600,
      error: "",
      code: null,
      password: null,
    };
    this.challenges.set(connectorId, challenge);
    const expiration = setTimeout(() => {
      const current = this.challenges.get(connectorId);
      if (!current || current.state === "ready" || current.state === "failed") return;
      const error = new Error("authorization challenge expired");
      current.state = "failed";
      current.error = error.message;
      current.phone = "";
      current.code?.reject(error);
      current.password?.reject(error);
      current.code = null;
      current.password = null;
      this.store.updateConnector(connectorId, "degraded", { error: error.message });
      void this.closeClient(connectorId);
    }, 600_000);
    expiration.unref();
    this.challengeTimers.set(connectorId, expiration);
    void this.authorize(connector, input.apiHash.trim(), challenge);
    return this.authorizationStatus(connectorId)!;
  }

  private async authorize(
    connector: MtprotoConnectorRecord,
    apiHash: string,
    challenge: AuthorizationChallenge,
  ): Promise<void> {
    try {
      const client = this.createClient(connector, apiHash);
      await client.login({
        type: "user",
        getPhoneNumber: async () => challenge.phone,
        getAuthCode: async () => {
          this.ensureLive(challenge);
          challenge.state = "wait_code";
          challenge.code = new Deferred<string>();
          return challenge.code.promise;
        },
        getPassword: async (hint) => {
          this.ensureLive(challenge);
          challenge.state = "wait_password";
          challenge.passwordHint = hint;
          challenge.password = new Deferred<string>();
          return challenge.password.promise;
        },
        getEmailAddress: async () => { throw new Error("email authentication is not supported by this wizard"); },
        getEmailCode: async () => { throw new Error("email authentication is not supported by this wizard"); },
        confirmOnAnotherDevice: () => {},
        getName: async () => ({ firstName: "SUMMING" }),
      });
      challenge.state = "ready";
      challenge.phone = "";
      challenge.code = null;
      challenge.password = null;
      this.clearChallengeTimer(connector.id);
      this.store.updateConnector(connector.id, "ready", { lastUpdateAt: Date.now() / 1_000 });
    } catch (error) {
      challenge.state = "failed";
      challenge.error = String(error).slice(0, 500);
      challenge.phone = "";
      challenge.code = null;
      challenge.password = null;
      this.clearChallengeTimer(connector.id);
      this.store.updateConnector(connector.id, "degraded", { error: challenge.error });
      await this.closeClient(connector.id);
    }
  }

  submitAuthorization(connectorId: string, input: { code?: string; password?: string }): MtprotoAuthorizationStatus {
    const challenge = this.challenges.get(connectorId);
    if (!challenge) throw new Error("authorization challenge is missing or expired");
    this.ensureLive(challenge);
    if (input.code && challenge.state === "wait_code" && challenge.code) {
      const deferred = challenge.code;
      challenge.code = null;
      deferred.resolve(input.code.trim());
    } else if (input.password && challenge.state === "wait_password" && challenge.password) {
      const deferred = challenge.password;
      challenge.password = null;
      deferred.resolve(input.password);
    } else {
      throw new Error(`connector is not waiting for ${input.code ? "a code" : "a password"}`);
    }
    return this.authorizationStatus(connectorId)!;
  }

  authorizationStatus(connectorId: string): MtprotoAuthorizationStatus | null {
    const challenge = this.challenges.get(connectorId);
    if (!challenge) return null;
    return {
      connectorId,
      state: challenge.state,
      passwordHint: challenge.passwordHint,
      expiresAt: challenge.expiresAt,
      error: challenge.error,
    };
  }

  private ensureLive(challenge: AuthorizationChallenge): void {
    if (challenge.expiresAt < Date.now() / 1_000) throw new Error("authorization challenge expired");
  }

  private createClient(connector: MtprotoConnectorRecord, apiHash: string): Client {
    const existing = this.clients.get(connector.id);
    if (existing && !existing.isClosed()) return existing;
    const filesDirectory = join(this.config.spoolRoot, connector.id);
    mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
    const client = tdl.createClient({
      apiId: connector.apiId,
      apiHash,
      databaseDirectory: connector.databaseDirectory,
      filesDirectory,
      databaseEncryptionKey: this.vault.databaseKey(connector.id),
      tdlibParameters: {
        // Media jobs are durable and can outlive this process. TDLib's numeric
        // file identifiers are only safe across restarts when its file database
        // is enabled; stable remote identifiers are persisted in every new job
        // as a second recovery path.
        ...MTPROTO_PERSISTENCE_PARAMETERS,
        system_language_code: "ru",
        application_version: "SUMMING",
        device_model: "SUMMING server",
        system_version: process.platform,
      },
    });
    client.on("error", (error) => {
      this.store.updateConnector(connector.id, "degraded", { error: String(error) });
    });
    client.on("update", (update) => {
      this.store.updateConnector(connector.id, "ready", { lastUpdateAt: Date.now() / 1_000 });
      void Promise.resolve(this.updateHandler(connector.id, record(update)))
        .catch((error) => console.error("MTProto update failed", error));
    });
    this.clients.set(connector.id, client);
    return client;
  }

  async invoke(connectorId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.clients.get(connectorId);
    if (!client || client.isClosed()) throw new Error("MTProto connector is not ready");
    const invoke = client.invoke as unknown as (
      value: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    return record(await invoke(request));
  }

  async invokeHistory(
    connectorId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.historyScheduler.run(connectorId, () => this.invoke(connectorId, request));
  }

  async resolveRemoteFile(
    connectorId: string,
    remoteFileId: string,
  ): Promise<MtprotoFileReference> {
    const remoteId = remoteFileId.trim();
    if (!remoteId) throw new Error("Telegram remote file identifier is missing");
    return fileReference(await this.invoke(connectorId, {
      _: "getRemoteFile",
      remote_file_id: remoteId,
      file_type: null,
    }));
  }

  async downloadFile(connectorId: string, fileId: number): Promise<string> {
    const file = await this.invoke(connectorId, {
      _: "downloadFile",
      file_id: fileId,
      priority: 16,
      offset: 0,
      limit: 0,
      synchronous: true,
    });
    const path = String(record(file.local).path ?? "");
    if (!path) throw new Error(`TDLib did not download file ${fileId}`);
    return path;
  }

  async revoke(connectorId: string): Promise<void> {
    if (this.store.listBindings(connectorId).length > 0) {
      throw new Error("unbind every Telegram group before revoking this connector");
    }
    const connector = this.store.connector(connectorId);
    if (!connector) return;
    const sessionRoot = resolve(dirname(connector.databaseDirectory));
    const expectedSessionRoot = resolve(dirname(this.config.spoolRoot), "tdlib", connectorId);
    if (sessionRoot !== expectedSessionRoot) {
      throw new Error("refusing to remove an unexpected TDLib session directory");
    }
    const filesRoot = resolve(this.config.spoolRoot, connectorId);
    const spoolRoot = resolve(this.config.spoolRoot);
    if (filesRoot === spoolRoot || !filesRoot.startsWith(`${spoolRoot}/`)) {
      throw new Error("refusing to remove an unexpected TDLib files directory");
    }
    const client = this.clients.get(connectorId);
    if (client && !client.isClosed()) {
      try { await this.invoke(connectorId, { _: "logOut" }); } catch { /* continue with local revocation */ }
      await this.closeClient(connectorId);
    }
    this.store.updateConnector(connectorId, "revoked");
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(filesRoot, { recursive: true, force: true });
    this.store.deleteRevokedConnector(connectorId);
    this.historyScheduler.forget(connectorId);
    this.challenges.delete(connectorId);
    this.clearChallengeTimer(connectorId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.keys()].map((id) => this.closeClient(id)));
    for (const challenge of this.challenges.values()) {
      challenge.code?.reject(new Error("SUMMING stopped"));
      challenge.password?.reject(new Error("SUMMING stopped"));
      challenge.phone = "";
    }
    this.challenges.clear();
    for (const timer of this.challengeTimers.values()) clearTimeout(timer);
    this.challengeTimers.clear();
  }

  private clearChallengeTimer(connectorId: string): void {
    const timer = this.challengeTimers.get(connectorId);
    if (timer) clearTimeout(timer);
    this.challengeTimers.delete(connectorId);
  }

  private async closeClient(connectorId: string): Promise<void> {
    const client = this.clients.get(connectorId);
    this.clients.delete(connectorId);
    if (client && !client.isClosed()) await client.close().catch(() => {});
  }
}
