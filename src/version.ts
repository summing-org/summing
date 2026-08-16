export const SUMMING_VERSION = "9.8.3";
export const SUMMING_VERSION_LABEL = `SUMMING ${SUMMING_VERSION}`;

const TELEGRAM_SHORT_DESCRIPTION_LIMIT = 120;

export function summingProfileDescription(status: string): string {
  const suffix = ` · ${SUMMING_VERSION_LABEL}`;
  return `${status.slice(0, TELEGRAM_SHORT_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
}
