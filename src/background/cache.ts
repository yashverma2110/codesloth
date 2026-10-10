/** Tiny IndexedDB wrapper. Stores: "analysis" (key owner/repo/number/headSha), "blobs" (key blob sha), "etags" (key url). */
const DB_NAME = "pr-layers";
const DB_VERSION = 1;
const STORES = ["analysis", "blobs", "etags"] as const;
type Store = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

export async function cacheGet<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, "readonly").objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

export async function cachePut<T>(store: Store, key: string, value: T): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheClear(): Promise<void> {
  const db = await open();
  await Promise.all(
    STORES.map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(s, "readwrite");
          tx.objectStore(s).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    ),
  );
}

export const analysisKey = (owner: string, repo: string, number: number, headSha: string) => `${owner}/${repo}/${number}/${headSha}`;
