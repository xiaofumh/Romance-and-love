import type { CompanionRole, Conversation } from '../shared/companion';
// Select within this user's role only. Never merge unrelated message windows or
// erase legacy conversations. Once selected, settings/time changes cannot move it.
export function primaryConversation(role: CompanionRole, conversations: Conversation[]): Conversation | undefined {
  // false marks a retained legacy/comparison room. Deleting the primary must
  // never silently revive one of those histories as the next active context.
  const owned = conversations.filter(c => c.roleId === role.id && c.primary !== false);
  const pinned = owned.find(c => c.primary);
  const selected = pinned ?? owned.sort((a, b) => Number(b.messages.length > 0) - Number(a.messages.length > 0)
    || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
  if (selected) for (const room of owned) room.primary = room.id === selected.id;
  return selected;
}
