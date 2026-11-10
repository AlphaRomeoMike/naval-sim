// Unit packs on the client: the store dialog, the checkout hand-off, collecting and keeping entitlement
// tokens, downloading owned packs, and restoring on another device. Paid unit data only ever arrives from the
// entitlement worker and is kept in IndexedDB so owned packs also work offline.
import { API, PACKS, checkoutUrl, type Pack } from './config';
import type { TierData } from './sim/types';

/**
 * What the worker hands out. `key` is the licence key (null when a checkout used an email that already had a
 * licence: the key then only goes to that email). A device can hold more than one entitlement; nothing is
 * ever replaced, so restoring or buying cannot lose what is already unlocked here.
 */
interface Licence { key: string | null; token: string; packs: string[] }
export const store = { licences: [] as Licence[], packs: {} as Record<string, TierData>, device: '', status: '' };
let onChange: () => void = () => {};

// ---------- tiny IndexedDB key-value store ----------
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('flagplot', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise<T>((res, rej) => {
    const rq = fn(d.transaction('kv', mode).objectStore('kv'));
    rq.onsuccess = () => res(rq.result as T);
    rq.onerror = () => rej(rq.error);
  });
}
const get = <T>(k: string) => kv<T | undefined>('readonly', (s) => s.get(k)).catch(() => undefined);
const set = (k: string, v: unknown) => kv<void>('readwrite', (s) => s.put(v, k)).catch(() => {});
const del = (k: string) => kv<void>('readwrite', (s) => s.delete(k)).catch(() => {});

const hex = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Pack ids this device is entitled to, whether or not their data has been downloaded yet. */
export const entitled = (): string[] => [...new Set(store.licences.flatMap((l) => l.packs))].sort();
/** Owned packs in a fixed order, so unit indices are the same on every device that owns the same packs. */
export function ownedTiers(): TierData[] {
  return Object.keys(store.packs).sort().map((id) => store.packs[id]);
}

/** Download any entitled pack that is not on this device yet, and drop cached packs that are no longer owned. */
async function sync(): Promise<void> {
  const want = entitled();
  for (const id of Object.keys(store.packs)) if (!want.includes(id)) { delete store.packs[id]; await del('pack:' + id); } // refunded
  for (const l of store.licences) {
    for (const id of l.packs) {
      if (store.packs[id]) continue;
      try {
        const r = await fetch(`${API}/pack/${id}`, { headers: { authorization: 'Bearer ' + l.token } });
        if (!r.ok) continue;
        store.packs[id] = (await r.json()) as TierData;
        await set('pack:' + id, store.packs[id]);
      } catch { /* offline: it stays "owned, not downloaded" and is retried next time */ }
    }
  }
  onChange();
}

/** Take an entitlement from the worker. One with the same key replaces the old copy; anything else is added. */
async function accept(l: Licence): Promise<void> {
  const at = l.key ? store.licences.findIndex((x) => x.key === l.key) : -1;
  if (at >= 0) store.licences[at] = l;
  else if (l.packs.length) store.licences = [l, ...store.licences].slice(0, 8);
  await set('licences', store.licences);
  await sync();
}

