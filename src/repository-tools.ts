import type {
  DynamicToolCall,
  DynamicToolCallResult,
  DynamicToolNamespaceSpec,
  JsonRecord,
} from "./codex-app-server.js";

const OBJECT_SCHEMA = { type: "object", additionalProperties: false };

export type RepositoryToolOperation = "inspect" | "verify_access" | "pull" | "push";

export interface RepositoryToolContext {
  projectId: string;
  workspaceId: string;
  repositoryPath: string;
  conversationId: string;
  actorUserId: number;
  turnId: string;
}

export interface RepositoryToolHost {
  repositoryTool(
    context: RepositoryToolContext,
    operation: RepositoryToolOperation,
    expectedHead?: string,
  ): Promise<unknown>;
}

export const REPOSITORY_DYNAMIC_TOOLS: DynamicToolNamespaceSpec[] = [{
  type: "namespace",
  name: "repository",
  description:
    "Host-side, project-scoped Git origin control using the managed deploy key. Use these tools " +
    "instead of running network Git commands in the sandbox. The host fixes the project, " +
    "workspace, repository, and actor from the active Telegram conversation and never exposes " +
    "private key material to the agent.",
  tools: [
    {
      type: "function",
      name: "inspect",
      description:
        "Fetch origin with the managed deploy key and return the current branch, HEAD, fresh " +
        "ahead/behind counts, divergence state, and safe Pull/Push availability. Always call this " +
        "before answering about origin state or performing Pull/Push; local remote-tracking refs " +
        "may be stale.",
      inputSchema: { ...OBJECT_SCHEMA, properties: {} },
    },
    {
      type: "function",
      name: "verify_access",
      description:
        "Verify live read and write access with the managed deploy key. The write check is a " +
        "non-mutating dry-run push and creates no remote ref. Use when the user asks whether the " +
        "deploy key or repository access works.",
      inputSchema: { ...OBJECT_SCHEMA, properties: {} },
    },
    {
      type: "function",
      name: "pull",
      description:
        "Fast-forward the current branch from its safe origin source only when the user explicitly " +
        "asks to update it. Call inspect immediately first and pass its exact 40-character HEAD. " +
        "The host rejects dirty, stale, or diverged repositories and never merges or rebases.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          expectedHead: {
            type: "string",
            pattern: "^[0-9a-f]{40}$",
            description: "Exact repository.head returned by the immediately preceding inspect.",
          },
        },
        required: ["expectedHead"],
      },
    },
    {
      type: "function",
      name: "push",
      description:
        "Push the current branch without force only when the user explicitly asks to publish it. " +
        "Call inspect immediately first and pass its exact 40-character HEAD. The host rejects a " +
        "stale HEAD, remote commits missing locally, and unsafe Git configuration.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          expectedHead: {
            type: "string",
            pattern: "^[0-9a-f]{40}$",
            description: "Exact repository.head returned by the immediately preceding inspect.",
          },
        },
        required: ["expectedHead"],
      },
    },
  ],
}];

function argumentsRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repository tool arguments must be an object");
  }
  return value as JsonRecord;
}

function expectedHead(args: JsonRecord): string {
  const value = args.expectedHead;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("expectedHead must be an exact 40-character Git commit id from inspect");
  }
  return value;
}

function result(value: unknown): DynamicToolCallResult {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    success: true,
  };
}

export async function executeRepositoryTool(
  host: RepositoryToolHost,
  context: RepositoryToolContext,
  call: DynamicToolCall,
): Promise<DynamicToolCallResult> {
  if (call.namespace !== "repository") {
    throw new Error("unknown dynamic tool namespace");
  }
  const args = argumentsRecord(call.arguments);
  switch (call.tool) {
    case "inspect":
      return result(await host.repositoryTool(context, "inspect"));
    case "verify_access":
      return result(await host.repositoryTool(context, "verify_access"));
    case "pull":
      return result(await host.repositoryTool(context, "pull", expectedHead(args)));
    case "push":
      return result(await host.repositoryTool(context, "push", expectedHead(args)));
    default:
      throw new Error(`unknown repository tool: ${call.tool}`);
  }
}
