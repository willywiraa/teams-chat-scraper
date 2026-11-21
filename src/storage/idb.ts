/** Minimal promise wrappers around the IndexedDB API. */

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion, request.transaction as IDBTransaction);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version of the extension upgrade the schema without being blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error(`Could not open database ${name}`));
    request.onblocked = () => reject(new Error(`Opening database ${name} is blocked by another open connection`));
  });
}

/** Key range covering every `[prefix, *]` compound key. */
export function prefixRange(prefix: IDBValidKey): IDBKeyRange {
  return IDBKeyRange.bound([prefix, -Infinity], [prefix, []]);
}

/** The values at the end of an index range, last first, at most `limit` of them. */
export function readLast<T>(index: IDBIndex, range: IDBKeyRange, limit: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const found: T[] = [];
    const request = index.openCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || found.length >= limit) {
        resolve(found);
        return;
      }
      found.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}
