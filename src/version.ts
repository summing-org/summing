export const SUMMING_VERSION = "9.19.0";
export const SUMMING_VERSION_LABEL = `ς ${SUMMING_VERSION}`;

const TELEGRAM_SHORT_DESCRIPTION_LIMIT = 120;

export function summingProfileDescription(status: string): string {
  const prefix = `${SUMMING_VERSION_LABEL} · `;
  return `${prefix}${status.slice(0, TELEGRAM_SHORT_DESCRIPTION_LIMIT - prefix.length)}`;
}
