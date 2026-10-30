import { cloudRepository } from './repository';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
export async function main(event: unknown) {
  const context = cloud.getWXContext();
  // Trusted SDK context, never an OPENID supplied in the event body.
  if (context.OPENID || (event as { Type?: string })?.Type !== 'Timer') return { ok: false, code: 'INTERNAL_ONLY' };
  const stamp = Date.now();
  const rows = await db.collection('assistant_users').where({ updatedAt: db.command.lt(stamp - 15 * 60000) })
    .orderBy('updatedAt', 'asc').limit(50).get();
  let processed = 0;
  const repo = cloudRepository(db, { touchUnchanged: true });
  for (const record of rows.data) {
    await repo.transact(record._id, stamp, () => ({ cleaned: true })); processed++;
  }
  return { ok: true, processed, at: stamp };
}
