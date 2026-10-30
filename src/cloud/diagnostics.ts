const phases = new Set(['input-review', 'budget', 'provider', 'output-validation', 'deduplicate', 'output-review', 'commit']);
const kinds = new Set(['database-conflict', 'database-unavailable', 'controlled', 'TypeError', 'ReferenceError', 'unknown']);
export function safeDiagnostic(error: unknown): Record<string, string> {
  const e = error as Record<string, unknown> | null;
  if (e?.kind === 'chat-failure-persist') return {
    kind: 'chat-failure-persist',
    phase: typeof e.phase === 'string' && phases.has(e.phase) ? e.phase : 'unknown',
    primaryKind: typeof e.primaryKind === 'string' && kinds.has(e.primaryKind) ? e.primaryKind : 'unknown',
    persistenceKind: typeof e.persistenceKind === 'string' && kinds.has(e.persistenceKind) ? e.persistenceKind : 'unknown',
  };
  return { kind: 'unhandled-service-error' };
}
