import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

test("Telegram offset advances only after an update is fully processed", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-telegram-polling-"));
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    1,
    1,
    "",
    "medium",
    false,
    new Map(),
  ));
  const pollingRuntime = runtime as unknown as {
    handleMessage(message: TelegramObject): Promise<void>;
    processAndAcknowledgeTelegramUpdate(
      update: TelegramObject,
      currentOffset: number | null,
    ): Promise<number>;
  };
  const update: TelegramObject = {
    update_id: 10,
    message: {
      message_id: 20,
      text: "retry me",
      from: { id: 1 },
      chat: { id: 1, type: "private" },
    },
  };
  runtime.state.setTelegramOffset(10);

  try {
    pollingRuntime.handleMessage = async () => {
      throw new Error("transient handler failure");
    };
    await assert.rejects(
      pollingRuntime.processAndAcknowledgeTelegramUpdate(update, 10),
      /transient handler failure/,
    );
    assert.equal(runtime.state.telegramOffset(), 10);

    let processed = 0;
    pollingRuntime.handleMessage = async () => {
      processed += 1;
    };
    assert.equal(
      await pollingRuntime.processAndAcknowledgeTelegramUpdate(update, 10),
      11,
    );
    assert.equal(processed, 1);
    assert.equal(runtime.state.telegramOffset(), 11);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
