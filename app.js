/* ============================================================
   FroShizzle — deep-freezer bin inventory
   Local-first (localStorage) with optional Firebase household sync.
   ============================================================ */
'use strict';

/* ---------- constants ---------- */
const CATEGORIES = ['Beef','Pork','Chicken','Seafood','Vegetables','Fruit','Prepared Meals','Baking','Desserts','Other'];
const UNITS = ['pkg','piece','lb','kg','bag','container','portion','dozen','other'];
const STATUSES = ['Available','Low','Used Up','Buy'];
const LS_KEY = 'froshizzle-state-v1';
const FIREBASE_VER = '10.12.2';

/* ---------- utilities ---------- */
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayStr = () => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
function monthsSince(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d)) return null;
  return (Date.now() - d.getTime()) / (30.44 * 864e5);
}
function fmtDate(ds){
  if(!ds) return '';
  const d = new Date(ds + 'T00:00:00');
  if(isNaN(d)) return ds;
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
}
let toastTimer = null;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- state ---------- */
let state = {
  settings: { useSoon: 6, old: 12, sync: null },   // sync: {config:{...}, code:'ABC123'}
  bins: [],      // {id,name,desc,createdAt,updatedAt,deleted}
  items: [],     // {id,binId,name,qty,unit,category,dateFrozen,bestBefore,status,notes,createdAt,updatedAt,deleted}
  grocery: [],   // {id,itemId,name,qtyNeeded,unit,category,fromBinId,notes,done,updatedAt,deleted}
  products: []   // catalog: {id,name,unit,category,updatedAt,deleted}
};

function loadState(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if(raw){ const s = JSON.parse(raw); if(s && s.bins) state = Object.assign(state, s); }
  } catch(e){ console.warn('loadState', e); }
  if(!Array.isArray(state.products)) state.products = [];
  // migration: build the product catalog from anything already entered
  state.items.filter(i => !i.deleted).forEach(i => upsertProduct(i, { quiet: true }));
  dedupeProducts();
  // migration: items already sitting at qty 0 now disappear from bins
  state.items.filter(i => !i.deleted && (+i.qty || 0) <= 0).forEach(i => { i.deleted = true; i.updatedAt = Date.now(); });
}
function saveLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch(e){ console.warn('saveLocal', e); }
}

const liveBins   = () => state.bins.filter(b => !b.deleted);
const liveItems  = () => state.items.filter(i => !i.deleted);
const liveGroc   = () => state.grocery.filter(g => !g.deleted);
const liveProds  = () => {
  // display-level dedupe by name as a final safety net
  const seen = new Set();
  return state.products.filter(p => {
    if(p.deleted) return false;
    const key = p.name.trim().toLowerCase().replace(/\s+/g, ' ');
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b)=>a.name.localeCompare(b.name));
};
const bin        = (id) => state.bins.find(b => b.id === id && !b.deleted);
const binItems   = (id) => liveItems().filter(i => i.binId === id).sort((a,b)=>a.name.localeCompare(b.name));

/* ---------- sync engine (optional Firebase) ---------- */
const sync = {
  db: null, unsub: null, applying: false, status: 'off', // off | connecting | on | error
  get enabled(){ return !!(state.settings.sync && state.settings.sync.config && state.settings.sync.code); },

  loadScript(src){
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  },

  async start(){
    if(!this.enabled) return;
    this.status = 'connecting'; renderSyncStatus();
    try {
      if(typeof firebase === 'undefined'){
        await this.loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VER}/firebase-app-compat.js`);
        await this.loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VER}/firebase-firestore-compat.js`);
      }
      if(!firebase.apps.length) firebase.initializeApp(state.settings.sync.config);
      const fs = firebase.firestore();
      try { await fs.enablePersistence({ synchronizeTabs: true }); } catch(e){ /* multiple tabs or unsupported — fine */ }
      this.db = fs;
      const col = this.colRef();
      // initial push of everything local (merge semantics — remote newer wins on snapshot)
      await this.pushAll();
      this.unsub = col.onSnapshot((snap) => {
        this.applying = true;
        let changed = false;
        snap.docChanges().forEach((ch) => {
          const d = ch.doc.data();
          if(!d || !d.kind) return;
          changed = this.applyRemote(ch.doc.id, d) || changed;
        });
        this.applying = false;
        if(changed){ dedupeProducts(); saveLocal(); render(); }
      }, (err) => { console.warn('sync error', err); this.status = 'error'; renderSyncStatus(); });
      this.status = 'on'; renderSyncStatus();
    } catch(e){
      console.warn('sync start failed', e);
      this.status = 'error'; renderSyncStatus();
      toast('Sync error: ' + e.message);
    }
  },

  colRef(){
    const code = (state.settings.sync.code || '').trim().toUpperCase();
    return this.db.collection('households').doc(code).collection('entities');
  },

  applyRemote(id, d){
    const listName = { bin:'bins', item:'items', grocery:'grocery', product:'products' }[d.kind];
    if(d.kind === 'meta'){
      const local = state.settings;
      if((d.updatedAt || 0) > (local.metaUpdatedAt || 0)){
        state.settings.useSoon = d.data.useSoon ?? local.useSoon;
        state.settings.old = d.data.old ?? local.old;
        state.settings.metaUpdatedAt = d.updatedAt;
        return true;
      }
      return false;
    }
    if(!listName) return false;
    const list = state[listName];
    const i = list.findIndex(x => x.id === id);
    const local = i >= 0 ? list[i] : null;
    if(local && (local.updatedAt || 0) >= (d.updatedAt || 0)) return false;
    const entity = Object.assign({}, d.data, { id, updatedAt: d.updatedAt, deleted: !!d.deleted });
    if(i >= 0) list[i] = entity; else list.push(entity);
    return true;
  },

  push(kind, entity){
    if(!this.db || this.status !== 'on' && this.status !== 'connecting') return;
    const doc = { kind, updatedAt: entity.updatedAt || Date.now(), deleted: !!entity.deleted, data: {} };
    Object.keys(entity).forEach(k => { if(k !== 'id' && k !== 'deleted' && entity[k] !== undefined) doc.data[k] = entity[k]; });
    this.colRef().doc(entity.id).set(doc).catch(e => console.warn('push failed', e));
  },

  pushMeta(){
    if(!this.db) return;
    const updatedAt = Date.now();
    state.settings.metaUpdatedAt = updatedAt;
    this.colRef().doc('meta-settings').set({
      kind:'meta', updatedAt, deleted:false,
      data:{ useSoon: state.settings.useSoon, old: state.settings.old }
    }).catch(e => console.warn('pushMeta failed', e));
  },

  async pushAll(){
    state.bins.forEach(b => this.push('bin', b));
    state.items.forEach(i => this.push('item', i));
    state.grocery.forEach(g => this.push('grocery', g));
    state.products.forEach(p => this.push('product', p));
    this.pushMeta();
  },

  stop(){
    if(this.unsub) this.unsub();
    this.unsub = null; this.db = null; this.status = 'off';
  }
};

