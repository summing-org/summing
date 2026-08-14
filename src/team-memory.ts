import type {
  TeamEventAttachment,
  TeamEventInput,
  TeamEvent,
  TeamKnowledgeItem,
  TeamSpace,
  TeamUnderstandingResult,
} from "./state-store.js";
import type { TelegramObject } from "./telegram-api.js";

const TEAM_KNOWLEDGE_KINDS = new Set([
  "episode",
  "fact",
  "decision",
  "task",
  "question",
  "risk",
  "term",
  "person",
  "hypothesis",
]);
const MODEL_KNOWLEDGE_KINDS = [...TEAM_KNOWLEDGE_KINDS]
  .filter((kind) => kind !== "episode");
const TEAM_KNOWLEDGE_STATUSES = new Set([
  "active",
  "resolved",
  "superseded",
  "needs-review",
]);
const TEAM_KNOWLEDGE_VISIBILITIES = new Set(["space", "source", "person"]);

const nullableNumberSchema = {
  anyOf: [{ type: "number" }, { type: "null" }],
};

export const TEAM_UNDERSTANDING_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    episode: {
      type: "object",
      properties: {
        source_id: { type: "string" },
        subject: { type: "string" },
        synopsis: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        event_ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer" },
        },
        participants: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              person_id: { type: "string" },
              role: {
                type: "string",
                enum: ["speaker", "addressee", "mentioned"],
              },
              intent: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence_event_ids: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { type: "integer" },
              },
            },
            required: [
              "person_id",
              "role",
              "intent",
              "confidence",
              "evidence_event_ids",
            ],
            additionalProperties: false,
          },
        },
      },
      required: [
        "source_id",
        "subject",
        "synopsis",
        "confidence",
        "event_ids",
        "participants",
      ],
      additionalProperties: false,
    },
    summary: { type: "string" },
    knowledge: {
      type: "array",
      maxItems: 99,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: MODEL_KNOWLEDGE_KINDS },
          subject: { type: "string" },
          statement: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          status: { type: "string", enum: [...TEAM_KNOWLEDGE_STATUSES] },
          visibility: { type: "string", enum: [...TEAM_KNOWLEDGE_VISIBILITIES] },
          visibility_ref: { type: "string" },
          evidence_event_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "integer" },
          },
          supersedes_knowledge_ids: {
            type: "array",
            uniqueItems: true,
            items: { type: "integer" },
          },
          valid_from: nullableNumberSchema,
          valid_to: nullableNumberSchema,
        },
        required: [
          "kind",
          "subject",
          "statement",
          "confidence",
          "status",
          "visibility",
          "visibility_ref",
          "evidence_event_ids",
          "supersedes_knowledge_ids",
          "valid_from",
          "valid_to",
        ],
        additionalProperties: false,
      },
    },
    orientation_ready: { type: "boolean" },
    orientation_message: { type: "string" },
    clarification_questions: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
    intervention: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["silent", "reply"] },
        reply_to_event_id: {
          anyOf: [{ type: "integer" }, { type: "null" }],
        },
        message: { type: "string" },
        reason: { type: "string" },
      },
      required: ["action", "reply_to_event_id", "message", "reason"],
      additionalProperties: false,
    },
  },
  required: [
    "episode",
    "summary",
    "knowledge",
    "orientation_ready",
    "orientation_message",
    "clarification_questions",
    "intervention",
  ],
  additionalProperties: false,
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maximum) return null;
  return text;
}

