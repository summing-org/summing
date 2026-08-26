import type {
  DynamicToolCall,
  DynamicToolCallResult,
  DynamicToolNamespaceSpec,
  JsonRecord,
} from "./codex-app-server.js";
import type { ProjectMemoryKind } from "./state-store.js";

const OBJECT_SCHEMA = { type: "object", additionalProperties: false };
const KINDS: ProjectMemoryKind[] = ["fact", "decision", "preference", "constraint", "note"];

export interface ProjectMemoryToolContext {
  projectId: string;
  workspaceId: string;
  conversationId: string;
  actorUserId: number;
  turnId: string;
  runId: number;
}

export interface ProjectMemoryToolHost {
  projectMemoryTool(
    context: ProjectMemoryToolContext,
    operation: "list" | "remember" | "supersede" | "archive",
    input: { itemId?: number; kind?: ProjectMemoryKind; text?: string },
  ): Promise<unknown>;
}

export const PROJECT_MEMORY_DYNAMIC_TOOLS: DynamicToolNamespaceSpec[] = [{
  type: "namespace",
  name: "project_memory",
  description:
    "Structured durable memory for the active Project. The host fixes Project, actor, and source " +
    "run. Memory is projected read-only into the workspace; never edit the projection file.",
  tools: [
    {
      type: "function",
      name: "list",
      description: "List active structured memory items and their ids, kinds, and provenance.",
      inputSchema: { ...OBJECT_SCHEMA, properties: {} },
    },
    {
      type: "function",
      name: "remember",
      description:
        "Store one concise durable fact, decision, preference, constraint, or note established by " +
        "the current owner-authorized run. Do not store credentials or conversation-only details.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          kind: { type: "string", enum: KINDS },
          text: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["kind", "text"],
      },
    },
    {
      type: "function",
      name: "supersede",
      description:
        "Replace one exact active memory item while retaining its provenance and previous value. " +
        "Use only when the current run establishes that the old item is no longer accurate.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          itemId: { type: "integer", minimum: 1 },
          kind: { type: "string", enum: KINDS },
          text: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["itemId", "kind", "text"],
      },
    },
    {
      type: "function",
      name: "archive",
      description:
        "Archive one exact active item without deleting its provenance. Use only when the owner " +
        "explicitly asks to forget it or the current run proves it invalid with no replacement.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: { itemId: { type: "integer", minimum: 1 } },
        required: ["itemId"],
      },
    },
  ],
}];

function argumentsRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project_memory tool arguments must be an object");
  }
  return value as JsonRecord;
}

function itemId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("itemId must be a positive safe integer");
  }
  return parsed;
}

function memoryInput(args: JsonRecord): { kind: ProjectMemoryKind; text: string } {
  if (typeof args.kind !== "string" || !KINDS.includes(args.kind as ProjectMemoryKind)) {
    throw new Error("kind is invalid");
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text || Array.from(text).length > 2_000) {
    throw new Error("text must contain from 1 to 2000 characters");
  }
  return { kind: args.kind as ProjectMemoryKind, text };
}

function result(value: unknown): DynamicToolCallResult {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    success: true,
  };
}

export async function executeProjectMemoryTool(
  host: ProjectMemoryToolHost,
  context: ProjectMemoryToolContext,
  call: DynamicToolCall,
): Promise<DynamicToolCallResult> {
  if (call.namespace !== "project_memory") throw new Error("unknown dynamic tool namespace");
  const args = argumentsRecord(call.arguments);
  if (call.tool === "list") return result(await host.projectMemoryTool(context, "list", {}));
  if (call.tool === "remember") {
    return result(await host.projectMemoryTool(context, "remember", memoryInput(args)));
  }
  if (call.tool === "supersede") {
    return result(await host.projectMemoryTool(context, "supersede", {
      itemId: itemId(args.itemId),
      ...memoryInput(args),
    }));
  }
  if (call.tool === "archive") {
    return result(await host.projectMemoryTool(context, "archive", {
      itemId: itemId(args.itemId),
    }));
  }
  throw new Error(`unknown project_memory tool: ${call.tool}`);
}