/* touch + persist: every mutation goes through here */
function touch(kind, entity){
  entity.updatedAt = Date.now();
  saveLocal();
  if(sync.enabled && !sync.applying) sync.push(kind, entity);
}

/* ---------- product catalog ---------- */
// Deterministic id from the product name, so every device generates the SAME id
// for the same product and sync merges them instead of duplicating.
function productIdFor(name){
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 5381;
  for(let i = 0; i < key.length; i++){ h = ((h << 5) + h + key.charCodeAt(i)) >>> 0; }
  return 'prod_' + h.toString(36) + '_' + key.replace(/[^a-z0-9]+/g, '-').slice(0, 24);
}

function upsertProduct(src, opts){
  const name = (src.name || '').trim();
  if(!name) return null;
  const pid = productIdFor(name);
  const key = name.toLowerCase();
  let p = state.products.find(x => x.id === pid && !x.deleted) ||
          state.products.find(x => x.name.trim().toLowerCase() === key && !x.deleted);
  if(!p){
    p = { id: pid, name, unit: src.unit || 'pkg', category: src.category || 'Other', deleted: false, updatedAt: Date.now() };
    state.products.push(p);
    if(!(opts && opts.quiet)) touch('product', p);
  } else if(p.unit !== src.unit || p.category !== src.category){
    p.unit = src.unit || p.unit;
    p.category = src.category || p.category;
    if(!(opts && opts.quiet)) touch('product', p);
  }
  return p;
}

// Repair: collapse duplicate catalog entries (same name, different ids) into
// one canonical entry; tombstone the extras so the cleanup syncs everywhere.
function dedupeProducts(){
  const groups = {};
  state.products.filter(p => !p.deleted).forEach(p => {
    const key = p.name.trim().toLowerCase().replace(/\s+/g, ' ');
    (groups[key] = groups[key] || []).push(p);
  });
  const dirty = [];
  Object.keys(groups).forEach(key => {
    const list = groups[key];
    if(list.length < 2) return;
    const canonId = productIdFor(list[0].name);
    let keeper = list.find(p => p.id === canonId) || list[0];
    if(keeper.id !== canonId){
      // recreate under the canonical id
      const np = { id: canonId, name: keeper.name, unit: keeper.unit, category: keeper.category, deleted: false, updatedAt: Date.now() };
      state.products.push(np);
      keeper = np;
      dirty.push(np);
    }
    list.forEach(p => {
      if(p.id !== keeper.id && !p.deleted){ p.deleted = true; p.updatedAt = Date.now(); dirty.push(p); }
    });
  });
  if(dirty.length){
    saveLocal();
    dirty.forEach(p => { if(sync.enabled && sync.db) sync.push('product', p); });
  }
  return dirty.length > 0;
}

/* ---------- grocery automation ---------- */
function addToGrocery(item, { auto } = { auto: true }){
  // dedupe: existing not-done entry for same item or same name+unit
  const existing = liveGroc().find(g => !g.done && (g.itemId === item.id ||
    (g.name.toLowerCase() === item.name.toLowerCase() && g.unit === item.unit)));
  if(existing) return existing;
  const g = {
    id: uid(), itemId: item.id, name: item.name, qtyNeeded: 1, unit: item.unit,
    category: item.category, fromBinId: item.binId, notes: item.notes || '', done: false, deleted: false
  };
  state.grocery.push(g);
  touch('grocery', g);
  return g;
}
function removeFromGroceryByItem(itemId){
  liveGroc().filter(g => g.itemId === itemId && !g.done).forEach(g => { g.deleted = true; touch('grocery', g); });
}

function setItemQty(item, qty){
  qty = Math.max(0, qty);
  if(qty === 0){
    // used up: leaves the bin entirely, lands on the grocery list
    addToGrocery(item);
    item.qty = 0;
    item.deleted = true;
    touch('item', item);
    toast(`"${item.name}" used up — moved to the grocery list 🛒`);
    render();
    return;
  }
  item.qty = qty;
  touch('item', item);
  render();
}

function toggleBuy(item){
  if(item.status === 'Buy'){
    item.status = 'Available';
    removeFromGroceryByItem(item.id);
  } else {
    item.status = 'Buy';
    addToGrocery(item);
    toast(`"${item.name}" flagged to buy 🛒`);
  }
  touch('item', item);
  render();
}

/* ---------- age / status helpers ---------- */
function agePills(item){
  const s = state.settings;
  const pills = [];
  const m = monthsSince(item.dateFrozen);
  if(m !== null){
    const mo = Math.floor(m);
    if(m >= s.old) pills.push(`<span class="pill red">❄ ${mo} mo — use now</span>`);
    else if(m >= s.useSoon) pills.push(`<span class="pill amber">❄ ${mo} mo — use soon</span>`);
    else pills.push(`<span class="pill green">❄ ${mo < 1 ? '<1' : mo} mo</span>`);
  }
  if(item.bestBefore && new Date(item.bestBefore+'T00:00:00') < new Date(todayStr()+'T00:00:00')){
    pills.push(`<span class="pill red">past best-before</span>`);
  }
  return pills.join('');
}
function statusPill(item){
  if(item.status === 'Buy') return '<span class="pill violet">BUY</span>';
  if(item.status === 'Used Up') return '<span class="pill gray">used up</span>';
  if(item.status === 'Low') return '<span class="pill amber">low</span>';
  return '';
}