function integerList(value: unknown, allowEmpty: boolean): number[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return null;
  if (!value.every((item) => Number.isSafeInteger(item) && Number(item) > 0)) return null;
  const result = value.map(Number);
  return new Set(result).size === result.length ? result : null;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseTeamUnderstandingResponse(
  response: string,
  events: TeamEvent[],
  contextPersonIds: Iterable<string> = [],
): TeamUnderstandingResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }
  const root = objectRecord(parsed);
  const episodeRoot = objectRecord(root?.episode);
  const interventionRoot = objectRecord(root?.intervention);
  const episodeSourceId = boundedString(episodeRoot?.source_id, 250, false);
  const episodeSubject = boundedString(episodeRoot?.subject, 500, false);
  const episodeSynopsis = boundedString(episodeRoot?.synopsis, 4_000, false);
  const episodeEventIds = integerList(episodeRoot?.event_ids, false);
  const summary = boundedString(root?.summary, 12_000);
  const orientationMessage = boundedString(root?.orientation_message, 3_900);
  const interventionMessage = boundedString(interventionRoot?.message, 3_900);
  const interventionReason = boundedString(interventionRoot?.reason, 500, false);
  if (
    !root ||
    !episodeRoot ||
    !interventionRoot ||
    episodeSourceId === null ||
    episodeSubject === null ||
    episodeSynopsis === null ||
    episodeEventIds === null ||
    typeof episodeRoot.confidence !== "number" ||
    !Number.isFinite(episodeRoot.confidence) ||
    episodeRoot.confidence < 0 ||
    episodeRoot.confidence > 1 ||
    !Array.isArray(episodeRoot.participants) ||
    episodeRoot.participants.length === 0 ||
    episodeRoot.participants.length > 100 ||
    summary === null ||
    orientationMessage === null ||
    interventionMessage === null ||
    interventionReason === null ||
    !["silent", "reply"].includes(String(interventionRoot.action ?? "")) ||
    typeof root.orientation_ready !== "boolean" ||
    !Array.isArray(root.knowledge) ||
    root.knowledge.length > 99 ||
    !Array.isArray(root.clarification_questions) ||
    root.clarification_questions.length > 5
  ) {
    return null;
  }
  const questions: string[] = [];
  for (const value of root.clarification_questions) {
    const question = boundedString(value, 500, false);
    if (question === null) return null;
    questions.push(question);
  }
  const eventIds = new Set(events.map((event) => event.id));
  const sourceIds = new Set(events.map((event) => event.sourceId));
  const personIds = new Set([
    ...events.map((event) => event.personId),
    ...contextPersonIds,
  ]);
  if (
    events.length === 0 ||
    sourceIds.size !== 1 ||
    !sourceIds.has(episodeSourceId) ||
    episodeEventIds.length !== events.length ||
    episodeEventIds.some((eventId) => !eventIds.has(eventId))
  ) {
    return null;
  }
  const participants: TeamUnderstandingResult["episode"]["participants"] = [];
  for (const value of episodeRoot.participants) {
    const participant = objectRecord(value);
    const personId = boundedString(participant?.person_id, 250, false);
    const intent = boundedString(participant?.intent, 1_000);
    const participantEvidenceIds = integerList(participant?.evidence_event_ids, false);
    if (
      !participant ||
      personId === null ||
      !personIds.has(personId) ||
      intent === null ||
      !["speaker", "addressee", "mentioned"].includes(String(participant.role ?? "")) ||
      typeof participant.confidence !== "number" ||
      !Number.isFinite(participant.confidence) ||
      participant.confidence < 0 ||
      participant.confidence > 1 ||
      participantEvidenceIds === null ||
      participantEvidenceIds.some((eventId) => !eventIds.has(eventId))
    ) {
      return null;
    }
    participants.push({
      personId,
      role: participant.role as TeamUnderstandingResult["episode"]["participants"][number]["role"],
      intent,
      confidence: participant.confidence,
      evidenceEventIds: participantEvidenceIds,
    });
  }
  const occurredAt = events.map((event) => event.occurredAt);
  const knowledge: TeamUnderstandingResult["knowledge"] = [{
    kind: "episode",
    subject: episodeSubject,
    statement: episodeSynopsis,
    confidence: episodeRoot.confidence,
    status: "resolved",
    visibility: "source",
    visibilityRef: episodeSourceId,
    evidenceEventIds: episodeEventIds,
    supersedesKnowledgeIds: [],
    validFrom: Math.min(...occurredAt),
    validTo: Math.max(...occurredAt),
  }];
  for (const value of root.knowledge) {
    const item = objectRecord(value);
    const subject = boundedString(item?.subject, 500);
    const statement = boundedString(item?.statement, 4_000, false);
    const visibilityRef = boundedString(item?.visibility_ref, 250);
    const evidenceEventIds = integerList(item?.evidence_event_ids, false);
    const supersedesKnowledgeIds = integerList(item?.supersedes_knowledge_ids, true);
    const validFrom = nullableFiniteNumber(item?.valid_from);
    const validTo = nullableFiniteNumber(item?.valid_to);
    if (
      !item ||
      typeof item.kind !== "string" ||
      !TEAM_KNOWLEDGE_KINDS.has(item.kind) ||
      item.kind === "episode" ||
      typeof item.status !== "string" ||
      !TEAM_KNOWLEDGE_STATUSES.has(item.status) ||
      typeof item.visibility !== "string" ||
      !TEAM_KNOWLEDGE_VISIBILITIES.has(item.visibility) ||
      subject === null ||
      statement === null ||
      visibilityRef === null ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      evidenceEventIds === null ||
      evidenceEventIds.some((eventId) => !eventIds.has(eventId)) ||
      supersedesKnowledgeIds === null ||
      validFrom === undefined ||
      validTo === undefined ||
      (validFrom !== null && validTo !== null && validFrom > validTo) ||
      (item.visibility === "space" && visibilityRef !== "") ||
      (item.visibility === "source" && !sourceIds.has(visibilityRef)) ||
      (item.visibility === "person" && !personIds.has(visibilityRef))
    ) {
      return null;
    }
    knowledge.push({
      kind: item.kind as TeamUnderstandingResult["knowledge"][number]["kind"],
      subject,
      statement,
      confidence: item.confidence,
      status: item.status as TeamUnderstandingResult["knowledge"][number]["status"],
      visibility: item.visibility as TeamUnderstandingResult["knowledge"][number]["visibility"],
      visibilityRef,
      evidenceEventIds,
      supersedesKnowledgeIds,
      validFrom,
      validTo,
    });
  }
  const replyToEventId = interventionRoot.reply_to_event_id;
  if (
    replyToEventId !== null &&
    (!Number.isSafeInteger(replyToEventId) ||
      !events.some((event) =>
        event.id === replyToEventId &&
        ["message", "command", "service"].includes(event.eventKind) &&
        /^\d+$/.test(event.externalEventId)
      ))
  ) {
    return null;
  }
  const interventionAction = interventionRoot.action as "silent" | "reply";
  if (
    (interventionAction === "silent" &&
      (replyToEventId !== null || interventionMessage !== "")) ||
    (interventionAction === "reply" &&
      (replyToEventId === null || interventionMessage === "")) ||
    (root.orientation_ready === true && orientationMessage === "") ||
    (root.orientation_ready === false && orientationMessage !== "")
  ) {
    return null;
  }
  return {
    episode: {
      sourceId: episodeSourceId,
      subject: episodeSubject,
      synopsis: episodeSynopsis,
      confidence: episodeRoot.confidence,
      eventIds: episodeEventIds,
      participants,
    },
    summary,
    knowledge,
    orientationReady: root.orientation_ready,
    orientationMessage,
    clarificationQuestions: questions,
    intervention: {
      action: interventionAction,
      replyToEventId: replyToEventId as number | null,
      message: interventionMessage,
      reason: interventionReason,
    },
  };
}

