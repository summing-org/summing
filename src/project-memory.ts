import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./config.js";

export function projectMemoryPath(dataDir: string, projectId: string): string {
  return resolve(dataDir, "projects", projectId, "memory.md");
}

export function ensureProjectMemory(dataDir: string, project: ProjectConfig): string {
  const memoryPath = projectMemoryPath(dataDir, project.id);
  mkdirSync(resolve(memoryPath, ".."), { recursive: true, mode: 0o700 });
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, `# Project memory: ${project.name}\n\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return memoryPath;
}
