/*
  The editor's unsaved text, kept in the browser's IndexedDB until the server
  confirms it (behaviour.md rule 1). One entry per recap and base version:
  `{recapId}:{baseVersionId}`. A reload finds the entry and restores it; an
  entry made on an older base is offered, never applied silently (rule 4).
  Browser-only.
*/
const DB = 'mtxt-recap';
const STORE = 'drafts';

export interface LocalDraft {
  key: string;
  recapId: string;
  /** The version the text was written on; null before the first version. */
  baseVersionId: string | null;
  bodyMd: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

export const draftKey = (recapId: string, baseVersionId: string | null) =>
  `${recapId}:${baseVersionId ?? 'none'}`;

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('recapId', 'recapId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export const putDraft = (draft: Omit<LocalDraft, 'key'>) =>
  run('readwrite', (s) => s.put({ ...draft, key: draftKey(draft.recapId, draft.baseVersionId) }));

export const deleteDraft = (recapId: string, baseVersionId: string | null) =>
  run('readwrite', (s) => s.delete(draftKey(recapId, baseVersionId)));

/** Every unsaved text of a recap, newest first. */
export const draftsFor = (recapId: string) =>
  run<LocalDraft[]>('readonly', (s) => s.index('recapId').getAll(recapId)).then((list) =>
    list.sort((a, b) => b.savedAt - a.savedAt),
  );