function record(value: unknown): TelegramObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TelegramObject)
    : null;
}

function personName(sender: TelegramObject): string {
  const name = [sender.first_name, sender.last_name]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .join(" ")
    .trim();
  const username = typeof sender.username === "string" ? sender.username.trim() : "";
  return name || (username ? `@${username.replace(/^@/, "")}` : "");
}

function attachment(
  kind: string,
  value: TelegramObject | null,
  fallbackName: string,
): TeamEventAttachment | null {
  if (!value) return null;
  return {
    kind,
    fileName: String(value.file_name ?? fallbackName),
    mimeType: String(value.mime_type ?? ""),
    size: Number(value.file_size ?? 0) || 0,
    ...(typeof value.file_id === "string" ? { providerFileId: value.file_id } : {}),
  };
}

export function telegramEventAttachments(message: TelegramObject): TeamEventAttachment[] {
  const result: TeamEventAttachment[] = [];
  const candidates: Array<TeamEventAttachment | null> = [
    attachment("document", record(message.document), "document"),
    attachment("audio", record(message.audio), "audio"),
    attachment("voice", record(message.voice), "voice"),
    attachment("video", record(message.video), "video"),
    attachment("video_note", record(message.video_note), "video-note"),
    attachment("animation", record(message.animation), "animation"),
    attachment("sticker", record(message.sticker), "sticker"),
  ];
  for (const candidate of candidates) if (candidate) result.push(candidate);
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const largestPhoto = [...photos]
    .filter((item): item is TelegramObject => record(item) !== null)
    .map((item) => item as TelegramObject)
    .sort((left, right) => Number(right.file_size ?? 0) - Number(left.file_size ?? 0))[0];
  const photo = attachment("photo", largestPhoto ?? null, "photo");
  if (photo) result.push(photo);
  return result;
}