/* ---------- QR helpers ---------- */
function binUrl(binId){
  return location.origin + location.pathname + '#bin/' + binId;
}
function qrDataUrl(text, cell = 5){
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createDataURL(cell, 8);
}
function parseScan(text){
  if(!text) return null;
  let m = text.match(/#bin\/([A-Za-z0-9_-]+)/);
  if(m) return m[1];
  m = text.match(/^froshizzle:bin:([A-Za-z0-9_-]+)$/i);
  if(m) return m[1];
  return null;
}

/* ============================================================
   ROUTER + RENDER
   ============================================================ */
let route = { view: 'home', id: null, hl: null };

function parseHash(){
  const h = location.hash.replace(/^#/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/');
  const hl = query ? new URLSearchParams(query).get('hl') : null;
  if(parts[0] === 'bin' && parts[1]) return { view: 'bin', id: parts[1], hl };
  if(['grocery','search','settings','labels','home'].includes(parts[0])) return { view: parts[0], id: null, hl: null };
  return { view: 'home', id: null, hl: null };
}

window.addEventListener('hashchange', () => { route = parseHash(); render(); });

function nav(to){ if(location.hash === '#'+to) render(); else location.hash = to; }

function render(){
  const v = $('#view');
  const back = $('#backbtn'), top = $('#topaction'), title = $('#titletext');
  back.style.display = 'none'; top.style.display = 'none';
  back.onclick = null; top.onclick = null;

  switch(route.view){
    case 'bin':      renderBin(v, back, top, title); break;
    case 'grocery':  renderGrocery(v, title); break;
    case 'search':   renderSearch(v, title); break;
    case 'settings': renderSettings(v, title); break;
    case 'labels':   renderLabels(v, back, title); break;
    default:         renderHome(v, title);
  }
  // bottom nav active state + badge
  $$('#nav [data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === (route.view === 'bin' || route.view === 'labels' ? 'home' : route.view)));
  const openCount = liveGroc().filter(g => !g.done).length;
  const badge = $('#gbadge');
  badge.style.display = openCount ? 'flex' : 'none';
  badge.textContent = openCount;
}

/* ---------- HOME ---------- */
function renderHome(v, title){
  title.textContent = 'FroShizzle';
  const bins = liveBins();
  const items = liveItems();
  const s = state.settings;
  const useSoonCt = items.filter(i => { const m = monthsSince(i.dateFrozen); return m !== null && m >= s.useSoon && m < s.old; }).length;
  const oldCt = items.filter(i => { const m = monthsSince(i.dateFrozen); return m !== null && m >= s.old; }).length;
  const buyCt = liveGroc().filter(g => !g.done).length;

  let html = `
  <div id="installbar"><div class="it"><b>Install FroShizzle</b><br>Add it to your home screen to use it like a regular app.</div>
    <button class="btn" id="installbtn">Install</button></div>
  <div class="stat-row">
    <div class="stat"><b>${items.filter(i=>i.qty>0).length}</b><span>IN FREEZER</span></div>
    <div class="stat buy"><b>${buyCt}</b><span>TO BUY</span></div>
    <div class="stat warn"><b>${useSoonCt}</b><span>${s.useSoon}+ MONTHS</span></div>
    <div class="stat old"><b>${oldCt}</b><span>${s.old}+ MONTHS</span></div>
  </div>
  <div class="section-h"><h2>Freezer bins</h2>
    <button class="btn small ghost no-print" id="printlabels">🏷 QR labels</button></div>`;

  if(!bins.length){
    html += `<div class="card empty"><span class="big">🧊</span><b>No bins yet</b><br>
      Create a bin for each basket or section of your freezer, stick its QR label on it, and start adding food.<br><br>
      <button class="btn" id="addbin1">＋ Add first bin</button>&nbsp;
      <button class="btn ghost" id="seed12">Create 12 bins</button></div>`;
  } else {
    html += '<div class="bin-grid">';
    bins.forEach(b => {
      const its = binItems(b.id).filter(i => i.qty > 0);
      const warn = its.some(i => { const m = monthsSince(i.dateFrozen); return m !== null && m >= s.useSoon && m < s.old; });
      const old = its.some(i => { const m = monthsSince(i.dateFrozen); return m !== null && m >= s.old; });
      html += `<button class="bin-card" data-open="${b.id}">
        <span class="bname">${esc(b.name)}</span>
        <span class="bdesc">${esc(b.desc || '')}</span>
        <span class="bcount">${its.length} item${its.length === 1 ? '' : 's'}</span>
        <span class="bflags">${old ? '<span class="pill red">use now</span>' : ''}${warn ? '<span class="pill amber">use soon</span>' : ''}</span>
      </button>`;
    });
    html += `</div><div style="margin-top:12px"><button class="btn ghost block" id="addbin1">＋ Add bin</button></div>`;
  }
  v.innerHTML = html;

  $$('[data-open]', v).forEach(b => b.onclick = () => nav('bin/' + b.dataset.open));
  const ab = $('#addbin1', v); if(ab) ab.onclick = () => openBinSheet(null);
  const sd = $('#seed12', v); if(sd) sd.onclick = () => {
    for(let i = 1; i <= 12; i++){
      const b = { id: uid() + i, name: 'Bin ' + i, desc: '', deleted: false };
      state.bins.push(b); touch('bin', b);
    }
    toast('Created 12 bins — rename them anytime');
    render();
  };
  $('#printlabels', v).onclick = () => nav('labels');
  setupInstallBar();
}

/* ---------- BIN VIEW ---------- */
function renderBin(v, back, top, title){
  const b = bin(route.id);
  if(!b){ v.innerHTML = '<div class="card empty"><span class="big">🤔</span>This bin doesn\'t exist (it may have been deleted).<br><br><button class="btn" onclick="location.hash=\'home\'">Back to bins</button></div>'; title.textContent = 'FroShizzle'; return; }
  title.textContent = b.name;
  back.style.display = 'flex';
  back.onclick = () => nav('home');
  top.style.display = 'flex';
  top.onclick = () => openBinMenu(b);

  const inStock = binItems(b.id).filter(i => i.qty > 0);

  let html = '';
  if(b.desc) html += `<div style="margin:-4px 2px 12px;color:var(--ink-soft);font-size:13.5px">${esc(b.desc)}</div>`;
  html += `<button class="btn block" id="additem">＋ Add item to ${esc(b.name)}</button><div style="height:13px"></div>`;

  if(!inStock.length){
    html += `<div class="card empty"><span class="big">📦</span>Nothing in this bin yet.</div>`;
  }
  const row = (i) => `
    <div class="item-row" id="ir-${i.id}">
      <div class="item-main" data-edit="${i.id}">
        <div class="iname">${esc(i.name)} ${statusPill(i)}</div>
        <div class="imeta"><span class="pill blue">${esc(i.category || 'Other')}</span>${agePills(i)}
          ${i.dateFrozen ? '<span>frozen ' + fmtDate(i.dateFrozen) + '</span>' : ''}</div>
      </div>
      <button class="pill ${i.status === 'Buy' ? 'violet' : 'gray'}" data-buy="${i.id}" style="border:none">🛒</button>
      <div class="qtybox">
        <button data-dec="${i.id}">−</button>
        <div class="qv">${i.qty}<span class="qu">${esc(i.unit || '')}</span></div>
        <button data-inc="${i.id}">＋</button>
      </div>
    </div>`;
  inStock.forEach(i => html += row(i));
  v.innerHTML = html;

  $('#additem', v).onclick = () => openItemSheet(null, b.id);
  $$('[data-edit]', v).forEach(el => el.onclick = () => openItemSheet(state.items.find(x => x.id === el.dataset.edit), b.id));
  $$('[data-inc]', v).forEach(el => el.onclick = () => { const i = state.items.find(x => x.id === el.dataset.inc); setItemQty(i, (+i.qty || 0) + 1); });
  $$('[data-dec]', v).forEach(el => el.onclick = () => { const i = state.items.find(x => x.id === el.dataset.dec); setItemQty(i, (+i.qty || 0) - 1); });
  $$('[data-buy]', v).forEach(el => el.onclick = () => toggleBuy(state.items.find(x => x.id === el.dataset.buy)));

  if(route.hl){
    const el = $('#ir-' + route.hl, v);
    if(el){ el.scrollIntoView({ block: 'center' }); el.classList.add('hl'); setTimeout(() => el.classList.remove('hl'), 1600); }
    route.hl = null;
  }
}

/* ---------- GROCERY ---------- */
function renderGrocery(v, title){
  title.textContent = 'Grocery list';
  const open = liveGroc().filter(g => !g.done);
  const done = liveGroc().filter(g => g.done);
  let html = `<button class="btn ghost block" id="addg">＋ Add grocery item</button><div style="height:13px"></div>`;
  if(!open.length && !done.length){
    html += `<div class="card empty"><span class="big">🛒</span><b>Grocery list is empty</b><br>
      When something in the freezer runs out (quantity hits 0) or you flag it with 🛒, it shows up here automatically.</div>`;
  }
  const row = (g) => {
    const fb = g.fromBinId ? bin(g.fromBinId) : null;
    return `<div class="g-row ${g.done ? 'done' : ''}">
      <button class="gcheck" data-check="${g.id}">${g.done ? '✓' : ''}</button>
      <div class="gmain">
        <div class="gname">${esc(g.name)}</div>
        <div class="gmeta">${g.qtyNeeded || 1} ${esc(g.unit || '')}${g.category ? ' · ' + esc(g.category) : ''}${fb ? ' · from ' + esc(fb.name) : ''}</div>
      </div>
      ${g.done ? `<button class="btn small" data-restock="${g.id}">Restock ❄</button>` : ''}
      <button class="iconbtn" style="background:var(--blue-50);color:var(--ink-soft);width:34px;height:34px" data-delg="${g.id}">✕</button>
    </div>`;
  };
  open.forEach(g => html += row(g));
  if(done.length){
    html += `<div class="section-h"><h2>Bought — tap Restock to put back in freezer</h2></div>`;
    done.forEach(g => html += row(g));
    html += `<button class="btn ghost block" id="cleardone">Clear bought items</button>`;
  }
  v.innerHTML = html;

  $('#addg', v).onclick = () => openGrocerySheet();
  $$('[data-check]', v).forEach(el => el.onclick = () => {
    const g = state.grocery.find(x => x.id === el.dataset.check);
    g.done = !g.done; touch('grocery', g); render();
  });
  $$('[data-delg]', v).forEach(el => el.onclick = () => {
    const g = state.grocery.find(x => x.id === el.dataset.delg);
    g.deleted = true; touch('grocery', g); render();
  });
  $$('[data-restock]', v).forEach(el => el.onclick = () => openRestockSheet(state.grocery.find(x => x.id === el.dataset.restock)));
  const cd = $('#cleardone', v);
  if(cd) cd.onclick = () => { done.forEach(g => { g.deleted = true; touch('grocery', g); }); render(); };
}

/* ---------- SEARCH ---------- */
let searchQ = '';
function renderSearch(v, title){
  title.textContent = 'Search freezer';
  v.innerHTML = `
    <div class="searchbar"><input id="sq" type="search" placeholder="Search all bins… e.g. chicken" value="${esc(searchQ)}" autocomplete="off"></div>
    <div id="sres"></div>`;
  const input = $('#sq', v);
  const res = $('#sres', v);
  const doSearch = () => {
    searchQ = input.value;
    const q = searchQ.trim().toLowerCase();
    if(!q){ res.innerHTML = `<div class="card empty"><span class="big">🔍</span>Type to search every bin at once — by name, category or notes.</div>`; return; }
    const hits = liveItems().filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.category || '').toLowerCase().includes(q) ||
      (i.notes || '').toLowerCase().includes(q)
    ).sort((a,b) => (b.qty > 0) - (a.qty > 0) || a.name.localeCompare(b.name));
    if(!hits.length){ res.innerHTML = `<div class="card empty">No “${esc(searchQ)}” in the freezer.<br>It might be on the <a href="#grocery">grocery list</a>.</div>`; return; }
    res.innerHTML = hits.map(i => {
      const b = bin(i.binId);
      return `<div class="item-row ${i.qty <= 0 ? 'dim' : ''}" data-go="${i.binId}" data-hl="${i.id}">
        <div class="item-main">
          <div class="iname">${esc(i.name)} ${statusPill(i)}</div>
          <div class="imeta"><span class="pill blue">📍 ${esc(b ? b.name : '?')}</span>
            <span>${i.qty} ${esc(i.unit || '')}</span>${agePills(i)}</div>
        </div><div style="font-size:18px;color:var(--ink-soft)">›</div>
      </div>`;
    }).join('');
    $$('[data-go]', res).forEach(el => el.onclick = () => { location.hash = 'bin/' + el.dataset.go + '?hl=' + el.dataset.hl; });
  };
  input.oninput = doSearch;
  doSearch();
  if(!('ontouchstart' in window) || document.activeElement !== input) setTimeout(() => input.focus(), 50);
}

/* ---------- LABELS (printable) ---------- */
function renderLabels(v, back, title){
  title.textContent = 'QR labels';
  back.style.display = 'flex';
  back.onclick = () => nav('home');
  const bins = liveBins();
  if(!bins.length){ v.innerHTML = '<div class="card empty">Create some bins first.</div>'; return; }
  let html = `<div class="card no-print" style="display:flex;gap:10px;align-items:center">
      <div style="flex:1;font-size:13.5px">Print this page, cut out the labels and tape one on each bin (packing tape over the label keeps frost off).</div>
      <button class="btn" id="doprint">🖨 Print</button></div>
    <div class="labels-grid">`;
  bins.forEach(b => {
    html += `<div class="label-card">
      <img src="${qrDataUrl(binUrl(b.id), 4)}" alt="QR">
      <div class="lname">❄ ${esc(b.name)}</div>
      <div class="lsub">${esc(b.desc || 'FroShizzle freezer bin')}</div>
      <div class="lsub">Scan with FroShizzle or your camera</div>
    </div>`;
  });
  html += '</div>';
  v.innerHTML = html;
  $('#doprint', v).onclick = () => window.print();
}

/* ---------- SETTINGS ---------- */
function renderSyncStatus(){
  const el = $('#syncstatus');
  if(!el) return;
  const map = {
    off: '<span class="sync-dot off"></span>Not connected',
    connecting: '<span class="sync-dot off"></span>Connecting…',
    on: '<span class="sync-dot on"></span>Syncing — family members with this household code see the same inventory',
    error: '<span class="sync-dot off" style="background:var(--red)"></span>Connection problem — check the config and internet'
  };
  el.innerHTML = map[sync.status] || map.off;
}

function renderSettings(v, title){
  title.textContent = 'Settings';
  const s = state.settings;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  v.innerHTML = `
  <div class="card">
    <h3 style="margin-bottom:4px">📲 Install on your phone</h3>
    <div style="font-size:13px;color:var(--ink-soft);line-height:1.55" id="installhelp">
      ${standalone ? 'Installed — you\'re using the app version. 🎉' :
      `In Chrome or Samsung Internet: tap the <b>⋮ menu → Add to Home screen → Install</b>. FroShizzle then opens full-screen like a normal app, works offline, and keeps its own icon.`}
    </div>
    <div id="installslot"></div>
  </div>

  <div class="card">
    <h3 style="margin-bottom:6px">👨‍👩‍👧 Family sync</h3>
    <div style="font-size:13px;margin-bottom:10px" id="syncstatus"></div>
    <div class="frow"><label>Household code (same on every phone)</label>
      <input id="synccode" placeholder="e.g. JANSEN-FREEZER" value="${esc(s.sync ? s.sync.code : '')}" style="text-transform:uppercase"></div>
    <div class="frow"><label>Firebase config (paste from the setup guide, step "Firebase")</label>
      <textarea id="syncconfig" rows="4" placeholder='{ "apiKey": "...", "projectId": "...", ... }'>${esc(s.sync && s.sync.config ? JSON.stringify(s.sync.config, null, 1) : '')}</textarea></div>
    <div class="sheet-actions">
      <button class="btn" id="syncsave">${sync.enabled ? 'Reconnect' : 'Connect sync'}</button>
      ${sync.enabled ? '<button class="btn danger" id="syncoff">Turn off</button>' : ''}
    </div>
  </div>

  <div class="card">
    <h3 style="margin-bottom:4px">⏱ Freshness warnings</h3>
    <div class="set-row"><div><div class="sl">"Use soon" after</div><div class="sd">Months in the freezer before the amber warning</div></div>
      <input type="number" id="set-soon" min="1" max="36" value="${s.useSoon}"> </div>
    <div class="set-row"><div><div class="sl">"Use now" after</div><div class="sd">Months before the red warning</div></div>
      <input type="number" id="set-old" min="2" max="60" value="${s.old}"></div>
  </div>

  <div class="card">
    <h3 style="margin-bottom:8px">🗂 Data</h3>
    <div class="sheet-actions" style="margin-top:0">
      <button class="btn ghost" id="exportbtn">⬇ Export backup</button>
      <button class="btn ghost" id="importbtn">⬆ Import backup</button>
    </div>
    <input type="file" id="importfile" accept=".json,application/json" style="display:none">
    <div style="height:10px"></div>
    <button class="btn ghost block" id="prodbtn">🏷 Saved products (${liveProds().length})</button>
    <div style="height:10px"></div>
    <button class="btn danger block" id="wipebtn">Erase everything on this phone</button>
  </div>
  <div style="text-align:center;color:var(--ink-soft);font-size:12px;padding:6px">FroShizzle v1.0 · made for Rockstar's deep freezer ❄</div>`;

  renderSyncStatus();
  setupInstallBar('#installslot');

  $('#set-soon', v).onchange = (e) => { s.useSoon = Math.max(1, +e.target.value || 6); saveLocal(); if(sync.enabled) sync.pushMeta(); render(); };
  $('#set-old', v).onchange = (e) => { s.old = Math.max(s.useSoon + 1, +e.target.value || 12); saveLocal(); if(sync.enabled) sync.pushMeta(); render(); };

  $('#syncsave', v).onclick = async () => {
    const code = $('#synccode', v).value.trim().toUpperCase();
    const cfgText = $('#syncconfig', v).value.trim();
    if(!code){ toast('Enter a household code first'); return; }
    const config = tolerantParseConfig(cfgText);
    if(!config || !config.projectId){ toast('That config doesn\'t look right — paste the whole snippet from Firebase'); return; }
    sync.stop();
    s.sync = { code, config };
    saveLocal();
    await sync.start();
    if(sync.status === 'on') toast('Sync connected ✓');
    render();
  };
  const so = $('#syncoff', v);
  if(so) so.onclick = () => { sync.stop(); s.sync = null; saveLocal(); toast('Sync turned off — data stays on this phone'); render(); };

  $('#exportbtn', v).onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'froshizzle-backup-' + todayStr() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#importbtn', v).onclick = () => $('#importfile', v).click();
  $('#importfile', v).onchange = (e) => {
    const f = e.target.files[0];
    if(!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const s2 = JSON.parse(r.result);
        if(!s2.bins || !s2.items) throw new Error('not a FroShizzle backup');
        state = Object.assign(state, s2);
        if(!Array.isArray(state.products)) state.products = [];
        state.bins.forEach(b => touch('bin', b));
        state.items.forEach(i => touch('item', i));
        state.grocery.forEach(g => touch('grocery', g));
        state.products.forEach(p => touch('product', p));
        saveLocal(); toast('Backup imported ✓'); render();
      } catch(err){ toast('Import failed: ' + err.message); }
    };
    r.readAsText(f);
  };
  $('#prodbtn', v).onclick = () => openProductsSheet();
  $('#wipebtn', v).onclick = () => confirmSheet('Erase everything?', 'This deletes all bins, items and the grocery list on this phone. If sync is on, other phones are not wiped.', () => {
    localStorage.removeItem(LS_KEY);
    state = { settings: { useSoon: 6, old: 12, sync: null }, bins: [], items: [], grocery: [], products: [] };
    sync.stop(); toast('All data erased'); nav('home');
  });
}

