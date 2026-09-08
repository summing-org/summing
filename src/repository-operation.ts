// Shared by the viewer and scheduler; linked worktrees use the same canonical Git directory.
export const repositoryOperations = new Set<string>();

export async function withRepositoryOperation<T>(
  key: string,
  operation: () => Promise<T>,
  busyError: () => Error = () => new Error("another repository operation is still running"),
): Promise<T> {
  if (repositoryOperations.has(key)) throw busyError();
  repositoryOperations.add(key);
  try { return await operation(); }
  finally { repositoryOperations.delete(key); }
}
