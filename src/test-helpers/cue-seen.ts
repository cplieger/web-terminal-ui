import { cueSeenID, cueSeenKey } from "../features/tabs/model.js";

type ReadableStore = Pick<Storage, "length" | "key" | "getItem"> | ReadonlyMap<string, string>;

function isMap(store: ReadableStore): store is ReadonlyMap<string, string> {
  return store instanceof Map;
}

/** The acknowledgements a store holds, session id -> stored status. */
export function storedCueSeen(store: ReadableStore = localStorage): Record<string, string> {
  const keys = isMap(store)
    ? [...store.keys()]
    : Array.from({ length: store.length }, (_, i) => store.key(i) ?? "");
  const out: Record<string, string> = {};
  for (const key of keys) {
    const id = cueSeenID(key);
    if (id !== null) {
      out[id] = (isMap(store) ? store.get(key) : store.getItem(key)) ?? "";
    }
  }
  return out;
}

/** Store acknowledgements as another page of the app would. */
export function storeCueSeen(
  seen: Record<string, string>,
  store: Pick<Storage, "setItem"> | Map<string, string> = localStorage,
): void {
  for (const [id, status] of Object.entries(seen)) {
    if (store instanceof Map) {
      store.set(cueSeenKey(id), status);
    } else {
      store.setItem(cueSeenKey(id), status);
    }
  }
}