function tolerantParseConfig(text){
  if(!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if(!m) return null;
  let js = m[0];
  try { return JSON.parse(js); } catch(e){}
  // quote unquoted keys, strip trailing commas
  js = js.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}').replace(/'/g, '"');
  try { return JSON.parse(js); } catch(e){ return null; }
}

/* ============================================================
   SHEETS (bottom drawers)
   ============================================================ */
function openSheet(html){
  $('#sheet').innerHTML = '<div class="grip"></div>' + html;
  $('#sheet').classList.add('show');
  $('#sheet-back').classList.add('show');
}
function closeSheet(){
  $('#sheet').classList.remove('show');
  $('#sheet-back').classList.remove('show');
}
$('#sheet-back').addEventListener('click', closeSheet);

function confirmSheet(title, msg, onYes){
  openSheet(`<h2>${esc(title)}</h2><p style="color:var(--ink-soft);font-size:14px;line-height:1.5;margin-top:0">${esc(msg)}</p>
    <div class="sheet-actions"><button class="btn ghost" id="cs-no">Cancel</button><button class="btn danger" id="cs-yes">Yes, do it</button></div>`);
  $('#cs-no').onclick = closeSheet;
  $('#cs-yes').onclick = () => { closeSheet(); onYes(); };
}

/* ---------- item add/edit sheet ---------- */
function chipRow(id, options, selected){
  return `<div class="chiprow" id="${id}">` + options.map(o =>
    `<button class="chip ${o === selected ? 'sel' : ''}" data-val="${esc(o)}">${esc(o)}</button>`).join('') + '</div>';
}
function bindChips(id, onSel){
  $$('#' + id + ' .chip').forEach(c => c.onclick = () => {
    $$('#' + id + ' .chip').forEach(x => x.classList.remove('sel'));
    c.classList.add('sel');
    if(onSel) onSel(c.dataset.val);
  });
}
function chipVal(id){ const c = $('#' + id + ' .chip.sel'); return c ? c.dataset.val : null; }

