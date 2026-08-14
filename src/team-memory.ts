import type {
  TeamEventAttachment,
  TeamEventInput,
  TeamEvent,
  TeamKnowledgeItem,
  TeamSpace,
  TeamSynthesisResult,
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

export const TEAM_SYNTHESIS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    knowledge: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...TEAM_KNOWLEDGE_KINDS] },
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
    proactive_reply_event_id: {
      anyOf: [{ type: "integer" }, { type: "null" }],
    },
    proactive_message: { type: "string" },
  },
  required: [
    "summary",
    "knowledge",
    "orientation_ready",
    "orientation_message",
    "clarification_questions",
    "proactive_reply_event_id",
    "proactive_message",
  ],
  additionalProperties: false,
};

function synthesisRecord(value: unknown): Record<string, unknown> | null {
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

export function parseTeamSynthesisResponse(
  response: string,
  events: TeamEvent[],
): TeamSynthesisResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }
  const root = synthesisRecord(parsed);
  const summary = boundedString(root?.summary, 12_000);
  const orientationMessage = boundedString(root?.orientation_message, 3_900);
  const proactiveMessage = boundedString(root?.proactive_message, 3_900);
  if (
    !root ||
    summary === null ||
    orientationMessage === null ||
    proactiveMessage === null ||
    typeof root.orientation_ready !== "boolean" ||
    !Array.isArray(root.knowledge) ||
    root.knowledge.length > 100 ||
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
  const personIds = new Set(events.map((event) => event.personId));
  const knowledge: TeamSynthesisResult["knowledge"] = [];
  for (const value of root.knowledge) {
    const item = synthesisRecord(value);
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
      kind: item.kind as TeamSynthesisResult["knowledge"][number]["kind"],
      subject,
      statement,
      confidence: item.confidence,
      status: item.status as TeamSynthesisResult["knowledge"][number]["status"],
      visibility: item.visibility as TeamSynthesisResult["knowledge"][number]["visibility"],
      visibilityRef,
      evidenceEventIds,
      supersedesKnowledgeIds,
      validFrom,
      validTo,
    });
  }
  const proactiveReplyEventId = root.proactive_reply_event_id;
  if (
    proactiveReplyEventId !== null &&
    (!Number.isSafeInteger(proactiveReplyEventId) ||
      !events.some((event) =>
        event.id === proactiveReplyEventId &&
        ["message", "command", "service"].includes(event.eventKind) &&
        /^\d+$/.test(event.externalEventId)
      ))
  ) {
    return null;
  }
  if (
    (proactiveReplyEventId === null && proactiveMessage !== "") ||
    (proactiveReplyEventId !== null && proactiveMessage === "") ||
    (root.orientation_ready === true && orientationMessage === "") ||
    (root.orientation_ready === false && orientationMessage !== "")
  ) {
    return null;
  }
  return {
    summary,
    knowledge,
    orientationReady: root.orientation_ready,
    orientationMessage,
    clarificationQuestions: questions,
    proactiveReplyEventId: proactiveReplyEventId as number | null,
    proactiveMessage,
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
