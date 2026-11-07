// A tiny IndexedDB key/value store for things that should survive a page reload: disk images the guest
// has written to, and a saved machine state. Every call fails soft (returns null/false) when IndexedDB is
// unavailable, such as in some private-browsing modes.

const DB = 'lisaem', STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : true); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch { return null; }
}

export const idbGet = (key) => run('readonly', (s) => s.get(key));
export const idbPut = async (key, value) => (await run('readwrite', (s) => s.put(value, key))) !== null;
export const idbDel = async (key) => (await run('readwrite', (s) => s.delete(key))) !== null;