function selectChip(id, val){
  $$('#' + id + ' .chip').forEach(x => x.classList.toggle('sel', x.dataset.val === val));
}

function openItemSheet(item, binId){
  const isNew = !item;
  const it = item || { name: '', qty: 1, unit: 'pkg', category: 'Other', dateFrozen: todayStr(), bestBefore: '', status: 'Available', notes: '' };
  const prods = liveProds();
  const prevPicker = (isNew && prods.length) ? `
    <div class="frow"><label>Add a product you've entered before</label>
      <select id="f-prev">
        <option value="">— pick from your saved products —</option>
        ${prods.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.category)})</option>`).join('')}
      </select></div>
    <div style="text-align:center;color:var(--ink-soft);font-size:12px;margin:-4px 0 10px">— or type a new one —</div>` : '';
  openSheet(`
    <h2>${isNew ? '＋ Add item' : '✏️ Edit item'}</h2>
    ${prevPicker}
    <div class="frow"><label>Item name</label><input id="f-name" value="${esc(it.name)}" placeholder="e.g. Ground beef 1lb" autocomplete="off"></div>
    <div class="frow2">
      <div class="frow"><label>Quantity</label><input id="f-qty" type="number" min="0" step="1" value="${it.qty}"></div>
      <div class="frow"><label>Unit</label><select id="f-unit">${UNITS.map(u => `<option ${u === it.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    </div>
    <div class="frow"><label>Category</label>${chipRow('f-cat', CATEGORIES, it.category)}</div>
    <div class="frow2">
      <div class="frow"><label>Date frozen</label><input id="f-frozen" type="date" value="${esc(it.dateFrozen || '')}"></div>
      <div class="frow"><label>Best before (optional)</label><input id="f-bb" type="date" value="${esc(it.bestBefore || '')}"></div>
    </div>
    <div class="frow"><label>Status</label>${chipRow('f-status', ['Available','Low','Buy'], it.status === 'Used Up' ? 'Available' : it.status)}</div>
    <div class="frow"><label>Notes (optional)</label><input id="f-notes" value="${esc(it.notes || '')}" placeholder="e.g. from Costco, use for stew"></div>
    <div class="sheet-actions">
      ${isNew ? '' : '<button class="btn danger" id="f-del">Delete</button>'}
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn" id="f-save">${isNew ? 'Add to bin' : 'Save'}</button>
    </div>`);
  bindChips('f-cat'); bindChips('f-status');
  const prev = $('#f-prev');
  if(prev) prev.onchange = () => {
    const p = state.products.find(x => x.id === prev.value);
    if(!p) return;
    $('#f-name').value = p.name;
    $('#f-unit').value = UNITS.includes(p.unit) ? p.unit : 'other';
    selectChip('f-cat', CATEGORIES.includes(p.category) ? p.category : 'Other');
  };
  $('#f-cancel').onclick = closeSheet;
  if(!isNew) $('#f-del').onclick = () => confirmSheet('Delete "' + it.name + '"?', 'Removes it from the bin (does not add it to the grocery list).', () => {
    it.deleted = true; touch('item', it); removeFromGroceryByItem(it.id); render();
  });
  $('#f-save').onclick = () => {
    const name = $('#f-name').value.trim();
    if(!name){ toast('Give it a name'); return; }
    const wasStatus = it.status;
    it.name = name;
    it.qty = Math.max(0, parseInt($('#f-qty').value, 10) || 0);
    it.unit = $('#f-unit').value;
    it.category = chipVal('f-cat') || 'Other';
    it.dateFrozen = $('#f-frozen').value;
    it.bestBefore = $('#f-bb').value;
    it.status = chipVal('f-status') || 'Available';
    it.notes = $('#f-notes').value.trim();
    if(isNew){
      it.id = uid(); it.binId = binId; it.deleted = false;
      state.items.push(it);
    }
    upsertProduct(it);   // remember this product for the dropdown
    // grocery side-effects
    if(it.status === 'Buy' && wasStatus !== 'Buy') addToGrocery(it);
    if(it.qty === 0){
      addToGrocery(it);
      it.deleted = true;   // qty 0 leaves the bin, lives on the grocery list
    }
    touch('item', it);
    closeSheet(); render();
    if(it.qty === 0) toast(`"${it.name}" is at 0 — moved to the grocery list 🛒`);
    else if(isNew) toast('Added "' + it.name + '" ❄');
  };
}

