import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { RunnerJob } from "../src/project-runner-client.js";
import type { RunnerSchedule } from "../src/runner-control.js";
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

test("live runner messages deliver every native media kind through the durable Project portal transport", async () => {
  const { root, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "observer", {
    portalKey: "main",
    isDefault: true,
  });
  runtime.state.bindProjectTopicDestination({
    projectId: "demo",
    workspaceId: "repo",
    chatId: -100500,
    topicId: 9,
    createdBy: 1,
  });
  runtime.state.bind(-100501, 10, "demo", "repo", "observer", {
    portalKey: "reports",
    isDefault: false,
  });
  const attachments = [
    { id: "report", type: "document", text: "Report ready.", artifact: "report.html", contentType: "text/html" },
    { id: "photo", type: "photo", text: "Photo ready.", artifact: "photo-01.jpg", contentType: "image/jpeg" },
    { id: "audio", type: "audio", text: "Audio ready.", artifact: "audio-01.mp3", contentType: "audio/mpeg" },
    { id: "video", type: "video", text: "Video ready.", artifact: "video-01.mp4", contentType: "video/mp4" },
    { id: "animation", type: "animation", text: "Animation ready.", artifact: "animation-01.gif", contentType: "image/gif" },
    { id: "voice", type: "voice", text: "Voice ready.", artifact: "voice-01.ogg", contentType: "audio/ogg" },
  ] as const;
  const job: RunnerJob = {
    id: "768d307d-1234-4567-89ab-123456789012",
    projectId: "demo",
    workspaceId: "repo",
    action: "run",
    revision: "a".repeat(40),
    status: "completed",
    portalMessageCount: attachments.length,
    createdAt: "2026-08-20T08:00:00.000Z",
  };
  runtime.viewer.runner.portalMessages = async () => ({
    projectId: "demo",
    workspaceId: "repo",
    jobId: job.id,
    messages: attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      text: attachment.text,
      artifact: attachment.artifact,
      portalKey: "reports",
    })),
    createdAt: "2026-08-20T08:00:00.000Z",
  });
  runtime.viewer.runner.artifactData = async (_projectId, _jobId, name) => {
    const index = attachments.findIndex((attachment) => attachment.artifact === name);
    const attachment = attachments[index];
    assert.ok(attachment);
    return {
      name,
      bytes: 1,
      contentType: attachment.contentType,
      data: Uint8Array.from([index]),
    };
  };
  const deliveries: Array<{
    kind: string;
    chatId: number;
    fileName: string;
    contentType: string;
    topicId?: number;
    caption?: string;
    data: number[];
  }> = [];
  const actions: string[] = [];
  runtime.telegram.sendChatAction = async (_chatId, action) => {
    actions.push(action);
  };
  runtime.telegram.sendAttachment = async (kind, chatId, content, fileName, contentType, options) => {
    deliveries.push({
      kind,
      chatId,
      fileName,
      contentType,
      data: [...content],
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.caption === undefined ? {} : { caption: options.caption }),
    });
    return 245 + deliveries.length - 1;
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
    assert.deepEqual(
      deliveries.toSorted((left, right) => left.fileName.localeCompare(right.fileName)),
      attachments.map((attachment, index) => ({
        kind: attachment.type,
        chatId: -100501,
        fileName: attachment.artifact,
        contentType: attachment.contentType,
        topicId: 10,
        caption: attachment.text,
        data: [index],
      })).toSorted((left, right) => left.fileName.localeCompare(right.fileName)),
    );
    assert.deepEqual(actions.toSorted(), [
      "upload_document",
      "upload_photo",
      "upload_document",
      "upload_video",
      "upload_video",
      "upload_voice",
    ].toSorted());
    const source = runtime.state.teamSourceForProvider("telegram", "-100501", "10");
    assert.ok(source);
    assert.deepEqual(
      runtime.state.recentTeamEvents(source.spaceId, source.id)
        .map((event) => event.externalEventId)
        .sort(),
      ["245", "246", "247", "248", "249", "250"],
    );
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed live-run recovery retries artifact handoff and owner notification without duplicating the native video", async () => {
  const { root, repository, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "observer", {
    portalKey: "main", isDefault: true,
  });
  const job: RunnerJob = {
    id: "f4edc136-bfe4-47ab-a889-62bbcfc82a53",
    projectId: "demo", workspaceId: "repo", action: "run", revision: "a".repeat(40),
    status: "failed", exitCode: 1, error: "invalid_grant", portalMessageCount: 1,
    createdAt: "2026-09-04T09:16:26.000Z", completedAt: "2026-09-04T09:20:11.000Z",
  };
  runtime.viewer.runner.available = async () => true;
  runtime.viewer.runner.jobs = async () => [job];
  runtime.viewer.runner.portalMessages = async () => ({
    projectId: job.projectId, workspaceId: job.workspaceId, jobId: job.id,
    createdAt: job.completedAt!,
    messages: [{ id: "video-1", type: "video", text: "Video saved; YouTube failed.", artifact: "video-01.mp4" }],
  });
  let artifactReads = 0;
  runtime.viewer.runner.artifactData = async () => {
    if (++artifactReads === 1) throw new Error("temporary runner artifact read failure");
    return { name: "video-01.mp4", bytes: 3, contentType: "video/mp4", data: Uint8Array.from([1, 2, 3]) };
  };
  let videoSends = 0;
  let ownerAttempts = 0;
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendAttachment = async (kind, chatId, data, fileName, mimeType, options) => {
    assert.equal(kind, "video");
    assert.equal(chatId, -100500);
    assert.equal(options?.topicId, 9);
    assert.equal(fileName, "video-01.mp4");
    assert.equal(mimeType, "video/mp4");
    assert.deepEqual([...data], [1, 2, 3]);
    videoSends++;
    return 80567;
  };
  runtime.telegram.sendMessage = async (chatId, text) => {
    assert.equal(chatId, 1);
    assert.match(text, /invalid_grant/);
    if (++ownerAttempts === 1) throw new Error("temporary owner notification failure");
    return 80568;
  };
  try {
    runtime.runnerControl.store.watchJob({
      projectId: "demo", workspaceId: "repo", repositoryPath: repository,
      conversationId: internal.id, actorUserId: 1, turnId: "failed-run-turn",
    }, { ...job, status: "queued" }, Date.now());

    await runtime.runnerControl.tick();
    assert.equal(videoSends, 0);
    assert.equal(runtime.runnerControl.store.jobWatch(job.id)?.notifiedAt, null);

    await runtime.runnerControl.tick();
    assert.equal(videoSends, 1);
    assert.equal(ownerAttempts, 1);
    assert.equal(runtime.runnerControl.store.jobWatch(job.id)?.notifiedAt, null);

    await runtime.runnerControl.tick();
    await runtime.runnerControl.tick();
    assert.equal(artifactReads, 3);
    assert.equal(videoSends, 1);
    assert.equal(ownerAttempts, 2);
    assert.equal(runtime.runnerControl.store.jobWatch(job.id)?.lastStatus, "failed");
    assert.ok(runtime.runnerControl.store.jobWatch(job.id)?.notifiedAt);
    const records = runtime.projectPortalOutbox.list({ projectId: "demo" });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "sent");
    assert.equal(records[0]?.kind, "video");
    assert.equal(records[0]?.idempotencyKey, `runner:${job.id}:video-1`);
    assert.equal(runtime.state.resultPublicationForMessage(-100500, 9, 80567)?.jobId, job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 1);
  } finally {
    runtime.runnerControl.close();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled reports deliver to an observed topic without an observer binding or portalKey", async () => {
  const { root, runtime } = fixture();
  runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.recordTelegramChat({
    chatId: -100700,
    type: "supergroup",
    title: "Customer",
    isForum: true,
    observedAt: 1_777_000_000,
  });
  runtime.state.recordTelegramTopic(-100700, 67800, "Reports", 1_777_000_000);
  const resolved = (
    runtime as unknown as {
      resolveRunnerScheduleDestination(
        context: {
          projectId: string;
          workspaceId: string;
          repositoryPath: string;
          conversationId: string;
          actorUserId: number;
          turnId: string;
        },
        query: string,
      ): { chatId: number; topicId: number; label: string };
    }
  ).resolveRunnerScheduleDestination({
    projectId: "demo",
    workspaceId: "repo",
    repositoryPath: "unused",
    conversationId: runtime.state.byTopic(1, 0)!.id,
    actorUserId: 1,
    turnId: "turn-schedule",
  }, "Reports");
  assert.deepEqual(resolved, {
    chatId: -100700,
    topicId: 67800,
    label: "«Customer» / «Reports»",
  });
  const schedule: RunnerSchedule = {
    id: "df4fc608-e584-4263-9712-e53d779f9bd8",
    projectId: "demo",
    workspaceId: "repo",
    name: "Утренний отчёт",
    action: "dry-run",
    time: "08:30",
    timeZone: "Europe/Moscow",
    weekdays: [1, 2, 3, 4, 5],
    enabled: true,
    revisionRef: "master",
    overlapPolicy: "skip",
    misfireGraceMinutes: 30,
    delivery: {
      chatId: -100700,
      topicId: 67800,
      label: "«Customer» / «Reports»",
    },
    deliveryCondition: "success",
    notifications: [],
    originConversationId: runtime.state.byTopic(1, 0)!.id,
    createdBy: 1,
    updatedBy: 1,
    createdAt: "2026-08-20T05:00:00.000Z",
    updatedAt: "2026-08-20T05:00:00.000Z",
  };
  const job: RunnerJob = {
    id: "5786a587-d5de-4da3-91dc-da90e7aef28d",
    projectId: "demo",
    workspaceId: "repo",
    action: "dry-run",
    revision: "b".repeat(40),
    trigger: "schedule",
    scheduleId: schedule.id,
    status: "completed",
    portalMessageCount: 1,
    createdAt: "2026-08-20T05:30:00.000Z",
  };
  runtime.viewer.runner.portalMessages = async () => ({
    projectId: "demo",
    workspaceId: "repo",
    jobId: job.id,
    messages: [{
      id: "report",
      type: "document",
      text: "Отчёт готов.",
      artifact: "report.html",
      portalKey: "obsolete-key",
    }],
    createdAt: "2026-08-20T05:31:00.000Z",
  });
  runtime.viewer.runner.artifactData = async () => ({
    name: "report.html",
    bytes: 19,
    contentType: "text/html",
    data: new TextEncoder().encode("<html>report</html>"),
  });
  const deliveries: Array<{ chatId: number; topicId?: number; fileName: string }> = [];
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendAttachment = async (_kind, chatId, _content, fileName, _contentType, options) => {
    deliveries.push({
      chatId,
      fileName,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
    });
    return 512;
  };
  try {
    const delivered = await (
      runtime as unknown as {
        sendScheduledRunnerPortalMessages(
          reportJob: RunnerJob,
          reportSchedule: RunnerSchedule,
        ): Promise<boolean>;
      }
    ).sendScheduledRunnerPortalMessages(job, schedule);
    assert.equal(delivered, true);
    assert.deepEqual(deliveries, [{ chatId: -100700, topicId: 67800, fileName: "report.html" }]);
    assert.equal(runtime.state.byTopic(-100700, 67800), null);
    const record = runtime.projectPortalOutbox.list({ projectId: "demo" })[0]!;
    assert.equal(record.destinationType, "topic");
    assert.equal(record.portalKey, undefined);
    assert.deepEqual(record.context, {
      kind: "runner-report",
      jobId: job.id,
      scheduleId: schedule.id,
    });
    const publication = runtime.state.resultPublicationForMessage(-100700, 67800, 512);
    assert.equal(publication?.jobId, job.id);
    assert.equal(publication?.scheduleId, schedule.id);
    assert.equal(runtime.state.customerChannel(-100700, 67800)?.title, "Reports");
    assert.deepEqual(
      runtime.state.resultDiscussion(publication!.id).map((message) => message.author),
      ["publication"],
    );
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portal history reports hidden comments without exposing their author or contents", async () => {
  const { root, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "observer", {
    portalKey: "main",
    isDefault: true,
  });
  (runtime as unknown as { activeByThread: Map<string, unknown> }).activeByThread.set(
    "thread-history",
    {
      conversation: internal,
      prepared: { path: root, readableRoot: root, gitMetadataRoots: [], projectMemorySnapshot: "" },
      access: "write",
      actorUserId: 1,
      turnId: "turn-history",
    },
  );
  runtime.state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "9",
    spaceName: "Customer chat",
    sourceTitle: "Customer topic",
    externalEventId: "900",
    eventKind: "message",
    senderExternalId: "123",
    senderDisplayName: "SUMMING",
    text: "Dry-run report",
    occurredAt: 100,
    administratorUserId: 1,
  });
  runtime.state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "9",
    spaceName: "Customer chat",
    sourceTitle: "Customer topic",
    externalEventId: "901",
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Confidential Customer",
    text: "private feedback original",
    occurredAt: 110,
    administratorUserId: 1,
  });
  runtime.state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "9",
    spaceName: "Customer chat",
    sourceTitle: "Customer topic",
    externalEventId: "901:update:1",
    eventKind: "edit",
    senderExternalId: "42",
    senderDisplayName: "Confidential Customer",
    text: "private feedback edited",
    occurredAt: 120,
    administratorUserId: 1,
  });
  try {
    const history = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-history",
        callId: "history-main",
      },
      "history",
      { chatId: -100500, topicId: 9 },
    ) as {
      events: Array<{ text: string }>;
      hiddenByConsent: { commentCount: number; latestOccurredAt: string | null };
    };
    assert.deepEqual(history.events.map((event) => event.text), ["Dry-run report"]);
    assert.deepEqual(history.hiddenByConsent, {
      commentCount: 1,
      latestOccurredAt: "1970-01-01T00:02:00.000Z",
    });
    const serialized = JSON.stringify(history);
    assert.doesNotMatch(serialized, /Confidential Customer/);
    assert.doesNotMatch(serialized, /private feedback/);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner context sees consented feedback linked to a concrete result", async () => {
  const { root, runtime } = fixture();
  const primary = runtime.state.bind(1, 0, "demo", "repo", "primary");
  const publication = runtime.state.recordResultPublication({
    projectId: "demo",
    workspaceId: "repo",
    jobId: "daily-report",
    scheduleId: "morning",
    outboxId: "result-feedback-test",
    reportText: "Published project result",
    chatId: -100500,
    topicId: 9,
    channelTitle: "Customer results",
    telegramMessageId: 900,
    createdAt: 100,
  });
  const event = runtime.state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "9",
    spaceName: "Customer group",
    sourceTitle: "Customer results",
    externalEventId: "901",
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Observer",
    text: "Please keep the previous export format",
    occurredAt: 110,
    administratorUserId: 1,
  });
  assert.ok(event);
  const feedback = runtime.state.recordProjectFeedback({
    publicationId: publication.id,
    teamEventId: event.id,
    telegramMessageId: 901,
    senderId: 42,
    text: "Please keep the previous export format",
    createdAt: 110,
  });
  runtime.knowledgeSync.store.grantConsent({
    sourceId: event.sourceId,
    telegramUserId: 42,
    proof: "observer feedback test consent",
  });
  const context = {
    projectId: "demo",
    workspaceId: "repo",
    conversationId: primary.id,
    actorUserId: 1,
    turnId: "turn-result-feedback",
  };
  try {
    const ownerFeedback = await runtime.projectContextTool(
      context,
      "search",
      { limit: 20 },
    ) as { feedback: Array<{ text: string; channelTitle: string }> };
    assert.deepEqual(ownerFeedback.feedback, [{
      feedbackId: feedback.id,
      resultId: publication.id,
      channelId: publication.channelId,
      channelTitle: "Customer results",
      telegramMessageId: 901,
      telegramUserId: 42,
      occurredAt: 110,
      status: "new",
      text: "Please keep the previous export format",
    }]);
    const sources = await runtime.projectContextTool(
      context,
      "sources",
      {},
    ) as { channels: Array<{ channelId: string; title: string }> };
    assert.deepEqual(sources.channels, [{
      channelId: publication.channelId,
      transport: "telegram",
      chatId: -100500,
      topicId: 9,
      title: "Customer results",
    }]);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authorized owner can idempotently send only into one exact result discussion", async () => {
  const { root, repository, runtime } = fixture();
  const primary = runtime.state.bind(1, 0, "demo", "repo", "primary");
  runtime.state.recordTelegramChat({
    chatId: -100500,
    type: "supergroup",
    title: "Customer",
    isForum: true,
    observedAt: 100,
  });
  runtime.state.recordTelegramTopic(-100500, 9, "Customer results", 100);
  const publication = runtime.state.recordResultPublication({
    projectId: "demo",
    workspaceId: "repo",
    jobId: "daily-report",
    scheduleId: "morning",
    outboxId: "result-send-test",
    reportText: "Published project result",
    chatId: -100500,
    topicId: 9,
    channelTitle: "Customer results",
    telegramMessageId: 700,
    createdAt: 100,
  });
  runtime.state.recordResultPublication({
    projectId: "other-project",
    workspaceId: "repo",
    jobId: "other-report",
    outboxId: "other-result-send-test",
    chatId: -100501,
    topicId: 10,
    telegramMessageId: 800,
    createdAt: 101,
  });
  const otherResult = runtime.state.resultPublicationsForProject("other-project", "repo")[0]!;
  writeFileSync(join(repository, "customer-summary.txt"), "customer-safe summary\n");
  const active = {
    conversation: primary,
    prepared: {
      path: repository,
      readableRoot: repository,
      gitMetadataRoots: [],
      projectMemorySnapshot: "",
    },
    access: "write",
    actorUserId: 1,
    turnId: "turn-result-send",
  };
  (runtime as unknown as { activeByThread: Map<string, unknown> }).activeByThread
    .set("thread-result-send", active);
  const textDeliveries: Array<{ chatId: number; text: string; topicId?: number; replyTo?: number }> = [];
  const fileDeliveries: Array<{ chatId: number; fileName: string; topicId?: number; replyTo?: number }> = [];
  runtime.telegram.sendMessage = async (chatId, text, options) => {
    textDeliveries.push({
      chatId,
      text,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    });
    return 701;
  };
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendAttachment = async (_kind, chatId, _data, fileName, _mimeType, options) => {
    fileDeliveries.push({
      chatId,
      fileName,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    });
    return 702;
  };
  const context = {
    projectId: "demo",
    workspaceId: "repo",
    conversationId: primary.id,
    actorUserId: 1,
    turnId: "turn-result-send",
  };
  try {
    const first = await runtime.projectContextTool(context, "send", {
      resultId: publication.id,
      text: "Уточнённый итог готов.",
      idempotencyKey: "owner-update-v1",
    }) as { outboxId: string; status: string; telegramMessageId: number };
    const duplicate = await runtime.projectContextTool(context, "send", {
      resultId: publication.id,
      text: "Уточнённый итог готов.",
      idempotencyKey: "owner-update-v1",
    }) as { outboxId: string; status: string; telegramMessageId: number };
    assert.deepEqual(duplicate, first);
    assert.deepEqual(textDeliveries, [{
      chatId: -100500,
      text: "Уточнённый итог готов.",
      topicId: 9,
      replyTo: 700,
    }]);
    const attachment = await runtime.projectContextTool(context, "send", {
      resultId: publication.id,
      text: "Файл к уточнению.",
      filePaths: ["customer-summary.txt"],
      replyToMessageId: 701,
      idempotencyKey: "owner-update-file-v1",
    }) as { status: string };
    assert.equal(attachment.status, "sent");
    assert.deepEqual(fileDeliveries, [{
      chatId: -100500,
      fileName: "customer-summary.txt",
      topicId: 9,
      replyTo: 701,
    }]);
    assert.deepEqual(
      runtime.state.resultDiscussion(publication.id).map((message) => message.author),
      ["publication", "agent", "agent"],
    );
    assert.deepEqual(
      runtime.projectPortalOutbox.list({ projectId: "demo" }).map((record) => record.context),
      [
        { kind: "result-reply", resultId: publication.id },
        { kind: "result-reply", resultId: publication.id },
      ],
    );
    await assert.rejects(
      runtime.projectContextTool(context, "send", {
        resultId: otherResult.id,
        text: "Cross-project send",
      }),
      /not published by the active Project workspace/,
    );
    await assert.rejects(
      runtime.projectContextTool({ ...context, turnId: "wrong-turn" }, "send", {
        resultId: publication.id,
        text: "Wrong turn",
      }),
      /active authorized owner turn/,
    );
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authorized Project agent can forward an incoming workspace attachment", async () => {
  const { root, repository, runtime } = fixture();
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "observer", {
    portalKey: "main",
  });
  runtime.state.bind(-100501, 10, "demo", "repo", "observer", {
    portalKey: "releases",
  });
  runtime.state.bindProjectTopicDestination({
    projectId: "demo",
    workspaceId: "repo",
    chatId: -100500,
    topicId: 9,
    createdBy: 1,
  });
  runtime.state.bindProjectTopicDestination({
    projectId: "demo",
    workspaceId: "repo",
    chatId: -100501,
    topicId: 10,
    createdBy: 1,
  });
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
  runtime.telegram.sendAttachment = async (_kind, chatId, data, fileName, _contentType, options) => {
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
    const result = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "send-brief",
      },
      "send",
      {
        chatId: -100500,
        topicId: 9,
        text: "Бриф от исполнителя",
        filePaths: [".summing-runtime/attachments/42-7-customer-brief.pdf"],
      },
    ) as Record<string, unknown>;
    assert.match(String(result.outboxId), /^[a-f0-9]{64}$/);
    assert.equal(result.chatId, -100500);
    assert.equal(result.topicId, 9);
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
      sourceId: customerEvent.sourceId,
      chatId: -100500,
      topicId: 9,
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
    const history = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "history-attachments",
      },
      "history",
      { chatId: -100500, topicId: 9, attachmentsOnly: true },
    ) as {
      events: Array<{ chatId: number; topicId: number; attachments: Array<{ artifactId: string }> }>;
      hiddenByConsent: { commentCount: number; latestOccurredAt: string | null };
    };
    assert.equal(history.events[0]?.chatId, -100500);
    assert.equal(history.events[0]?.topicId, 9);
    assert.equal(history.events[0]?.attachments[0]?.artifactId, storedArtifact.id);
    assert.deepEqual(history.hiddenByConsent, { commentCount: 0, latestOccurredAt: null });
    const materialized = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "materialize-notes",
      },
      "materialize_attachment",
      { attachmentId: storedArtifact.id },
    ) as { relativePath: string };
    const materializedPath = join(repository, materialized.relativePath);
    assert.equal(existsSync(materializedPath), true);
    assert.equal(readFileSync(materializedPath, "utf8"), "customer notes");
    const textResult = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "reply-customer",
      },
      "send",
      {
        chatId: -100500,
        topicId: 9,
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
    const forwardedArtifact = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "forward-notes",
      },
      "send",
      {
        chatId: -100500,
        topicId: 9,
        attachmentIds: [storedArtifact.id],
        text: "Файл заказчика",
      },
    ) as Record<string, unknown>;
    assert.equal(forwardedArtifact.status, "sent");
    assert.equal(deliveries[1]?.data, "customer notes");
    const releaseInput = {
      chatId: -100501,
      topicId: 10,
      text: "Версия 2.4 успешно опубликована.",
    };
    const release = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "release-2.4",
      },
      "send",
      releaseInput,
    ) as Record<string, unknown>;
    const repeated = await runtime.externalMessageTool(
      {
        projectId: "demo",
        workspaceId: "repo",
        conversationId: internal.id,
        actorUserId: 1,
        turnId: "turn-forward",
        callId: "release-2.4",
      },
      "send",
      releaseInput,
    ) as Record<string, unknown>;
    assert.equal(release.outboxId, repeated.outboxId);
    assert.deepEqual(textDeliveries[1], {
      chatId: -100501,
      text: "Версия 2.4 успешно опубликована.",
      topicId: 10,
    });
    assert.equal(textDeliveries.length, 2);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
