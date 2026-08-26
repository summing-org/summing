import type {
  DynamicToolCall,
  DynamicToolCallResult,
  DynamicToolNamespaceSpec,
  JsonRecord,
} from "./codex-app-server.js";

const OBJECT_SCHEMA = { type: "object", additionalProperties: false };

export interface ProjectHistoryToolContext {
  projectId: string;
  workspaceId: string;
  conversationId: string;
  actorUserId: number;
  turnId: string;
  runId: number;
}

export interface ProjectHistoryToolHost {
  projectHistoryTool(
    context: ProjectHistoryToolContext,
    operation: "recent" | "search" | "read",
    input: { query?: string; runId?: number; beforeRunId?: number; limit?: number },
  ): Promise<unknown>;
}

export const PROJECT_HISTORY_DYNAMIC_TOOLS: DynamicToolNamespaceSpec[] = [{
  type: "namespace",
  name: "project_history",
  description:
    "Read-only, durable history of prior Codex runs in the active Project and Workspace. The host " +
    "fixes project, workspace, actor, and current run from the authorized Telegram turn. Requests " +
    "and responses stay local: tools expose only metadata, digests, and assurance aggregates.",
  tools: [
    {
      type: "function",
      name: "recent",
      description:
        "List a bounded page of prior runs, newest first. Use beforeRunId from the oldest returned " +
        "run to continue. The currently executing run is excluded.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          beforeRunId: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
    },
    {
      type: "function",
      name: "search",
      description:
        "Full-text search prior original user requests and final responses in this Project and " +
        "Workspace. Effective prompts and cross-project data are never indexed.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "read",
      description:
        "Read metadata for one exact prior run after finding its id with recent or search. Returns " +
        "retry lineage, delivery/evidence aggregates, and detached-review metadata if present; " +
        "historical message text remains local.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: { runId: { type: "integer", minimum: 1 } },
        required: ["runId"],
      },
    },
  ],
}];

function argumentsRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project_history tool arguments must be an object");
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function limit(value: unknown): number | undefined {
  const parsed = positiveInteger(value, "limit");
  if (parsed !== undefined && parsed > 20) throw new Error("limit must be from 1 to 20");
  return parsed;
}

function result(value: unknown): DynamicToolCallResult {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    success: true,
  };
}

export async function executeProjectHistoryTool(
  host: ProjectHistoryToolHost,
  context: ProjectHistoryToolContext,
  call: DynamicToolCall,
): Promise<DynamicToolCallResult> {
  if (call.namespace !== "project_history") {
    throw new Error("unknown dynamic tool namespace");
  }
  const args = argumentsRecord(call.arguments);
  if (call.tool === "recent") {
    return result(await host.projectHistoryTool(context, "recent", {
      ...(positiveInteger(args.beforeRunId, "beforeRunId") === undefined
        ? {}
        : { beforeRunId: Number(args.beforeRunId) }),
      ...(limit(args.limit) === undefined ? {} : { limit: Number(args.limit) }),
    }));
  }
  if (call.tool === "search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || Array.from(query).length > 500) {
      throw new Error("query must contain from 1 to 500 characters");
    }
    return result(await host.projectHistoryTool(context, "search", {
      query,
      ...(limit(args.limit) === undefined ? {} : { limit: Number(args.limit) }),
    }));
  }
  if (call.tool === "read") {
    const runId = positiveInteger(args.runId, "runId");
    if (runId === undefined) throw new Error("runId is required");
    return result(await host.projectHistoryTool(context, "read", { runId }));
  }
  throw new Error(`unknown project_history tool: ${call.tool}`);
}
