export type TelegramObject = Record<string, unknown>;

export class TelegramError extends Error {}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(value: unknown): TelegramObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TelegramObject)
    : null;
}

export class TelegramAPI {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly controller = new AbortController();
  private closed = false;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
  }

  async call(method: string, payload: TelegramObject): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      let data: TelegramObject | null;
      try {
        if (this.closed) throw new TelegramError("Telegram client is closed");
        response = await fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(70_000)]),
        });
        data = record(await response.json());
      } catch {
        if (this.closed) throw new TelegramError("Telegram client is closed");
        if (attempt === 3) {
          throw new TelegramError(`Telegram ${method} transport failed`);
        }
        await sleep(1_500 * (attempt + 1));
        continue;
      }
      if (response.status === 429 || data?.error_code === 429) {
        const parameters = record(data?.parameters);
        const retryAfter = Number(parameters?.retry_after ?? 2);
        await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter : 2, 30) * 1_000);
        continue;
      }
      if (!response.ok || !data || data.ok !== true) {
        const description = typeof data?.description === "string" ? data.description : response.statusText;
        throw new TelegramError(`Telegram ${method}: ${description}`);
      }
      return data.result;
    }
    throw new TelegramError(`Telegram ${method} exhausted retries`);
  }

  async getUpdates(offset: number | null): Promise<TelegramObject[]> {
    const payload: TelegramObject = {
      timeout: 50,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "message_reaction",
        "message_reaction_count",
        "my_chat_member",
        "chat_member",
      ],
    };
    if (offset !== null) payload.offset = offset;
    const result = await this.call("getUpdates", payload);
    return Array.isArray(result) ? result.filter((item): item is TelegramObject => record(item) !== null) : [];
  }

  async getMe(): Promise<TelegramObject> {
    return record(await this.call("getMe", {})) ?? {};
  }

  async setMyShortDescription(shortDescription: string): Promise<void> {
    await this.call("setMyShortDescription", {
      short_description: shortDescription.slice(0, 120),
    });
  }

  async setChatMenuButton(chatId: number, url: string, text = "Управление"): Promise<void> {
    await this.call("setChatMenuButton", {
      chat_id: chatId,
      menu_button: {
        type: "web_app",
        text: text.slice(0, 64),
        web_app: { url },
      },
    });
  }

  async downloadFile(
    fileId: string,
    maximumBytes: number,
  ): Promise<{ data: Uint8Array; filePath: string; fileSize: number }> {
    const file = record(await this.call("getFile", { file_id: fileId }));
    const filePath = typeof file?.file_path === "string" ? file.file_path : "";
    if (!filePath) throw new TelegramError("Telegram getFile did not return file_path");
    const announcedSize = Number(file?.file_size ?? 0);
    if (Number.isFinite(announcedSize) && announcedSize > maximumBytes) {
      throw new TelegramError(`Telegram file exceeds the ${maximumBytes}-byte download limit`);
    }
    const safePath = filePath.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await fetch(`${this.fileBaseUrl}/${safePath}`, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120_000)]),
      });
    } catch {
      if (this.closed) throw new TelegramError("Telegram client is closed");
      throw new TelegramError("Telegram file download transport failed");
    }
    if (!response.ok) {
      throw new TelegramError(`Telegram file download: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new TelegramError(`Telegram file exceeds the ${maximumBytes}-byte download limit`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maximumBytes) {
      throw new TelegramError(`Telegram file exceeds the ${maximumBytes}-byte download limit`);
    }
    return { data, filePath, fileSize: data.byteLength };
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: {
      topicId?: number;
      replyTo?: number;
      parseMode?: "MarkdownV2";
      replyMarkup?: TelegramObject;
    } = {},
  ): Promise<number> {
    const payload: TelegramObject = {
      chat_id: chatId,
      text: text.slice(0, 4_096) || "…",
      disable_web_page_preview: true,
    };
    if (options.parseMode) payload.parse_mode = options.parseMode;
    if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
    if (options.topicId) payload.message_thread_id = options.topicId;
    if (options.replyTo) {
      payload.reply_parameters = {
        message_id: options.replyTo,
        allow_sending_without_reply: true,
      };
    }
    const result = record(await this.call("sendMessage", payload));
    const messageId = Number(result?.message_id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new TelegramError("sendMessage did not return message_id");
    }
    return messageId;
  }

  async sendChatAction(chatId: number, action: "typing", topicId = 0): Promise<void> {
    const payload: TelegramObject = { chat_id: chatId, action };
    if (topicId) payload.message_thread_id = topicId;
    await this.call("sendChatAction", payload);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new TelegramError("deleteMessage requires a positive message id");
    }
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4_096) || "…",
        disable_web_page_preview: true,
      });
    } catch (error) {
      if (!(error instanceof TelegramError) || !error.message.toLowerCase().includes("message is not modified")) {
        throw error;
      }
    }
  }
}

export function splitMessage(text: string, limit = 3_900): string[] {
  let remaining = text.trim();
  if (!remaining) return ["Готово."];
  const chunks: string[] = [];
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit / 2) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}
