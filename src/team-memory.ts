import type {
  TeamEventAttachment,
  TeamEventInput,
  TeamKnowledgeItem,
  TeamSpace,
} from "./state-store.js";
import type { TelegramObject } from "./telegram-api.js";

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
  const reply = record(message.reply_to_message);
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
  if (space.summary) lines.push("", "Текущее понимание:", space.summary);
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
