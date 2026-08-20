import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const IDENTIFIER = /^[A-Za-z0-9._-]{1,120}$/;
const MAXIMUM_REQUEST_BYTES = 64_000;
const MAXIMUM_CAPTION_CHARACTERS = 900;

export interface RunnerReportDelivery {
  chatId: number;
  topicId: number;
}

export interface RunnerReportView {
  projectId: string;
  workspaceId: string;
  jobId: string;
  reportId: string;
  reportArtifact: "report.html";
  message: string;
  chatId: number;
  topicId: number;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export class RunnerReportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function requestObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RunnerReportError(409, "report-request.json is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunnerReportError(409, "report-request.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

export class RunnerReportStore {
  private readonly root: string;

  constructor(dataRoot: string, readonly now: () => Date = () => new Date()) {
    this.root = resolve(dataRoot, "report-deliveries");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  capture(input: {
    projectId: string;
    workspaceId: string;
    jobId: string;
    artifactDirectory: string;
    delivery: RunnerReportDelivery | null;
  }): RunnerReportView | null {
    const requestPath = resolve(input.artifactDirectory, "report-request.json");
    if (!existsSync(requestPath)) return null;
    if (!input.delivery) {
      throw new RunnerReportError(
        409,
        "report delivery requires REPORT_CHAT_ID and REPORT_THREAD_ID in one environment snapshot",
      );
    }
    const metadata = lstatSync(requestPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > MAXIMUM_REQUEST_BYTES
    ) {
      throw new RunnerReportError(409, "report-request.json is not a bounded regular file");
    }
    const existing = this.byJob(input.projectId, input.workspaceId, input.jobId);
    if (existing) return existing;
    const raw = requestObject(requestPath);
    const allowedKeys = new Set(["schemaVersion", "reportId", "reportArtifact", "message"]);
    if (raw.schemaVersion !== 1 || Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new RunnerReportError(409, "report request schema is invalid");
    }
    const reportId = String(raw.reportId ?? "");
    const message = String(raw.message ?? "").trim();
    if (!IDENTIFIER.test(reportId)) throw new RunnerReportError(409, "reportId is invalid");
    if (raw.reportArtifact !== "report.html") {
      throw new RunnerReportError(409, "reportArtifact must be report.html");
    }
    if (!message || Array.from(message).length > MAXIMUM_CAPTION_CHARACTERS) {
      throw new RunnerReportError(409, "report message must contain 1-900 characters");
    }
    const reportPath = resolve(input.artifactDirectory, "report.html");
    if (
      !existsSync(reportPath) ||
      !lstatSync(reportPath).isFile() ||
      lstatSync(reportPath).isSymbolicLink()
    ) {
      throw new RunnerReportError(409, "report.html artifact is missing or unsafe");
    }
    const timestamp = this.now().toISOString();
    const report: RunnerReportView = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      reportId,
      reportArtifact: "report.html",
      message,
      chatId: input.delivery.chatId,
      topicId: input.delivery.topicId,
      messageId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    atomicJson(this.path(input.projectId, input.workspaceId, input.jobId), report);
    return report;
  }

  byJob(projectId: string, workspaceId: string, jobId: string): RunnerReportView | null {
    const path = this.path(projectId, workspaceId, jobId);
    if (!existsSync(path)) return null;
    return requestObject(path) as unknown as RunnerReportView;
  }

  bindMessage(input: {
    projectId: string;
    workspaceId: string;
    jobId: string;
    chatId: number;
    topicId: number;
    messageId: number;
  }): RunnerReportView {
    const report = this.byJob(input.projectId, input.workspaceId, input.jobId);
    if (!report) throw new RunnerReportError(404, "report request was not found");
    if (
      report.chatId !== input.chatId ||
      report.topicId !== input.topicId ||
      !Number.isSafeInteger(input.messageId) ||
      input.messageId <= 0
    ) {
      throw new RunnerReportError(409, "report message is outside its configured portal scope");
    }
    if (report.messageId !== null && report.messageId !== input.messageId) {
      throw new RunnerReportError(409, "report is already bound to another Telegram message");
    }
    const updated = { ...report, messageId: input.messageId, updatedAt: this.now().toISOString() };
    atomicJson(this.path(input.projectId, input.workspaceId, input.jobId), updated);
    return updated;
  }

  private path(projectId: string, workspaceId: string, jobId: string): string {
    for (const [name, value] of Object.entries({ projectId, workspaceId, jobId })) {
      if (!IDENTIFIER.test(value)) throw new RunnerReportError(400, `${name} is invalid`);
    }
    return resolve(this.root, `${projectId}--${workspaceId}--${jobId}.json`);
  }
}
