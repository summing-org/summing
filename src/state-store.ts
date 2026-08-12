import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface Conversation {
  id: string;
  chatId: number;
  topicId: number;
  projectId: string;
  workspaceId: string;
  codexThreadId: string | null;
  readOnlyCodexThreadId: string | null;
  activeTurnId: string | null;
  streamMessageId: number | null;
  worktreePath: string | null;
}

export type RunAccess = "write" | "read-only";
export type ResponseMode = "direct" | "ambient";

export interface PendingInput {
  id: number;
  conversationId: string;
  telegramMessageId: number;
  text: string;
  mode: "steer" | "followup";
  access: RunAccess;
  senderId: number;
  responseMode: ResponseMode;
  createdAt: number;
}

export interface ManagedProject {
  id: string;
  name: string;
  ownerId: number;
  defaultWorkspaceId: string;
  workspaces: Array<{ id: string; path: string }>;
  createdAt: number;
}

type Row = Record<string, string | number | bigint | null>;

export class StateStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.createSchema();
    this.recoverAfterRestart();
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          codex_thread_id TEXT,
          readonly_codex_thread_id TEXT,
          active_turn_id TEXT,
          stream_message_id INTEGER,
          worktree_path TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(chat_id, topic_id)
        );
        CREATE TABLE IF NOT EXISTS pending_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          telegram_message_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('steer', 'followup')),
          access_mode TEXT NOT NULL DEFAULT 'write' CHECK(access_mode IN ('write', 'read-only')),
          telegram_user_id INTEGER NOT NULL DEFAULT 0,
          response_mode TEXT NOT NULL DEFAULT 'direct'
            CHECK(response_mode IN ('direct', 'ambient')),
          run_id INTEGER,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'consumed')),
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_inputs_lookup
          ON pending_inputs(conversation_id, mode, state, id);
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          turn_id TEXT,
          status TEXT NOT NULL,
          access_mode TEXT NOT NULL DEFAULT 'write' CHECK(access_mode IN ('write', 'read-only')),
          response_mode TEXT NOT NULL DEFAULT 'direct'
            CHECK(response_mode IN ('direct', 'ambient')),
          prompt TEXT NOT NULL,
          response TEXT NOT NULL DEFAULT '',
          error TEXT,
          started_at REAL NOT NULL,
          completed_at REAL
        );
        CREATE TABLE IF NOT EXISTS runtime_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_id INTEGER NOT NULL,
          default_workspace_id TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_workspaces (
          project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at REAL NOT NULL,
          PRIMARY KEY(project_id, id)
        );
        CREATE INDEX IF NOT EXISTS managed_projects_owner
          ON managed_projects(owner_id, id);
      `);
      const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as Row[];
      if (!conversationColumns.some((column) => column.name === "readonly_codex_thread_id")) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN readonly_codex_thread_id TEXT");
      }
      const pendingColumns = this.db.prepare("PRAGMA table_info(pending_inputs)").all() as Row[];
      if (!pendingColumns.some((column) => column.name === "access_mode")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'write' " +
            "CHECK(access_mode IN ('write', 'read-only'))",
        );
      }
      if (!pendingColumns.some((column) => column.name === "telegram_user_id")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN telegram_user_id INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!pendingColumns.some((column) => column.name === "response_mode")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'direct' " +
            "CHECK(response_mode IN ('direct', 'ambient'))",
        );
      }
      if (!pendingColumns.some((column) => column.name === "run_id")) {
        this.db.exec("ALTER TABLE pending_inputs ADD COLUMN run_id INTEGER");
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_access_lookup
        ON pending_inputs(conversation_id, access_mode, state, id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_response_lookup
        ON pending_inputs(conversation_id, response_mode, state, id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_run_lookup
        ON pending_inputs(run_id, id)
      `);
      const runColumns = this.db.prepare("PRAGMA table_info(runs)").all() as Row[];
      if (!runColumns.some((column) => column.name === "access_mode")) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'write' " +
            "CHECK(access_mode IN ('write', 'read-only'))",
        );
      }
      if (!runColumns.some((column) => column.name === "response_mode")) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'direct' " +
            "CHECK(response_mode IN ('direct', 'ambient'))",
        );
      }
    });
  }

  createManagedProject(project: ManagedProject): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO managed_projects
          (id, name, owner_id, default_workspace_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.name,
        project.ownerId,
        project.defaultWorkspaceId,
        project.createdAt,
      );
      const insertWorkspace = this.db.prepare(`
        INSERT INTO managed_workspaces (project_id, id, path, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const workspace of project.workspaces) {
        insertWorkspace.run(project.id, workspace.id, workspace.path, project.createdAt);
      }
    });
  }

  listManagedProjects(): ManagedProject[] {
    const projects = this.db.prepare(`
      SELECT id, name, owner_id, default_workspace_id, created_at
      FROM managed_projects
      ORDER BY id
    `).all() as Row[];
    const workspaceQuery = this.db.prepare(`
      SELECT id, path FROM managed_workspaces WHERE project_id = ? ORDER BY id
    `);
    return projects.map((project) => ({
      id: String(project.id),
      name: String(project.name),
      ownerId: Number(project.owner_id),
      defaultWorkspaceId: String(project.default_workspace_id),
      workspaces: (workspaceQuery.all(project.id as SQLInputValue) as Row[]).map((workspace) => ({
        id: String(workspace.id),
        path: String(workspace.path),
      })),
      createdAt: Number(project.created_at),
    }));
  }

  private recoverAfterRestart(): void {
    const now = Date.now() / 1000;
    this.transaction(() => {
      const abandoned = this.db
        .prepare(
          "SELECT id, conversation_id, prompt, access_mode, response_mode, started_at " +
            "FROM runs WHERE status = 'running'",
        )
        .all() as Row[];
      const enqueue = this.db.prepare(`
        INSERT INTO pending_inputs
          (conversation_id, telegram_message_id, text, mode, access_mode, telegram_user_id,
           response_mode, created_at)
        VALUES (?, 0, ?, 'followup', ?, 0, ?, ?)
      `);
      const restoreInputs = this.db.prepare(`
        UPDATE pending_inputs
        SET state = 'pending', mode = 'followup', run_id = NULL
        WHERE run_id = ?
      `);
      for (const row of abandoned) {
        const restored = restoreInputs.run(row.id as SQLInputValue);
        if (Number(restored.changes) === 0) {
          enqueue.run(
            row.conversation_id as SQLInputValue,
            row.prompt as SQLInputValue,
            row.access_mode as SQLInputValue,
            row.response_mode as SQLInputValue,
            Number(row.started_at) - 0.000_001,
          );
        }
      }
      this.db.prepare(`
        UPDATE runs SET status = 'interrupted', error = 'runtime restarted', completed_at = ?
        WHERE status = 'running'
      `).run(now);
      this.db.prepare(`
        UPDATE conversations SET active_turn_id = NULL, stream_message_id = NULL, updated_at = ?
        WHERE active_turn_id IS NOT NULL
      `).run(now);
      this.db.exec(
        "UPDATE pending_inputs SET mode = 'followup' WHERE mode = 'steer' AND state = 'pending'",
      );
    });
  }

  static conversationId(chatId: number, topicId: number): string {
    const digest = createHash("sha256").update(`${chatId}:${topicId}`).digest("hex").slice(0, 20);
    return `tg-${digest}`;
  }

  bind(chatId: number, topicId: number, projectId: string, workspaceId: string): Conversation {
    const now = Date.now() / 1000;
    const conversationId = StateStore.conversationId(chatId, topicId);
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT project_id, workspace_id FROM conversations WHERE id = ?")
        .get(conversationId) as Row | undefined;
      const changed = Boolean(
        old && (old.project_id !== projectId || old.workspace_id !== workspaceId),
      );
      this.db.prepare(`
        INSERT INTO conversations
          (id, chat_id, topic_id, project_id, workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          workspace_id = excluded.workspace_id,
          codex_thread_id = CASE WHEN ? THEN NULL ELSE codex_thread_id END,
          readonly_codex_thread_id = CASE WHEN ? THEN NULL ELSE readonly_codex_thread_id END,
          active_turn_id = NULL,
          stream_message_id = NULL,
          worktree_path = CASE WHEN ? THEN NULL ELSE worktree_path END,
          updated_at = excluded.updated_at
      `).run(
        conversationId,
        chatId,
        topicId,
        projectId,
        workspaceId,
        now,
        now,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
      );
      if (changed) {
        this.db.prepare(
          "UPDATE pending_inputs SET state = 'consumed' WHERE conversation_id = ? AND state = 'pending'",
        ).run(conversationId);
      }
    });
    return this.get(conversationId);
  }

  get(conversationId: string): Conversation {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
    if (!row) throw new Error(`unknown conversation: ${conversationId}`);
    return this.toConversation(row as Row);
  }

  byTopic(chatId: number, topicId: number): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE chat_id = ? AND topic_id = ?")
      .get(chatId, topicId);
    return row ? this.toConversation(row as Row) : null;
  }

  listConversations(): Conversation[] {
    return (this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as Row[])
      .map((row) => this.toConversation(row));
  }

  private toConversation(row: Row): Conversation {
    return {
      id: String(row.id),
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      codexThreadId: row.codex_thread_id === null ? null : String(row.codex_thread_id),
      readOnlyCodexThreadId:
        row.readonly_codex_thread_id === null ? null : String(row.readonly_codex_thread_id),
      activeTurnId: row.active_turn_id === null ? null : String(row.active_turn_id),
      streamMessageId: row.stream_message_id === null ? null : Number(row.stream_message_id),
      worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    };
  }

  setThread(conversationId: string, threadId: string | null, access: RunAccess = "write"): void {
    this.updateConversation(
      conversationId,
      access === "read-only" ? "readonly_codex_thread_id" : "codex_thread_id",
      threadId,
    );
  }

  setWorktree(conversationId: string, path: string): void {
    this.updateConversation(conversationId, "worktree_path", path);
  }

  setActive(conversationId: string, turnId: string | null, streamMessageId: number | null): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE conversations SET active_turn_id = ?, stream_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(turnId, streamMessageId, Date.now() / 1000, conversationId);
    });
  }

  clearActive(conversationId: string): void {
    this.setActive(conversationId, null, null);
  }

  private updateConversation(
    conversationId: string,
    field: "codex_thread_id" | "readonly_codex_thread_id" | "worktree_path",
    value: SQLInputValue,
  ): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE conversations SET ${field} = ?, updated_at = ? WHERE id = ?`,
      ).run(value, Date.now() / 1000, conversationId);
    });
  }

  enqueueInput(
    conversationId: string,
    telegramMessageId: number,
    text: string,
    mode: "steer" | "followup",
    access: RunAccess = "write",
    senderId = 0,
    responseMode: ResponseMode = "direct",
  ): number {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO pending_inputs
          (conversation_id, telegram_message_id, text, mode, access_mode, telegram_user_id,
           response_mode, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        telegramMessageId,
        text,
        mode,
        access,
        senderId,
        responseMode,
        Date.now() / 1000,
      );
      return Number(result.lastInsertRowid);
    });
  }

  pending(
    conversationId: string,
    mode: "steer" | "followup",
    access: RunAccess = "write",
  ): PendingInput[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, telegram_message_id, text, mode, access_mode,
             telegram_user_id, response_mode, created_at
      FROM pending_inputs
      WHERE conversation_id = ? AND mode = ? AND access_mode = ? AND state = 'pending'
      ORDER BY created_at, id
    `).all(conversationId, mode, access) as Row[];
    return rows.map((row) => this.toPending(row));
  }

  pendingAll(conversationId: string): PendingInput[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, telegram_message_id, text, mode, access_mode,
             telegram_user_id, response_mode, created_at
      FROM pending_inputs
      WHERE conversation_id = ? AND state = 'pending'
      ORDER BY created_at, id
    `).all(conversationId) as Row[];
    return rows.map((row) => this.toPending(row));
  }

  private toPending(row: Row): PendingInput {
    return {
      id: Number(row.id),
      conversationId: String(row.conversation_id),
      telegramMessageId: Number(row.telegram_message_id),
      text: String(row.text),
      mode: String(row.mode) as PendingInput["mode"],
      access: String(row.access_mode) as RunAccess,
      senderId: Number(row.telegram_user_id),
      responseMode: String(row.response_mode) as ResponseMode,
      createdAt: Number(row.created_at),
    };
  }

  consume(inputIds: number[]): void {
    if (inputIds.length === 0) return;
    const placeholders = inputIds.map(() => "?").join(",");
    this.transaction(() => {
      this.db.prepare(
        `UPDATE pending_inputs SET state = 'consumed' WHERE id IN (${placeholders})`,
      ).run(...inputIds);
    });
  }

  startRun(
    conversationId: string,
    prompt: string,
    inputIds: number[] = [],
    access: RunAccess = "write",
    responseMode: ResponseMode = "direct",
  ): number {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO runs
          (conversation_id, status, access_mode, response_mode, prompt, started_at)
        VALUES (?, 'running', ?, ?, ?, ?)
      `).run(conversationId, access, responseMode, prompt, Date.now() / 1000);
      if (inputIds.length > 0) {
        const placeholders = inputIds.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE pending_inputs SET state = 'consumed', run_id = ? ` +
            `WHERE id IN (${placeholders})`,
        ).run(Number(result.lastInsertRowid), ...inputIds);
      }
      return Number(result.lastInsertRowid);
    });
  }

  attachTurn(runId: number, turnId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET turn_id = ? WHERE id = ?").run(turnId, runId);
    });
  }

  finishRun(runId: number, status: string, response: string, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE runs SET status = ?, response = ?, error = ?, completed_at = ? WHERE id = ?
      `).run(status, response, error, Date.now() / 1000, runId);
    });
  }

  telegramOffset(): number | null {
    const row = this.db.prepare(
      "SELECT value FROM runtime_state WHERE key = 'telegram_offset'",
    ).get() as Row | undefined;
    return row ? Number(row.value) : null;
  }

  setTelegramOffset(offset: number): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runtime_state (key, value) VALUES ('telegram_offset', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(offset));
    });
  }

  counts(): { conversations: number; active: number; pending: number } {
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { "COUNT(*)": number };
      return Number(row["COUNT(*)"]);
    };
    return {
      conversations: scalar("SELECT COUNT(*) FROM conversations"),
      active: scalar("SELECT COUNT(*) FROM conversations WHERE active_turn_id IS NOT NULL"),
      pending: scalar("SELECT COUNT(*) FROM pending_inputs WHERE state = 'pending'"),
    };
  }
}