/* ---------- bin sheets ---------- */
function openBinSheet(b){
  const isNew = !b;
  const bn = b || { name: 'Bin ' + (liveBins().length + 1), desc: '' };
  openSheet(`
    <h2>${isNew ? '＋ New bin' : '✏️ Edit bin'}</h2>
    <div class="frow"><label>Bin name</label><input id="b-name" value="${esc(bn.name)}" autocomplete="off"></div>
    <div class="frow"><label>Description (optional)</label><input id="b-desc" value="${esc(bn.desc || '')}" placeholder="e.g. Left basket — meats"></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="b-cancel">Cancel</button>
      <button class="btn" id="b-save">${isNew ? 'Create bin' : 'Save'}</button>
    </div>`);
  $('#b-cancel').onclick = closeSheet;
  $('#b-save').onclick = () => {
    const name = $('#b-name').value.trim();
    if(!name){ toast('Give the bin a name'); return; }
    bn.name = name; bn.desc = $('#b-desc').value.trim();
    if(isNew){ bn.id = uid(); bn.deleted = false; state.bins.push(bn); }
    touch('bin', bn);
    closeSheet(); render();
    if(isNew){ toast('Bin created — print its QR label from the home screen 🏷'); }
  };
}

function openBinMenu(b){
  openSheet(`
    <h2>${esc(b.name)}</h2>
    <div class="qrbox">
      <img src="${qrDataUrl(binUrl(b.id), 5)}" alt="QR code for ${esc(b.name)}">
      <div style="font-size:12.5px;color:var(--ink-soft);text-align:center">Scanning this opens the bin — in the app or with the phone camera.</div>
    </div>
    <div class="sheet-actions" style="flex-direction:column">
      <button class="btn ghost block" id="bm-edit">✏️ Rename / description</button>
      <button class="btn ghost block" id="bm-labels">🏷 Print all labels</button>
      <button class="btn danger block" id="bm-del">🗑 Delete bin</button>
    </div>`);
  $('#bm-edit').onclick = () => openBinSheet(b);
  $('#bm-labels').onclick = () => { closeSheet(); nav('labels'); };
  $('#bm-del').onclick = () => confirmSheet('Delete "' + b.name + '"?', 'The bin and everything recorded inside it will be removed.', () => {
    b.deleted = true; touch('bin', b);
    binItems(b.id).forEach(i => { i.deleted = true; touch('item', i); });
    nav('home');
  });
}

