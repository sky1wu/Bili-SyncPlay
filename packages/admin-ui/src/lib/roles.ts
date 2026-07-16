import type { AdminIdentity } from "../api/types.js";

export function canManage(me: AdminIdentity | null): boolean {
  return me !== null && (me.role === "operator" || me.role === "admin");
}
