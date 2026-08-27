export const PROJECT_PORTAL_MESSAGE_KINDS = [
  "text",
  "document",
  "photo",
  "audio",
  "video",
  "animation",
  "voice",
] as const;

export type ProjectPortalMessageKind = typeof PROJECT_PORTAL_MESSAGE_KINDS[number];
export type ProjectPortalAttachmentKind = Exclude<ProjectPortalMessageKind, "text">;

const MESSAGE_KINDS = new Set<string>(PROJECT_PORTAL_MESSAGE_KINDS);
const ATTACHMENT_KINDS = new Set<string>(PROJECT_PORTAL_MESSAGE_KINDS.slice(1));

const NATIVE_MIME_TYPES: Record<Exclude<ProjectPortalAttachmentKind, "document">, ReadonlySet<string>> = {
  photo: new Set(["image/jpeg", "image/png"]),
  audio: new Set(["audio/mpeg", "audio/mp4"]),
  video: new Set(["video/mp4"]),
  animation: new Set(["image/gif", "video/mp4"]),
  voice: new Set(["audio/ogg", "audio/mpeg", "audio/mp4"]),
};

export function isProjectPortalMessageKind(value: string): value is ProjectPortalMessageKind {
  return MESSAGE_KINDS.has(value);
}

export function isProjectPortalAttachmentKind(value: string): value is ProjectPortalAttachmentKind {
  return ATTACHMENT_KINDS.has(value);
}

export function projectPortalMimeTypeAllowed(
  kind: ProjectPortalAttachmentKind,
  mimeType: string,
): boolean {
  if (kind === "document") return mimeType.trim().length > 0;
  return NATIVE_MIME_TYPES[kind].has(mimeType);
}

export function projectPortalMaximumArtifactBytes(kind: ProjectPortalAttachmentKind): number {
  if (kind === "document") return 8_000_000;
  if (kind === "photo") return 10_000_000;
  return 20_000_000;
}
