import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "../runtime-store.js";

export type RuntimeRegistry = RuntimeStore;

export function createRuntimeRegistry(
  now: () => number = Date.now,
): RuntimeRegistry {
  return createInMemoryRuntimeStore(now);
}
