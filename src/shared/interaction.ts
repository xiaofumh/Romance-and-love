import type { ChatMessage, CompanionRole, Conversation, InteractionMode } from './companion';
import { conversationClauses, interactionCommand } from './conversation-text';
export const INITIATIVE_LIMITS = { idleMs: 45000, cooldownMs: 300000 } as const;
export const INTERACTION_LABELS = { listening: '倾听陪伴', light: '轻松聊聊', quiet: '暂停主动' } as const;
export function nextInteractionMode(text: string, previous: InteractionMode = 'listening'): InteractionMode {
  // Explicit first-person/current-chat choices only. Quoted/third-party statements
  // must not control this conversation. Unrecognised text preserves the choice.
  let mode = previous;
  for (const clause of conversationClauses(text)) {
    if (!clause.direct) continue;
    mode = interactionCommand(clause.plain) ?? mode;
  }
  return mode;
}
export function interactionMode(text: string): InteractionMode { return nextInteractionMode(text); }
export function currentHistory(c: Conversation, memoryEnabled: boolean): ChatMessage[] {
  const disabledAfter = memoryEnabled ? -1 : c.messages.map(m => Boolean(m.memoryUsed)).lastIndexOf(true);
  const resetAfter = c.contextAfterId ? c.messages.findIndex(m => m.id === c.contextAfterId) : -1;
  return c.messages.slice(Math.max(disabledAfter, resetAfter) + 1);
}
export function selectContext(c: Conversation, memoryEnabled: boolean): ChatMessage[] {
  if (c.contextRounds !== 6) {
    // Count user turns, not bubbles or proactive assistant messages. A turn
    // retains its ordinary reply plus at most one initiative (36 messages max).
    const groups: ChatMessage[][] = [];
    for (const m of currentHistory(c, memoryEnabled)) {
      if (m.speaker === 'user') groups.push([m]);
      else if (groups.length) groups[groups.length - 1]!.push(m);
    }
    return groups.slice(-12).flatMap(g => g.length <= 3 ? g : [g[0]!, g[1]!, g[g.length - 1]!]);
  }
  const selected = currentHistory(c, memoryEnabled).slice(-12);
  // Do not begin a bounded window with an orphaned assistant reply.
  const firstUser = selected.findIndex(m => m.speaker === 'user');
  return firstUser < 0 ? [] : selected.slice(firstUser);
}
export function initiativeStatus(c: Conversation, role: CompanionRole, now: number, memoryEnabled = true) {
  if (!role.proactiveEnabled) return { enabled: false, available: false, reason: 'disabled', availableAt: 0 };
  const history = currentHistory(c, memoryEnabled), user = [...history].reverse().find(m => m.speaker === 'user');
  if (!user || (c.interaction?.mode ?? interactionMode(user.text)) === 'quiet')
    return { enabled: true, available: false, reason: 'quiet', availableAt: 0 };
  if (c.interaction?.initiativeAttemptFor === user.requestId)
    return { enabled: true, available: false, reason: 'already-attempted', availableAt: 0 };
  const availableAt = Math.max((history.at(-1)?.createdAt ?? user.createdAt) + INITIATIVE_LIMITS.idleMs,
    (c.interaction?.lastInitiativeAt ?? 0) + INITIATIVE_LIMITS.cooldownMs);
  return { enabled: true, available: now >= availableAt, reason: now >= availableAt ? 'ready' : 'waiting', availableAt };
}
// Paragraph boundaries are explicitly produced by the model. Do not synthesize
// a second answer, split punctuation blindly, or rewrite the stored text.
export function naturalBubbles(text: string, style: 'single' | 'natural' = 'single'): string[] {
  if (style === 'single' || /```/.test(text)) return [text];
  const parts = text.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [text];
  return parts.length <= 3 ? parts : [parts[0]!, parts[1]!, parts.slice(2).join('\n\n')];
}