/** Unlock on this device with a licence key (typed in, or from the emailed link). */
export async function restore(key: string): Promise<boolean> {
  const r = await fetch(`${API}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, dev: store.device }) });
  if (!r.ok) return false;
  await accept((await r.json()) as Licence);
  return true;
}

// ---------- checkout hand-off ----------
interface Pending { nonce: string; at: number }
const DAY = 24 * 3600 * 1000; // the worker honours a checkout's nonce for 24 hours; so does this device
const pending = (): Pending[] => { try { return (JSON.parse(localStorage.getItem('pendingCheckouts') || '[]') as Pending[]).filter((p) => Date.now() - p.at < DAY); } catch { return []; } };
const savePending = (list: Pending[]): void => { try { localStorage.setItem('pendingCheckouts', JSON.stringify(list)); } catch { /* storage unavailable */ } };
let poll = 0;
/** Ask the worker whether the payment for each pending checkout has arrived. Survives reloads; stops when none are left. */
function watchClaims(): void {
  clearTimeout(poll);
  const tick = async (): Promise<void> => {
    const list = pending();
    savePending(list);
    if (!list.length) return;
    const key = store.licences.find((l) => l.key)?.key; // proves this device already holds a licence, so a matching one is merged
    for (const p of list) {
      try {
        const r = await fetch(`${API}/claim?cid=${p.nonce}&dev=${store.device}${key ? '&key=' + encodeURIComponent(key) : ''}`);
        if (!r.ok) continue; // not paid yet
        const l = (await r.json()) as Licence;
        savePending(pending().filter((x) => x.nonce !== p.nonce));
        await accept(l);
        store.status = l.key ? 'Purchase complete. Your packs are unlocked. Keep your licence key to unlock them on other devices.'
          : 'Purchase complete. Your pack is unlocked here. The licence key for your other devices was sent to the email you used at checkout.';
        onChange();
      } catch { /* offline: try again on the next tick */ }
    }
    const newest = Math.max(...list.map((p) => p.at));
    poll = window.setTimeout(tick, Date.now() - newest < 15 * 60 * 1000 ? 2000 : 30000); // quick at first, then every half minute
  };
  void tick();
}

export function buy(pack: Pack): void {
  if (!pack.checkout) return;
  const nonce = hex(16); // one checkout, one nonce; only this device can collect what it pays for
  savePending([...pending(), { nonce, at: Date.now() }]);
  window.open(checkoutUrl(pack, nonce, store.device), '_blank', 'noopener');
  store.status = 'Checkout opened in a new tab. This page will unlock the pack as soon as the payment is confirmed.';
  onChange();
  watchClaims();
}

/**
 * Called once at start-up. Loads entitlements and cached packs from this device (works offline), then, when
 * online, refreshes them so new purchases and refunds are picked up. `changed` runs whenever the set of
 * owned packs changes.
 */
export async function initStore(changed: () => void): Promise<void> {
  onChange = changed;
  // A random install id, not a hardware fingerprint. Kept in both stores so losing IndexedDB (private mode)
  // does not leave the device without one.
  let local = '';
  try { local = localStorage.getItem('device') || ''; } catch { /* storage unavailable */ }
  store.device = (await get<string>('device')) || local || hex(16);
  await set('device', store.device);
  try { localStorage.setItem('device', store.device); } catch { /* storage unavailable */ }
  store.licences = (await get<Licence[]>('licences')) || [];
  for (const id of entitled()) { const p = await get<TierData>('pack:' + id); if (p) store.packs[id] = p; }
  onChange();
  const linked = /[#&]restore=([0-9A-Za-z-]+)/.exec(location.hash); // the emailed restore link
  if (linked) {
    history.replaceState(null, '', location.pathname + location.search);
    void restore(linked[1]).then((ok) => { store.status = ok ? 'Packs restored on this device.' : 'That restore link is not valid.'; })
      .catch(() => { store.status = `The store could not be reached. Your key is ${linked[1]}: enter it under "Already bought?" when you are back online.`; })
      .then(() => { onChange(); showStore(); });
  } else if (navigator.onLine) {
    // refresh keyed licences (new purchases, refunds); then fetch anything entitled but not yet downloaded
    void Promise.all(store.licences.filter((l) => l.key).map((l) => restore(l.key!).catch(() => false))).then(sync);
  }
  if (pending().length) watchClaims();
}

// ---------- dialog ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function showStore(back?: () => void): void {
  const d = document.getElementById('dlg') as HTMLDialogElement;
  const render = (): void => {
    const has = entitled();
    const state = (p: Pack) => (!p.grants.every((g) => has.includes(g)) ? '' : p.grants.every((g) => store.packs[g]) ? 'Owned' : 'Owned (downloads when online)');
    const keys = store.licences.filter((l) => l.key).map((l) => l.key!);
    d.innerHTML = `<h1>Unit packs</h1>
      <p>One-time purchases. Each pack adds late Cold War units you can pick in the fit-out screen before a battle. The enemy you face is set by the scenario and does not change with what you own.</p>
      <div class="list">${PACKS.map((p) => `<div class="w" style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid rgba(255,255,255,.08)">
        <span><b>${esc(p.name)}</b> · ${esc(p.price)}<small style="display:block;color:var(--dim)">${esc(p.blurb)}</small></span>
        ${state(p) ? `<span style="color:var(--ok);white-space:nowrap">${state(p)}</span>` : `<button data-buy="${esc(p.id)}"${p.checkout ? '' : ' disabled title="Not on sale yet"'}>Buy</button>`}</div>`).join('')}</div>
      ${store.status ? `<p role="status" style="color:var(--warn)">${esc(store.status)}</p>` : ''}
      ${keys.length ? `<p class="kv">Your licence key${keys.length > 1 ? 's' : ''}: ${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</p>` : ''}
      <h2>Already bought?</h2>
      <p><label>Licence key <input type="text" id="restoreKey" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"></label></p>
      <p><label>or the email you bought with <input type="text" id="restoreEmail" inputmode="email" autocomplete="email" placeholder="you@example.com"></label></p>
      <div class="foot"><button data-m="restore">Restore</button><button data-m="back" autofocus>Close</button></div>`;
  };
  onChangeDialog = () => { if (d.open && d.dataset.view === 'store') render(); };
  d.dataset.view = 'store';
  render();
  if (!d.open) d.showModal();
  (d.querySelector('[autofocus]') as HTMLElement | null)?.focus(); // content was replaced: restore keyboard focus
  d.onchange = null;
  d.onclick = async (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t) return;
    if (t.dataset.buy) buy(PACKS.find((p) => p.id === t.dataset.buy)!);
    else if (t.dataset.m === 'restore') {
      const key = (document.getElementById('restoreKey') as HTMLInputElement).value.trim(), email = (document.getElementById('restoreEmail') as HTMLInputElement).value.trim();
      try {
        if (key) store.status = (await restore(key)) ? 'Packs restored on this device.' : 'That licence key was not recognised.';
        else if (email) {
          await fetch(`${API}/restore-email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
          store.status = 'If that address has bought a pack, a restore link is on its way to it.';
        }
      } catch { store.status = 'The store could not be reached. Check your connection and try again.'; }
      render();
    } else if (t.dataset.m === 'back') { delete d.dataset.view; if (back) back(); else d.close(); }
  };
  void sync(); // retry any download that failed earlier
}
let onChangeDialog: () => void = () => {};
/** Re-render the store dialog if it is open (called when the owned packs or the status line change). */
export function refreshStoreDialog(): void { onChangeDialog(); }
