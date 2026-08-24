import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { RunnerJob } from "../src/project-runner-client.js";
import { SummingRuntime } from "../src/runtime.js";
import { StateStore } from "../src/state-store.js";

function fixture(): {
  root: string;
  repository: string;
  runtime: SummingRuntime;
} {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-portal-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig("demo", "Demo", "repo", new Map([["repo", workspace]]));
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
  ));
  Object.assign(runtime, { telegramBotId: 123, telegramUsername: "summing_bot" });
  return { root, repository, runtime };
}

test("runner messages use the same durable Project portal transport", async () => {
  const { root, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "external-readonly", {
    portalKey: "main",
    isDefault: true,
  });
  runtime.state.bind(-100501, 10, "demo", "repo", "external-readonly", {
    portalKey: "reports",
    isDefault: false,
  });
  const job: RunnerJob = {
    id: "768d307d-1234-4567-89ab-123456789012",
    projectId: "demo",
    workspaceId: "repo",
    action: "dry-run",
    revision: "a".repeat(40),
    status: "completed",
    portalMessageCount: 1,
    createdAt: "2026-08-20T08:00:00.000Z",
  };
  runtime.viewer.runner.portalMessages = async () => ({
    projectId: "demo",
    workspaceId: "repo",
    jobId: job.id,
    messages: [{
      id: "dry-run-report",
      type: "document",
      text: "Информационный dry-run готов.",
      artifact: "report.html",
      portalKey: "reports",
    }],
    createdAt: "2026-08-20T08:00:00.000Z",
  });
  runtime.viewer.runner.artifact = async () => ({
    name: "report.html",
    bytes: 19,
    contentType: "text/html",
    content: "<html>report</html>",
  });
  const deliveries: Array<{ chatId: number; fileName: string; topicId?: number; caption?: string }> = [];
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendDocument = async (chatId, _content, fileName, _contentType, options) => {
    deliveries.push({
      chatId,
      fileName,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.caption === undefined ? {} : { caption: options.caption }),
    });
    return 245;
  };
  try {
    const delivered = await (
      runtime as unknown as {
        sendRunnerPortalMessages(
          job: RunnerJob,
          conversationId: string,
          actorUserId: number,
        ): Promise<boolean>;
      }
    ).sendRunnerPortalMessages(job, internal.id, 1);
    assert.equal(delivered, true);
    assert.deepEqual(deliveries, [{
      chatId: -100501,
      fileName: "report.html",
      topicId: 10,
      caption: "Информационный dry-run готов.",
    }]);
    const source = runtime.state.teamSourceForProvider("telegram", "-100501", "10");
    assert.ok(source);
    assert.equal(runtime.state.recentTeamEvents(source.spaceId, source.id)[0]?.externalEventId, "245");
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authorized Project agent can forward an incoming workspace attachment", async () => {
  const { root, repository, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  const portal = runtime.state.bind(-100500, 9, "demo", "repo", "external-readonly");
  const attachmentDirectory = join(repository, ".summing-runtime", "attachments");
  mkdirSync(attachmentDirectory, { recursive: true });
  const attachmentPath = join(attachmentDirectory, "42-7-customer-brief.pdf");
  writeFileSync(attachmentPath, "%PDF-1.7 customer brief");
  const active = {
    conversation: internal,
    prepared: {
      path: repository,
      readableRoot: repository,
      gitMetadataRoots: [],
      projectMemorySnapshot: "",
    },
    access: "write",
    actorUserId: 1,
    turnId: "turn-forward",
  };
  (runtime as unknown as { activeByThread: Map<string, unknown> }).activeByThread
    .set("thread-forward", active);
  const deliveries: Array<{
    chatId: number;
    data: string;
    fileName: string;
    topicId?: number;
    caption?: string;
  }> = [];
  const textDeliveries: Array<{
    chatId: number;
    text: string;
    topicId?: number;
    replyTo?: number;
  }> = [];
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendDocument = async (chatId, data, fileName, _contentType, options) => {
    deliveries.push({
      chatId,
      data: Buffer.from(data).toString("utf8"),
      fileName,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.caption === undefined ? {} : { caption: options.caption }),
    });
    return 246;
  };
  runtime.telegram.sendMessage = async (chatId, text, options) => {
    textDeliveries.push({
      chatId,
      text,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    });
    return 247;
  };
  try {
    const result = await runtime.projectPortalTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
      },
      "send",
      {
        portalId: portal.id,
        text: "Бриф от исполнителя",
        filePath: ".summing-runtime/attachments/42-7-customer-brief.pdf",
      },
    ) as Record<string, unknown>;
    assert.match(String(result.outboxId), /^[a-f0-9]{64}$/);
    assert.equal(result.portalId, portal.id);
    assert.equal(result.status, "sent");
    assert.equal(result.telegramMessageId, 246);
    assert.deepEqual(result.attachment, {
      fileName: "42-7-customer-brief.pdf",
      mimeType: "application/pdf",
      size: 23,
    });
    assert.deepEqual(deliveries, [{
      chatId: -100500,
      data: "%PDF-1.7 customer brief",
      fileName: "42-7-customer-brief.pdf",
      topicId: 9,
      caption: "Бриф от исполнителя",
    }]);
    const customerEvent = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Customer chat",
      sourceTitle: "Customer topic",
      externalEventId: "78061",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Customer",
      text: "Пожалуйста, пришлите итоговый вариант.",
      attachments: [{
        kind: "document",
        fileName: "customer-notes.txt",
        mimeType: "text/plain",
        size: 14,
        providerFileId: "telegram-notes",
      }],
      occurredAt: Date.now() / 1_000,
      administratorUserId: 1,
    });
    assert.ok(customerEvent);
    runtime.knowledgeSync.store.grantConsent({
      sourceId: StateStore.teamSourceId("telegram", "-100500", "0"),
      telegramUserId: 42,
      proof: "group-level test fixture consent",
    });
    const storedArtifact = runtime.projectPortalArtifacts.store({
      projectId: "demo",
      workspaceId: "repo",
      portalId: portal.id,
      portalKey: "main",
      eventId: customerEvent.id,
      telegramMessageId: 78061,
      providerFileId: "telegram-notes",
      kind: "document",
      fileName: "customer-notes.txt",
      mimeType: "text/plain",
      data: new TextEncoder().encode("customer notes"),
    });
    runtime.state.attachTeamEventArtifact(customerEvent.id, {
      providerFileId: "telegram-notes",
      artifactId: storedArtifact.id,
      sha256: storedArtifact.sha256,
    });
    const history = await runtime.projectPortalTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
      },
      "history",
      { portalKey: "main", attachmentsOnly: true },
    ) as { events: Array<{ portalKey: string; attachments: Array<{ artifactId: string }> }> };
    assert.equal(history.events[0]?.portalKey, "main");
    assert.equal(history.events[0]?.attachments[0]?.artifactId, storedArtifact.id);
    const materialized = await runtime.projectPortalTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
      },
      "materialize_attachment",
      { attachmentId: storedArtifact.id },
    ) as { relativePath: string };
    const materializedPath = join(repository, materialized.relativePath);
    assert.equal(existsSync(materializedPath), true);
    assert.equal(readFileSync(materializedPath, "utf8"), "customer notes");
    const textResult = await runtime.projectPortalTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
      },
      "send",
      {
        portalId: portal.id,
        text: "Принято, итоговый вариант приложим сегодня.",
        replyToEventId: customerEvent.id,
      },
    ) as Record<string, unknown>;
    assert.equal(textResult.status, "sent");
    assert.equal(textResult.telegramMessageId, 247);
    assert.deepEqual(textDeliveries, [{
      chatId: -100500,
      text: "Принято, итоговый вариант приложим сегодня.",
      topicId: 9,
      replyTo: 78061,
    }]);
    const forwardedArtifact = await runtime.projectPortalTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
      },
      "send",
      { portalKey: "main", attachmentIds: [storedArtifact.id], text: "Файл заказчика" },
    ) as Record<string, unknown>;
    assert.equal(forwardedArtifact.status, "sent");
    assert.equal(deliveries[1]?.data, "customer notes");
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
