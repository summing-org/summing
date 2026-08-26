import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitInspector } from "./git-inspector.js";

export interface RunArtifact {
  runId: number;
  conversationId: string;
  beforeRevision: string;
  afterRevision: string;
  startedAt: string;
  completedAt: string;
  changed: boolean;
}

export interface StagedRunDocument {
  ordinal: number;
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

interface PendingArtifact extends Omit<RunArtifact, "afterRevision" | "completedAt" | "changed"> {
  afterRevision?: string;
  completedAt?: string;
  changed?: boolean;
}

export class RunArtifactStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "run-artifacts");
  }

  private directory(conversationId: string, runId: number): string {
    if (!/^tg-[0-9a-f]{20}$/.test(conversationId) || !Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error("invalid run artifact identifier");
    }
    return resolve(this.root, conversationId, String(runId));
  }

  async begin(runId: number, conversationId: string, inspector: GitInspector): Promise<void> {
    const directory = this.directory(conversationId, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact: PendingArtifact = {
      runId,
      conversationId,
      beforeRevision: await inspector.snapshot(`run ${runId} before`),
      startedAt: new Date().toISOString(),
    };
    await writeFile(resolve(directory, "metadata.json"), `${JSON.stringify(artifact, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async complete(
    runId: number,
    conversationId: string,
    inspector: GitInspector,
  ): Promise<RunArtifact> {
    const directory = this.directory(conversationId, runId);
    const metadataPath = resolve(directory, "metadata.json");
    const pending = JSON.parse(await readFile(metadataPath, "utf8")) as PendingArtifact;
    const afterRevision = await inspector.snapshot(`run ${runId} after`);
    const patch = await inspector.commitDiff(pending.beforeRevision, afterRevision);
    const artifact: RunArtifact = {
      runId,
      conversationId,
      beforeRevision: pending.beforeRevision,
      afterRevision,
      startedAt: pending.startedAt,
      completedAt: new Date().toISOString(),
      changed: Boolean(patch.trim()),
    };
    await writeFile(resolve(directory, "changes.patch"), patch, { mode: 0o600 });
    await writeFile(metadataPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    return artifact;
  }

  async stageDocuments(
    runId: number,
    conversationId: string,
    documents: Array<{
      fileName: string;
      mimeType: string;
      data: Uint8Array;
    }>,
  ): Promise<StagedRunDocument[]> {
    const directory = resolve(this.directory(conversationId, runId), "deliveries");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staged: StagedRunDocument[] = [];
    for (const [ordinal, document] of documents.entries()) {
      const data = Uint8Array.from(document.data);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const path = resolve(directory, `${ordinal}-${sha256}.bin`);
      const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      staged.push({
        ordinal,
        path,
        fileName: document.fileName,
        mimeType: document.mimeType,
        size: data.byteLength,
        sha256,
      });
    }
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return staged;
  }

  async list(conversationId: string, limit = 20): Promise<RunArtifact[]> {
    const directory = resolve(this.root, conversationId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const artifacts: RunArtifact[] = [];
    for (const entry of entries.sort((left, right) => Number(right) - Number(left))) {
      if (artifacts.length >= limit || !/^\d+$/.test(entry)) continue;
      try {
        const value = JSON.parse(
          await readFile(resolve(directory, entry, "metadata.json"), "utf8"),
        ) as PendingArtifact;
        if (value.afterRevision && value.completedAt && typeof value.changed === "boolean") {
          artifacts.push(value as RunArtifact);
        }
      } catch {
        // An interrupted run may have only its before snapshot.
      }
    }
    return artifacts;
  }

  async patch(conversationId: string, runId: number): Promise<string> {
    return readFile(resolve(this.directory(conversationId, runId), "changes.patch"), "utf8");
  }
}
