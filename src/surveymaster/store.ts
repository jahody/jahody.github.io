// Browser persistence. Projects live in IndexedDB (they outgrow localStorage); the OpenRouter key
// lives in sessionStorage, or localStorage when the visitor ticks "remember". Every access is
// wrapped so the app still works, without saving, in private windows or with storage blocked.

import type { Project } from './types';

const DB = 'surveymaster';
const STORE = 'projects';
const KEY_NAME = 'surveymaster.openrouter-key';
const CURRENT = 'surveymaster.current-project';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(null);
        try {
          const req = run(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export interface ProjectSummary {
  id: string;
  topic: string;
  source: Project['source'];
  createdAt: string;
  papers: number;
  taxonomies: number;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = (await tx<Project[]>('readonly', (s) => s.getAll())) ?? [];
  return all
    .map((p) => ({ id: p.id, topic: p.topic, source: p.source, createdAt: p.createdAt, papers: p.papers.length, taxonomies: p.taxonomies.length }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export const loadProject = (id: string) => tx<Project>('readonly', (s) => s.get(id));

/** Save a snapshot; structuredClone strips anything IndexedDB can't store. */
export const saveProject = (p: Project) => tx('readwrite', (s) => s.put(structuredClone(p)));

export const deleteProject = (id: string) => tx('readwrite', (s) => s.delete(id));

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export const getCurrentId = () => safe(() => localStorage.getItem(CURRENT), null);
export const setCurrentId = (id: string | null) =>
  safe(() => (id ? localStorage.setItem(CURRENT, id) : localStorage.removeItem(CURRENT)), undefined);

export const getKey = () => safe(() => sessionStorage.getItem(KEY_NAME) ?? localStorage.getItem(KEY_NAME) ?? '', '');
export const keyRemembered = () => safe(() => localStorage.getItem(KEY_NAME) !== null, false);

export function setKey(key: string, remember: boolean) {
  safe(() => {
    sessionStorage.removeItem(KEY_NAME);
    localStorage.removeItem(KEY_NAME);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY_NAME, key);
  }, undefined);
}

/** Download a project as JSON. */
export function exportProject(p: Project) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `surveymaster-${p.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function isProject(x: any): x is Project {
  return x && x.version === 1 && Array.isArray(x.papers) && Array.isArray(x.taxonomies) && typeof x.results === 'object';
}
