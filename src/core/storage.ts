import { newState, type State } from './types';
export interface Persistence { load(): Promise<State>; save(state: State): Promise<void> }
export class LocalDatabase implements Persistence {
  private db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('shicai-local-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async load(): Promise<State> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const r = db.transaction('state').objectStore('state').get('current');
      r.onsuccess = () => resolve(r.result ?? newState()); r.onerror = () => reject(r.error);
    });
  }
  async save(state: State): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(state, 'current');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
}