/* ---------- product catalog sheet ---------- */
function openProductsSheet(){
  const prods = liveProds();
  openSheet(`
    <h2>🏷 Saved products</h2>
    <p style="color:var(--ink-soft);font-size:13px;margin-top:0">Every product you've ever entered. These fill the "previously entered" dropdown when adding items. Deleting one here doesn't touch the freezer or grocery list.</p>
    ${prods.length ? prods.map(p => `
      <div class="g-row">
        <div class="gmain"><div class="gname">${esc(p.name)}</div>
        <div class="gmeta">${esc(p.unit)} · ${esc(p.category)}</div></div>
        <button class="iconbtn" style="background:var(--blue-50);color:var(--ink-soft);width:34px;height:34px" data-delp="${p.id}">✕</button>
      </div>`).join('') : '<div class="empty">Nothing saved yet — products appear here as you add items.</div>'}
    <div class="sheet-actions"><button class="btn ghost block" id="p-close">Close</button></div>`);
  $$('#sheet [data-delp]').forEach(el => el.onclick = () => {
    const p = state.products.find(x => x.id === el.dataset.delp);
    p.deleted = true; touch('product', p);
    openProductsSheet();
  });
  $('#p-close').onclick = closeSheet;
}

/* ---------- grocery sheets ---------- */
function openGrocerySheet(){
  openSheet(`
    <h2>＋ Grocery item</h2>
    <div class="frow"><label>Name</label><input id="g-name" placeholder="e.g. Frozen peas" autocomplete="off"></div>
    <div class="frow2">
      <div class="frow"><label>Qty needed</label><input id="g-qty" type="number" min="1" value="1"></div>
      <div class="frow"><label>Unit</label><select id="g-unit">${UNITS.map(u => `<option>${u}</option>`).join('')}</select></div>
    </div>
    <div class="frow"><label>Category</label>${chipRow('g-cat', CATEGORIES, 'Other')}</div>
    <div class="sheet-actions">
      <button class="btn ghost" id="g-cancel">Cancel</button>
      <button class="btn" id="g-save">Add to list</button>
    </div>`);
  bindChips('g-cat');
  $('#g-cancel').onclick = closeSheet;
  $('#g-save').onclick = () => {
    const name = $('#g-name').value.trim();
    if(!name){ toast('Give it a name'); return; }
    const g = { id: uid(), itemId: null, name, qtyNeeded: Math.max(1, +$('#g-qty').value || 1),
      unit: $('#g-unit').value, category: chipVal('g-cat') || 'Other', fromBinId: null, notes: '', done: false, deleted: false };
    state.grocery.push(g); touch('grocery', g);
    closeSheet(); render();
  };
}

