// Project byte budgets, not a claim of unlimited storage or platform quotas.
export const IMPORT_LIMITS = { fileBytes: 1024 * 1024 } as const;
export const STORAGE_LIMITS = { companionBytes: 4 * 1024 * 1024, userBytes: 5 * 1024 * 1024 } as const;
export function utf8Bytes(text: string): number {
  let n = 0; for (const ch of text) { const c = ch.codePointAt(0)!; n += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4; } return n;
}