function serviceSummary(message: TelegramObject): string {
  const created = record(message.forum_topic_created);
  if (created) return `[Создан топик: ${String(created.name ?? "без названия")}]`;
  const edited = record(message.forum_topic_edited);
  if (edited) return `[Топик переименован: ${String(edited.name ?? "без названия")}]`;
  if (message.forum_topic_closed) return "[Топик закрыт]";
  if (message.forum_topic_reopened) return "[Топик открыт снова]";
  const left = record(message.left_chat_member);
  if (left) return `[Участник вышел: ${personName(left) || String(left.id ?? "unknown")}]`;
  const joined = Array.isArray(message.new_chat_members) ? message.new_chat_members : [];
  if (joined.length > 0) {
    const names = joined
      .map(record)
      .filter((item): item is TelegramObject => item !== null)
      .map((item) => personName(item) || String(item.id ?? "unknown"));
    return `[Новые участники: ${names.join(", ")}]`;
  }
  if (message.pinned_message) return "[Закреплено сообщение]";
  return "[Служебное событие Telegram]";
}

export function telegramExplicitReply(message: TelegramObject): TelegramObject | null {
  const reply = record(message.reply_to_message);
  if (!reply) return null;
  const replyMessageId = Number(reply.message_id ?? 0);
  const topicRootMessageId = Number(message.message_thread_id ?? 0);
  // Telegram represents an ordinary forum-topic message as a reply to the
  // topic's root service message. That transport link is not a human reply.
  if (topicRootMessageId > 0 && replyMessageId === topicRootMessageId) return null;
  return reply;
}

export function telegramTeamEventInput(
  message: TelegramObject,
  administratorUserId: number,
  eventKind?: string,
  externalEventId?: string,
): TeamEventInput | null {
  const chat = record(message.chat);
  if (!chat) return null;
  const chatType = String(chat.type ?? "");
  if (!["group", "supergroup", "channel"].includes(chatType)) return null;
  const chatId = Number(chat.id ?? 0);
  if (!chatId) return null;
  const sender = record(message.from) ?? record(message.sender_chat) ?? {};
  const senderId = Number(sender.id ?? 0);
  const messageId = Number(message.message_id ?? 0);
  if (!senderId || !messageId) return null;
  const topicId = Number(message.message_thread_id ?? 0);
  const reply = telegramExplicitReply(message);
  const text = String(message.text ?? message.caption ?? "").trim();
  const attachments = telegramEventAttachments(message);
  const kind = eventKind ?? (text.startsWith("/") ? "command" : text || attachments.length > 0 ? "message" : "service");
  const occurredAt = Number(message.edit_date ?? message.date ?? 0) || Date.now() / 1_000;
  return {
    provider: "telegram",
    externalSpaceId: String(chatId),
    externalThreadId: String(topicId),
    spaceName: String(chat.title ?? chat.username ?? chatId),
    sourceTitle: String(
      record(message.forum_topic_created)?.name ??
        record(message.forum_topic_edited)?.name ??
        (topicId ? `topic ${topicId}` : "general"),
    ),
    externalEventId: externalEventId ?? String(messageId),
    eventKind: kind,
    senderExternalId: String(senderId),
    senderDisplayName: personName(sender) || String(sender.title ?? senderId),
    text: text || serviceSummary(message),
    replyToExternalEventId: reply ? String(reply.message_id ?? "") : "",
    attachments,
    occurredAt,
    administratorUserId,
  };
}

export function teamKnowledgeText(
  space: TeamSpace,
  items: TeamKnowledgeItem[],
  eventCount: number,
  pendingCount: number,
): string {
  const lines = [
    `Team Space: ${space.name}`,
    `Фаза: ${space.phase}`,
    `Событий: ${eventCount}; ожидают осмысления: ${pendingCount}`,
    `Знаний: ${items.length}`,
  ];
  if (space.summary && space.summaryStatus === "active") {
    lines.push("", "Текущее понимание:", space.summary);
  } else if (space.summaryStatus === "needs-review") {
    lines.push("", "Текущее понимание требует пересборки после удаления evidence.");
  }
  if (items.length > 0) {
    lines.push("", "Последние знания:");
    for (const item of items.slice(0, 20)) {
      lines.push(
        `- [${item.kind}; ${item.status}; visibility=${item.visibility}; ` +
          `${Math.round(item.confidence * 100)}%; ` +
          `evidence:${item.evidenceEventIds.join(",")}] ` +
          `${item.subject ? `${item.subject}: ` : ""}${item.statement}`,
      );
    }
  }
  return lines.join("\n");
}
