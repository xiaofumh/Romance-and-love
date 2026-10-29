import { call, getMode, toast } from '../../services/api';
import { POLICY_VERSION } from '../../../shared/contracts';
import type { Bootstrap } from '../../../shared/contracts';
Page({ data: { mode: getMode(), version: POLICY_VERSION, bootstrap: null as Bootstrap | null },
  async onLoad() { try { this.setData({ bootstrap: await call<Bootstrap>('session.bootstrap') }); } catch (e) { toast(e); } },
});