function openRestockSheet(g){
  const bins = liveBins();
  openSheet(`
    <h2>❄ Restock "${esc(g.name)}"</h2>
    <p style="color:var(--ink-soft);font-size:13.5px;margin-top:0">Puts it back into the freezer inventory with today's date.</p>
    <div class="frow2">
      <div class="frow"><label>Quantity</label><input id="r-qty" type="number" min="1" value="${g.qtyNeeded || 1}"></div>
      <div class="frow"><label>Unit</label><select id="r-unit">${UNITS.map(u => `<option ${u === g.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    </div>
    <div class="frow"><label>Into bin</label><select id="r-bin">${bins.map(b => `<option value="${b.id}" ${b.id === g.fromBinId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="r-cancel">Cancel</button>
      <button class="btn" id="r-save">Put in freezer</button>
    </div>`);
  $('#r-cancel').onclick = closeSheet;
  $('#r-save').onclick = () => {
    const qty = Math.max(1, +$('#r-qty').value || 1);
    const binId = $('#r-bin').value;
    if(!binId){ toast('Pick a bin'); return; }
    // merge into a matching live item in the target bin if there is one; else create new
    let it = state.items.find(x => !x.deleted && x.binId === binId &&
      x.name.toLowerCase() === g.name.toLowerCase() && x.unit === $('#r-unit').value) ||
      (g.itemId ? state.items.find(x => x.id === g.itemId && !x.deleted) : null);
    if(it){
      it.qty = (+it.qty || 0) + qty;
      it.binId = binId; it.status = 'Available'; it.dateFrozen = todayStr();
      touch('item', it);
    } else {
      it = { id: uid(), binId, name: g.name, qty, unit: $('#r-unit').value, category: g.category || 'Other',
        dateFrozen: todayStr(), bestBefore: '', status: 'Available', notes: g.notes || '', deleted: false };
      state.items.push(it); touch('item', it);
    }
    upsertProduct(it);
    g.deleted = true; touch('grocery', g);
    closeSheet(); render();
    toast(`"${it.name}" back in the freezer ✓`);
  };
}

/* ============================================================
   QR SCANNER
   ============================================================ */
const scanner = {
  stream: null, raf: null, detector: null, running: false,
  async open(){
    $('#scanner').classList.add('show');
    $('#scan-hint').textContent = 'Point the camera at a bin label';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch(e){
      $('#scan-hint').textContent = 'Camera blocked. Allow camera access for this site in your browser settings, or scan the label with your phone\'s camera app instead.';
      return;
    }
    const video = $('#scan-video');
    video.srcObject = this.stream;
    await video.play();
    this.running = true;
    if('BarcodeDetector' in window){
      try {
        const fmts = await BarcodeDetector.getSupportedFormats();
        if(fmts.includes('qr_code')) this.detector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch(e){ this.detector = null; }
    }
    this.tick();
  },
  async tick(){
    if(!this.running) return;
    const video = $('#scan-video');
    if(video.readyState === video.HAVE_ENOUGH_DATA){
      let text = null;
      if(this.detector){
        try {
          const codes = await this.detector.detect(video);
          if(codes.length) text = codes[0].rawValue;
        } catch(e){ this.detector = null; }
      }
      if(!text && typeof jsQR !== 'undefined'){
        const c = this._canvas || (this._canvas = document.createElement('canvas'));
        const w = 480, h = Math.round(480 * video.videoHeight / (video.videoWidth || 640));
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const found = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if(found) text = found.data;
      }
      if(text){
        const binId = parseScan(text);
        if(binId){
          if(bin(binId)){
            this.close();
            if(navigator.vibrate) navigator.vibrate(80);
            location.hash = 'bin/' + binId;
            return;
          }
          $('#scan-hint').textContent = 'That QR is a FroShizzle bin, but it isn\'t in this app\'s data (was it deleted, or is sync not set up?)';
        } else {
          $('#scan-hint').textContent = 'That doesn\'t look like a FroShizzle bin label';
        }
      }
    }
    this.raf = setTimeout(() => this.tick(), 180);
  },
  close(){
    this.running = false;
    clearTimeout(this.raf);
    if(this.stream){ this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    $('#scan-video').srcObject = null;
    $('#scanner').classList.remove('show');
  }
};
$('#scan-close').addEventListener('click', () => scanner.close());

/* ============================================================
   INSTALL PROMPT + BOOT
   ============================================================ */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  setupInstallBar();
});
function setupInstallBar(slotSel){
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const bar = $('#installbar');
  if(bar){
    if(deferredPrompt && !standalone){
      bar.classList.add('show');
      $('#installbtn').onclick = async () => {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        bar.classList.remove('show');
      };
    } else bar.classList.remove('show');
  }
  if(slotSel && deferredPrompt && !standalone){
    const slot = $(slotSel);
    if(slot && !slot.firstChild){
      slot.innerHTML = '<div style="height:10px"></div><button class="btn block" id="installbtn2">📲 Install now</button>';
      $('#installbtn2').onclick = async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; render(); };
    }
  }
}

$$('#nav [data-nav]').forEach(b => {
  b.addEventListener('click', () => {
    const to = b.dataset.nav;
    if(to === 'scan'){ scanner.open(); return; }
    nav(to);
  });
});

if('serviceWorker' in navigator){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e)));
}

/* boot */
loadState();
route = parseHash();
render();
if(sync.enabled) sync.start();
