// FKN test build. One page is the whole app.
// - Identity is twelve words; every key is derived from them in the browser.
// - A network is a key. Its host hands out blind seat tokens: the host approves
//   a person without learning which handle that person will use.
// - A handle with a valid seat certificate is a member. Nobody keeps a member list.
// - Rooms, messages, polls and long posts are signed notes held by open relays.
// - Every browser shows only notes from seated members.
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { generateSeedWords, validateWords, privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { seatSecret, seatPublic, blindSeat, signBlinded, unblindSeat, signSeat, verifySeat } from './seat.js';

const K_MSG = 4270, K_JOIN = 4271, K_ROOM = 4272, K_POST = 4273, K_POLL = 4274, K_VOTE = 4275, K_GRANT = 4276, K_SEAT = 4277, K_NET = 30078;
const NOTE_KINDS = [K_MSG, K_JOIN, K_ROOM, K_POST, K_POLL, K_VOTE, K_GRANT, K_SEAT];
const MEMBER_KINDS = [K_MSG, K_ROOM, K_POST, K_POLL, K_VOTE];
const HEX96 = /^[0-9a-f]{96}$/, HEX192 = /^[0-9a-f]{192}$/;
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX = { msg: 1000, title: 60, about: 140, postTitle: 120, postBody: 20000, pollQ: 200, pollOpt: 60, any: 30000 };
const VIEWS = ['rooms', 'room', 'newroom', 'reading', 'post', 'write', 'you'];

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array(s.match(/.{2}/g).map((x) => parseInt(x, 16)));
const now = () => Math.floor(Date.now() / 1000);
const tagVal = (ev, name, marker) => { const t = (ev.tags || []).find((x) => Array.isArray(x) && x[0] === name && (marker === undefined || x[2] === marker)); return t ? t[1] : null; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// A seat certificate covers a handle and its name together, so the name is locked for the whole era.
const subject = (pk, name) => pk + '|' + name;
const codeOf = (pk) => pk.slice(0, 4) + '-' + pk.slice(4, 8);

const mem = {};
const store = {
  get(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* fall through */ } return k in mem ? mem[k] : null; },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* memory only */ } },
  json(k, fallback) { try { const v = JSON.parse(this.get(k) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; } },
};

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function stamp(ms) {
  const d = new Date(ms), ts = Math.floor(ms / 1000);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === new Date().toDateString() ? hm : when(ts) + ', ' + hm;
}

function when(ts) {
  const d = new Date(ts * 1000), t = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === t.toDateString()) return hm;
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}

// ---------- relays ----------

class Pool {
  constructor(urls, filters, handlers) {
    this.urls = urls; this.filters = filters; this.on = handlers;
    this.socks = new Map(); this.open = new Set();
    this.outbox = new Map(); this.acks = new Map(); this.refused = new Map(); this.wait = new Map();
    urls.forEach((u) => this.connect(u));
  }
  connect(url) {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    this.socks.set(url, ws);
    ws.onopen = () => {
      this.open.add(url); this.wait.delete(url); this.on.status();
      ws.send(JSON.stringify(['REQ', 'fkn', ...this.filters]));
      for (const [id, ev] of this.outbox) {
        if (!(this.acks.get(id) || new Set()).has(url)) ws.send(JSON.stringify(['EVENT', ev]));
      }
    };
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch (e) { return; }
      if (!Array.isArray(d)) return;
      if (d[0] === 'EVENT' && d[2]) this.on.event(d[2]);
      else if (d[0] === 'OK' && typeof d[1] === 'string') {
        if (d[2] === true) {
          if (!this.acks.has(d[1])) this.acks.set(d[1], new Set());
          this.acks.get(d[1]).add(url);
        } else if (this.outbox.has(d[1])) this.refused.set(d[1], String(d[3] || 'refused').slice(0, 80));
        this.on.status();
      }
    };
    ws.onclose = () => {
      this.open.delete(url); this.on.status();
      const delay = Math.min((this.wait.get(url) || 750) * 2, 12000);   // 1.5s, 3s, 6s, then every 12s
      this.wait.set(url, delay);
      setTimeout(() => this.connect(url), delay);
    };
    ws.onerror = () => {};
  }
  publish(ev) {
    this.outbox.set(ev.id, ev);
    for (const url of this.open) {
      try { this.socks.get(url).send(JSON.stringify(['EVENT', ev])); } catch (e) { /* retried on reconnect */ }
    }
  }
}

// ---------- state ----------

const S = {
  cfg: null, T: '', words: '', sk: null, pk: '', hostSk: null, hostPk: '', isHost: false, seatSk: null, pool: null, fast: false,
  net: null, netDeadline: 0,                       // { at, id, name, seatKey, era }
  members: new Map(), names: new Map(),           // handle -> { name, at, id }; handle -> shown name
  claims: [], claiming: false, badClaims: 0, certOk: new Set(),
  requests: new Map(), grants: new Map(), sideChecked: 0,   // seat requests and the host's blind grants
  pending: null, claimTimer: null,                // my own seat request in flight
  seen: new Set(), queue: [], limbo: new Map(), draining: false,
  byId: new Map(), rooms: [], posts: [], byRoot: new Map(), polls: new Map(), votes: new Map(),
  ignored: new Set(), muted: new Set(), follow: new Set(), lastSeen: {},
  reply: null, lastSent: 0, readFilter: 'all', edition: '', editionAt: 0, quiet: false,
};

const memberOf = (pk) => (S.members.has(pk) ? { name: S.names.get(pk) } : null);
// Quiet reading: this device contacts no relay, so it can read but not speak.
const canSpeak = () => S.members.has(S.pk) && !S.quiet;
const nameOf = (pk) => S.names.get(pk) || 'unknown';
const visible = (ev) => !!memberOf(ev.pubkey) && !S.muted.has(ev.pubkey);
const saveSet = (key, set) => store.set(key + '.' + S.cfg.s, JSON.stringify([...set]));

function makeIdentity(words) {
  const id = { w: words, k0: toHex(privateKeyFromSeedWords(words, '', 0)), k1: toHex(privateKeyFromSeedWords(words, '', 1)) };
  store.set('fkn.id', JSON.stringify(id));
  return id;
}

function loadIdentity() {
  let id = store.json('fkn.id', null);
  if (!id || typeof id.w !== 'string' || !HEX64.test(id.k0 || '') || !HEX64.test(id.k1 || '')) id = makeIdentity(generateSeedWords());
  S.words = id.w; S.sk = fromHex(id.k0); S.pk = getPublicKey(S.sk);
  S.hostSk = fromHex(id.k1); S.hostPk = getPublicKey(S.hostSk);
}

// ---------- incoming notes ----------

function incoming(ev) {
  if (!ev || typeof ev.id !== 'string' || S.seen.has(ev.id)) return;
  if (typeof ev.content !== 'string' || ev.content.length > MAX.any || typeof ev.pubkey !== 'string') return;
  if (ev.kind === K_NET) { S.seen.add(ev.id); takeNet(ev); return; }
  if (!NOTE_KINDS.includes(ev.kind) || tagVal(ev, 't') !== S.T) return;
  S.seen.add(ev.id);
  if (ev.kind === K_SEAT) { S.claims.push(ev); drainClaims(); }
  else if (ev.kind === K_JOIN || ev.kind === K_GRANT) takeSide(ev);
  else { S.queue.push(ev); drain(); }
}

// The network's own note: its name and the public key that seat certificates are checked against.
function takeNet(ev) {
  if (ev.pubkey !== S.cfg.s || tagVal(ev, 'd') !== 'fkn:net') return;
  if (S.net && !(ev.created_at > S.net.at || (ev.created_at === S.net.at && ev.id < S.net.id))) return;
  let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
  if (!ok) return;
  let body; try { body = JSON.parse(ev.content); } catch (e) { return; }
  if (!body || !HEX192.test(body.seatKey || '')) return;
  const era = Number.isInteger(body.era) && body.era > 0 ? body.era : 1;
  if (S.net && (S.net.seatKey !== body.seatKey || S.net.era !== era)) { S.members.clear(); S.names.clear(); }
  S.net = { at: ev.created_at, id: ev.id, name: clip(String(body.name || 'FKN'), 40), seatKey: body.seatKey, era, ev };
  drainClaims(); checkPending(); drain(); scheduleRefresh();
}

// Seat claims: a handle shows its certificate. Checked one per tick, because the check is heavy.
function drainClaims() {
  if (S.claiming || !S.net) return;
  S.claiming = true;
  const step = () => {
    const ev = S.claims.shift();
    if (!ev) { S.claiming = false; return; }
    acceptClaim(ev);
    setTimeout(step, 0);
  };
  step();
}

function acceptClaim(ev) {
  let body; try { body = JSON.parse(ev.content); } catch (e) { return; }
  if (!body || !NAME_RE.test(body.name || '') || !HEX96.test(body.cert || '')) return;
  const prev = S.members.get(ev.pubkey);   // a handle's first claim fixes its name
  if (prev && (prev.at < ev.created_at || (prev.at === ev.created_at && prev.id <= ev.id))) return;
  let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
  if (!ok) return;
  const key = subject(ev.pubkey, body.name) + '|' + body.cert + '|' + S.net.era + '|' + S.net.seatKey.slice(0, 16);
  if (!S.certOk.has(key)) {
    if (S.badClaims > 300) return;
    if (!verifySeat(body.cert, S.net.era, subject(ev.pubkey, body.name), S.net.seatKey)) { S.badClaims += 1; return; }
    S.certOk.add(key);
    store.set('fkn.certok.' + S.cfg.s, JSON.stringify([...S.certOk].slice(-2000)));
  }
  S.members.set(ev.pubkey, { name: body.name, at: ev.created_at, id: ev.id, ev });
  // Two handles may pick the same name. Then every holder of it gets a short tail, so nobody can pass as another.
  const count = new Map();
  for (const m of S.members.values()) count.set(m.name, (count.get(m.name) || 0) + 1);
  S.names.clear();
  for (const [pk, m] of S.members) S.names.set(pk, count.get(m.name) > 1 ? m.name + '~' + pk.slice(0, 4) : m.name);
  // Notes that arrived before their author was seated get a second look.
  const held = S.limbo.get(ev.pubkey);
  if (held) { S.queue.push(...held); S.limbo.delete(ev.pubkey); drain(); }
  if (ev.pubkey === S.pk && S.pending) { S.pending = null; store.set('fkn.pending.' + S.cfg.s, 'null'); }
  scheduleRefresh();
}

// Seat requests (from throwaway keys) and the host's blind grants.
function takeSide(ev) {
  const mine = S.pending && S.pending.reqId;
  if (ev.kind === K_JOIN) {
    if (!S.isHost || S.requests.size > 500) return;                 // only the host needs these
    let body; try { body = JSON.parse(ev.content); } catch (e) { return; }
    if (!body || !HEX96.test(body.blind || '')) return;
    S.sideChecked += 1; if (S.sideChecked > 1500) return;
    let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
    if (ok) S.requests.set(ev.id, { pubkey: ev.pubkey, blind: body.blind, at: ev.created_at });
  } else {
    const reqId = tagVal(ev, 'e');
    if (ev.pubkey !== S.cfg.s || !HEX64.test(reqId || '')) return;
    if (!S.isHost && reqId !== mine) return;                        // only the asker and the host need these
    let body; try { body = JSON.parse(ev.content); } catch (e) { return; }
    if (!body || !HEX96.test(body.signed || '')) return;
    let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
    if (ok) { S.grants.set(reqId, body.signed); checkPending(); }
  }
  scheduleRefresh();
}

// My own request: when the grant arrives, remove the blinding, check the certificate, then claim the seat.
function checkPending() {
  const p = S.pending;
  if (!p || !S.net || S.quiet || S.members.has(S.pk)) return;
  if (!p.cert) {
    const signed = S.grants.get(p.reqId);
    if (!signed) return;
    let cert = ''; try { cert = unblindSeat(signed, p.r); } catch (e) { return; }
    if (!verifySeat(cert, S.net.era, subject(S.pk, p.name), S.net.seatKey)) return;
    p.cert = cert;
    // Claim at a minute mark plus a little noise, so claims from several people land together.
    // A mark less than 20 seconds away is skipped: a claim right after its grant would give the link away.
    const mark = Math.floor(now() / 60) + 1;
    p.due = S.fast ? 0 : (mark * 60 - now() < 20 ? mark + 1 : mark) * 60 + Math.floor(Math.random() * 15);
    store.set('fkn.pending.' + S.cfg.s, JSON.stringify(p));
  }
  if (!S.claimTimer) {
    S.claimTimer = setTimeout(() => {
      S.claimTimer = null;
      if (S.pending && S.pending.cert && !S.members.has(S.pk)) publishClaim(S.pending.name, S.pending.cert);
    }, Math.max(0, p.due * 1000 - Date.now()));
  }
  scheduleRefresh();
}

function publishClaim(name, cert) {
  const ev = finalizeEvent({ kind: K_SEAT, created_at: now(), tags: [['t', S.T]], content: JSON.stringify({ name, cert }) }, S.sk);
  S.seen.add(ev.id); S.claims.push(ev); drainClaims();
  S.pool.publish(ev);
}

function askForSeat(name) {
  const reqSk = generateSecretKey();
  const { blinded, r } = blindSeat(S.net.era, subject(S.pk, name));
  const ev = finalizeEvent({ kind: K_JOIN, created_at: now(), tags: [['t', S.T]], content: JSON.stringify({ blind: blinded }) }, reqSk);
  S.pending = { reqId: ev.id, code: codeOf(ev.pubkey), r, name };
  store.set('fkn.pending.' + S.cfg.s, JSON.stringify(S.pending));
  S.seen.add(ev.id);
  S.pool.publish(ev);
  scheduleRefresh();
}

// Host: sign the blinded point for a request. The host cannot tell which handle it will become.
function grantSeat(reqId) {
  const req = S.requests.get(reqId);
  if (!req) return;
  let signed = ''; try { signed = signBlinded(req.blind, S.seatSk); } catch (e) { S.ignored.add(reqId); scheduleRefresh(); return; }
  const ev = finalizeEvent({ kind: K_GRANT, created_at: now(), tags: [['t', S.T], ['e', reqId], ['p', req.pubkey]], content: JSON.stringify({ signed }) }, S.hostSk);
  S.seen.add(ev.id); S.grants.set(reqId, signed);
  S.pool.publish(ev);
  scheduleRefresh();
}

function publishNet(name) {
  const at = Math.max(now(), (S.net ? S.net.at : 0) + 1);
  const ev = finalizeEvent({ kind: K_NET, created_at: at, tags: [['d', 'fkn:net']], content: JSON.stringify({ name, seatKey: seatPublic(S.seatSk), era: 1 }) }, S.hostSk);
  store.set('fkn.net.' + S.cfg.s, JSON.stringify(ev));
  S.seen.add(ev.id); takeNet(ev);
  S.pool.publish(ev);
}

// An edition is one file of signed notes. Each note in it is checked like any other,
// so it does not matter where the file came from: the site, a mirror, or a messenger.
function loadEdition(j) {
  if (!j || !Array.isArray(j.events)) return 'That file is not an edition.';
  if (j.network && j.network !== S.cfg.s) return 'That edition belongs to another network.';
  const built = Date.parse(j.built);
  if (built && built > S.editionAt && built < Date.now() + 600000) { S.editionAt = built; S.edition = stamp(built); }
  j.events.slice(0, 20000).forEach(incoming);
  scheduleRefresh();
  return '';
}

function saveEdition() {
  const events = [S.net.ev, ...[...S.members.values()].map((m) => m.ev), ...S.byId.values()]
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const built = new Date();
  const blob = new Blob([JSON.stringify({ v: 1, network: S.cfg.s, built: built.toISOString(), count: events.length, events })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'edition-' + built.toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  return events.length;
}

// Ordinary notes from members.
function drain() {
  if (S.draining) return;
  S.draining = true;
  const step = () => {
    if (!S.net && Date.now() < S.netDeadline) { setTimeout(step, 150); return; }
    let n = 0;
    while (S.queue.length && n < 20) {
      const ev = S.queue.shift(); n += 1;
      if (!S.members.has(ev.pubkey)) {
        const held = S.limbo.get(ev.pubkey) || [];
        if (held.length < 200 && S.limbo.size < 500) { held.push(ev); S.limbo.set(ev.pubkey, held); }
        continue;
      }
      let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
      if (ok) take(ev);
    }
    if (n) scheduleRefresh();
    if (S.queue.length) setTimeout(step, 0); else S.draining = false;
  };
  step();
}

function take(ev) {
  if (S.byId.has(ev.id)) return;
  let body = null;
  if (!MEMBER_KINDS.includes(ev.kind)) return;
  if (ev.kind !== K_MSG && ev.kind !== K_VOTE) { try { body = JSON.parse(ev.content); } catch (e) { return; } if (!body || typeof body !== 'object') return; }
  if (ev.kind === K_ROOM) {
    const title = String(body.title || '').trim();
    if (!title || title.length > MAX.title) return;
    S.rooms.push({ id: ev.id, pubkey: ev.pubkey, at: ev.created_at, title, about: clip(String(body.about || '').trim(), MAX.about) });
  } else if (ev.kind === K_POST) {
    const title = String(body.title || '').trim(), text = String(body.body || '');
    if (!title || title.length > MAX.postTitle || !text.trim() || text.length > MAX.postBody) return;
    S.posts.push({ id: ev.id, pubkey: ev.pubkey, at: ev.created_at, title, body: text });
  } else if (ev.kind === K_MSG) {
    const root = tagVal(ev, 'e', 'root');
    if (!HEX64.test(root || '') || !ev.content.trim() || ev.content.length > MAX.msg) return;
    if (!S.byRoot.has(root)) S.byRoot.set(root, []);
    S.byRoot.get(root).push(ev);
  } else if (ev.kind === K_POLL) {
    const root = tagVal(ev, 'e', 'root'), q = String(body.q || '').trim();
    const options = Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (!HEX64.test(root || '') || !q || q.length > MAX.pollQ || options.length < 2 || options.length > 4 || options.some((o) => o.length > MAX.pollOpt)) return;
    S.polls.set(ev.id, { id: ev.id, pubkey: ev.pubkey, at: ev.created_at, root, q, options });
  } else if (ev.kind === K_VOTE) {
    const poll = tagVal(ev, 'e', 'poll'), i = Number(ev.content);
    if (!HEX64.test(poll || '') || !Number.isInteger(i) || i < 0 || i > 3) return;
    if (!S.votes.has(poll)) S.votes.set(poll, new Map());
    const prev = S.votes.get(poll).get(ev.pubkey);
    if (!prev || ev.created_at >= prev.at) S.votes.get(poll).set(ev.pubkey, { i, at: ev.created_at });
  }
  S.byId.set(ev.id, ev);
}

function sign(kind, tags, content) {
  const ev = finalizeEvent({ kind, created_at: now(), tags: [['t', S.T], ...tags], content }, S.sk);
  S.seen.add(ev.id);
  if (S.members.has(S.pk)) take(ev);
  S.pool.publish(ev);
  scheduleRefresh();
  return ev;
}

// ---------- routing ----------

const params = () => new URLSearchParams(location.hash.slice(1));

function hashFor(v, id) {
  const parts = [];
  if (!S.cfg.fromFile) parts.push('s=' + S.cfg.s);
  if (S.cfg.custom) parts.push('relays=' + S.cfg.relays.join(','));
  if (v && v !== 'rooms') parts.push('v=' + v);
  if (id) parts.push('id=' + id);
  return parts.join('&');
}
const inviteLink = () => location.origin + location.pathname + '#s=' + S.cfg.s + (S.cfg.custom ? '&relays=' + S.cfg.relays.join(',') : '');

function route() {
  const p = params(), v = p.get('v'), id = p.get('id');
  return { v: VIEWS.includes(v) ? v : 'rooms', id: HEX64.test(id || '') ? id : null };
}

function go(v, id) {
  const next = hashFor(v, id);
  if (location.hash.slice(1) === next) mount(); else location.hash = next;
}

// ---------- screens ----------

const app = document.getElementById('app');
const el = {};
const V = { refresh: null, key: null, k0: '' };

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if (!S.cfg) return;
    el.name.textContent = S.net ? S.net.name : 'FKN';
    document.title = el.name.textContent;
    const open = S.pool.open.size, total = S.pool.urls.length;
    el.status.textContent = S.quiet ? 'Quiet reading. ' + (S.edition ? 'Edition from ' + S.edition : 'No edition on this device yet')
      : open ? 'Connected to ' + open + ' of ' + total + ' hosts' : (S.edition ? 'No host reachable. Showing the edition from ' + S.edition : 'Connecting to hosts');
    if (V.key && V.key() !== V.k0) { mount(); return; }
    if (V.refresh) V.refresh();
  });
}

function buildShell() {
  app.textContent = '';
  el.name = h('h1', {}, 'FKN');
  el.status = h('p', { class: 'muted small', id: 'status' }, 'Connecting');
  el.view = h('div', { id: 'view' });
  const tab = (v, label) => h('button', { class: 'tab', id: 'tab-' + v, onclick: () => go(v) }, label);
  el.tabs = { rooms: tab('rooms', 'Rooms'), reading: tab('reading', 'Reading'), you: tab('you', 'You') };
  app.append(h('header', {}, el.name, el.status), el.view, h('nav', {}, el.tabs.rooms, el.tabs.reading, el.tabs.you));
}

function mount() {
  const r = route();
  el.view.textContent = '';
  S.reply = null;
  const group = { room: 'rooms', newroom: 'rooms', post: 'reading', write: 'reading' }[r.v] || r.v;
  for (const [k, b] of Object.entries(el.tabs)) { if (k === group) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  const made = ({ rooms: viewRooms, room: viewRoom, newroom: viewNewRoom, reading: viewReading, post: viewPost, write: viewWrite, you: viewYou }[r.v])(r.id) || {};
  V.refresh = made.refresh || null; V.key = made.key || null; V.k0 = V.key ? V.key() : '';
  if (V.refresh) V.refresh();
  window.scrollTo(0, 0);
}

const seatKey = () => (canSpeak() ? 'member' : 'reader');
const backTo = (v, label) => h('button', { class: 'back', id: 'back', onclick: () => go(v) }, '‹ ' + label);
const needSeat = () => (S.quiet
  ? h('div', { class: 'card pad', id: 'quietnote' }, h('p', {}, 'Quiet reading is on. Turn it off under You to speak.'))
  : h('div', { class: 'card pad' }, h('p', {}, 'You are reading. Take a seat to speak.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', id: 'toseat', onclick: () => go('you') }, 'Take a seat'))));

// --- threads: messages and polls under a room or a post ---

function fillThread(list, rootId) {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const msgs = (S.byRoot.get(rootId) || []).filter(visible).map((ev) => ({ at: ev.created_at, id: ev.id, ev }));
  const polls = [...S.polls.values()].filter((p) => p.root === rootId && visible(p)).map((p) => ({ at: p.at, id: p.id, poll: p }));
  // Same-second ties: a reply always sits below the message it answers.
  const parentOf = (x) => (x.ev ? tagVal(x.ev, 'e', 'reply') : null);
  const items = msgs.concat(polls).sort((a, b) => a.at - b.at || (parentOf(a) === b.id ? 1 : parentOf(b) === a.id ? -1 : (a.id < b.id ? -1 : 1))).slice(-300);
  list.textContent = '';
  if (!S.net) list.append(h('p', { class: 'muted empty' }, 'Looking for this network'));
  else if (!items.length) list.append(h('p', { class: 'muted empty' }, 'Nothing here yet. Say something worth reading.'));
  for (const it of items) list.append(it.poll ? pollCard(it.poll) : msgRow(it.ev));
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function msgRow(ev) {
  const own = ev.pubkey === S.pk;
  const row = h('div', { class: 'msg' + (own ? ' own' : '') }, h('p', { class: 'who' }, nameOf(ev.pubkey), h('span', { class: 'muted time' }, when(ev.created_at))));
  const parentId = tagVal(ev, 'e', 'reply'), parent = parentId ? S.byId.get(parentId) : null;
  if (parent && visible(parent)) row.append(h('p', { class: 'quote' }, nameOf(parent.pubkey) + ': ' + clip(parent.content, 90)));
  row.append(h('p', { class: 'text' }, ev.content));
  const acts = h('div', { class: 'acts' });
  if (canSpeak()) acts.append(h('button', { class: 'link reply', onclick: () => setReply(ev) }, 'Reply'));
  if (!own) acts.append(h('button', { class: 'link mute', onclick: () => { S.muted.add(ev.pubkey); saveSet('fkn.mute', S.muted); scheduleRefresh(); } }, 'Mute'));
  if (own && S.pool.outbox.has(ev.id)) {
    const held = (S.pool.acks.get(ev.id) || new Set()).size, why = S.pool.refused.get(ev.id);
    acts.append(h('span', { class: 'muted receipt' }, held ? 'Held by ' + held + ' of ' + S.pool.urls.length + ' hosts' : (why ? 'A host refused it: ' + why : 'Sending')));
  }
  row.append(acts);
  return row;
}

function pollCard(p) {
  const votes = S.votes.get(p.id) || new Map();
  const counts = p.options.map(() => 0); let total = 0;
  for (const [pk, v] of votes) { if (memberOf(pk) && v.i < p.options.length) { counts[v.i] += 1; total += 1; } }
  const mine = votes.get(S.pk);
  const card = h('div', { class: 'poll' }, h('p', { class: 'who' }, nameOf(p.pubkey), h('span', { class: 'muted time' }, 'asks · ' + when(p.at))), h('p', { class: 'text' }, p.q));
  p.options.forEach((opt, i) => {
    const label = opt + ' · ' + counts[i] + (mine && mine.i === i ? ' · your vote' : '');
    if (canSpeak()) card.append(h('button', { class: 'opt' + (mine && mine.i === i ? ' chosen' : ''), onclick: () => sign(K_VOTE, [['e', p.id, 'poll']], String(i)) }, label));
    else card.append(h('p', { class: 'opt static' }, label));
  });
  card.append(h('p', { class: 'muted small' }, total + (total === 1 ? ' person voted' : ' people voted') + '. One seat, one vote.'));
  return card;
}

function setReply(ev) {
  S.reply = ev;
  if (el.replyChip) {
    el.replyChip.textContent = '';
    el.replyChip.append('Replying to ' + nameOf(ev.pubkey) + ' ', h('button', { class: 'link', onclick: () => { S.reply = null; el.replyChip.textContent = ''; } }, 'Cancel'));
  }
  const box = document.getElementById('compose'); if (box) box.focus();
}

function composer(rootId, withPolls) {
  const input = h('textarea', { rows: '2', maxlength: String(MAX.msg), placeholder: 'Write a reply', 'aria-label': 'Write a reply', id: 'compose' });
  const err = h('p', { class: 'error small' });
  el.replyChip = h('p', { class: 'muted small', id: 'replychip' });
  const send = () => {
    const text = input.value.trim();
    if (!text) { err.textContent = 'Write something first.'; return; }
    if (Date.now() - S.lastSent < 2000) { err.textContent = 'One moment. Slow mode is on.'; return; }
    err.textContent = ''; S.lastSent = Date.now();
    const tags = [['e', rootId, 'root']];
    if (S.reply) tags.push(['e', S.reply.id, 'reply']);
    sign(K_MSG, tags, text);
    input.value = ''; S.reply = null; el.replyChip.textContent = '';
  };
  input.addEventListener('input', () => { err.textContent = ''; });
  const box = h('div', { class: 'card pad' }, h('p', { class: 'muted small' }, 'You are ', h('b', {}, nameOf(S.pk))), el.replyChip, input);
  const buttons = h('div', { class: 'row' }, h('button', { class: 'primary', id: 'send', onclick: send }, 'Send'));
  box.append(buttons, err);
  if (withPolls) {
    const form = h('div', { class: 'pollform', hidden: true });
    const q = h('input', { type: 'text', maxlength: String(MAX.pollQ), placeholder: 'Your question', 'aria-label': 'Poll question', id: 'pollq' });
    const opts = [0, 1, 2, 3].map((i) => h('input', { type: 'text', maxlength: String(MAX.pollOpt), placeholder: 'Option ' + (i + 1) + (i > 1 ? ' (optional)' : ''), 'aria-label': 'Option ' + (i + 1), class: 'pollopt' }));
    const perr = h('p', { class: 'error small' });
    const ask = () => {
      const question = q.value.trim(), options = opts.map((o) => o.value.trim()).filter(Boolean);
      if (!question) { perr.textContent = 'Write the question.'; return; }
      if (options.length < 2) { perr.textContent = 'Give at least two options.'; return; }
      sign(K_POLL, [['e', rootId, 'root']], JSON.stringify({ q: question, options }));
      q.value = ''; opts.forEach((o) => { o.value = ''; }); perr.textContent = ''; form.hidden = true;
    };
    form.append(h('label', { for: 'pollq' }, 'Ask the room'), q, ...opts, h('div', { class: 'row' }, h('button', { class: 'primary', id: 'askpoll', onclick: ask }, 'Start poll')), perr);
    buttons.append(h('button', { id: 'pollbtn', onclick: () => { form.hidden = !form.hidden; } }, 'Poll'));
    box.append(form);
  }
  return box;
}

// --- rooms ---

function viewRooms() {
  const list = h('div', { class: 'card', id: 'rooms' });
  el.view.append(h('div', { class: 'row between' }, h('h2', {}, 'Rooms'),
    canSpeak() ? h('button', { id: 'newroom', onclick: () => go('newroom') }, 'New room') : null), list);
  return {
    key: seatKey,
    refresh() {
      const rooms = S.rooms.filter(visible).map((r) => {
        const msgs = (S.byRoot.get(r.id) || []).filter(visible);
        const last = msgs.reduce((a, m) => Math.max(a, m.created_at), r.at);
        const seenAt = S.lastSeen[r.id] || 0;
        return { r, last, fresh: msgs.filter((m) => m.created_at > seenAt && m.pubkey !== S.pk).length };
      }).sort((a, b) => b.last - a.last);
      list.textContent = '';
      if (!S.net) list.append(h('p', { class: 'muted empty' }, S.quiet ? 'No edition on this device yet. Open one under You.' : S.pool.open.size ? 'Looking for this network' : 'Connecting'));
      else if (!rooms.length) list.append(h('p', { class: 'muted empty' }, 'No rooms yet.'));
      for (const { r, last, fresh } of rooms) {
        list.append(h('button', { class: 'item room', onclick: () => go('room', r.id) },
          h('span', { class: 'ititle' }, r.title),
          r.about ? h('span', { class: 'muted small' }, r.about) : null,
          h('span', { class: 'muted small' }, (fresh ? fresh + ' new · ' : '') + 'last ' + when(last))));
      }
    },
  };
}

function viewNewRoom() {
  if (!canSpeak()) { el.view.append(backTo('rooms', 'Rooms'), needSeat()); return { key: seatKey }; }
  const title = h('input', { type: 'text', maxlength: String(MAX.title), placeholder: 'Water supply', 'aria-label': 'Room name', id: 'roomtitle' });
  const about = h('input', { type: 'text', maxlength: String(MAX.about), placeholder: 'What is this room for?', 'aria-label': 'What is this room for', id: 'roomabout' });
  const err = h('p', { class: 'error small' });
  const create = () => {
    const t = title.value.trim();
    if (!t) { err.textContent = 'Give the room a name.'; return; }
    const ev = sign(K_ROOM, [], JSON.stringify({ title: t, about: about.value.trim() }));
    go('room', ev.id);
  };
  title.addEventListener('input', () => { err.textContent = ''; });
  el.view.append(backTo('rooms', 'Rooms'), h('div', { class: 'card pad' }, h('h2', {}, 'New room'),
    h('label', { for: 'roomtitle' }, 'Room name'), title, h('label', { for: 'roomabout' }, 'What is it for'), about,
    h('div', { class: 'row' }, h('button', { class: 'primary', id: 'createroom', onclick: create }, 'Open room')), err));
  return { key: seatKey };
}

function viewRoom(id) {
  const head = h('div', {}), list = h('div', { class: 'card thread', id: 'messages' });
  el.view.append(backTo('rooms', 'Rooms'), head, list, canSpeak() && id ? composer(id, true) : needSeat());
  return {
    key: seatKey,
    refresh() {
      const room = S.rooms.find((r) => r.id === id);
      head.textContent = '';
      head.append(h('h2', { id: 'roomname' }, room && visible(room) ? room.title : 'Room'), room && room.about ? h('p', { class: 'muted small' }, room.about) : null);
      if (!id) return;
      fillThread(list, id);
      // Remember the newest message shown, so the room list can count what came after it.
      const latest = (S.byRoot.get(id) || []).filter(visible).reduce((a, m) => Math.max(a, m.created_at), 0);
      if (latest > (S.lastSeen[id] || 0)) { S.lastSeen[id] = latest; store.set('fkn.seen.' + S.cfg.s, JSON.stringify(S.lastSeen)); }
    },
  };
}

// --- reading ---

function viewReading() {
  const list = h('div', { class: 'card', id: 'posts' });
  const all = h('button', { class: 'chip', id: 'f-all', onclick: () => { S.readFilter = 'all'; scheduleRefresh(); } }, 'All');
  const fol = h('button', { class: 'chip', id: 'f-following', onclick: () => { S.readFilter = 'following'; scheduleRefresh(); } }, 'Following');
  el.view.append(h('div', { class: 'row between' }, h('h2', {}, 'Reading'),
    canSpeak() ? h('button', { id: 'write', onclick: () => go('write') }, 'Write') : null), h('div', { class: 'row chips' }, all, fol), list);
  return {
    key: seatKey,
    refresh() {
      all.classList.toggle('on', S.readFilter === 'all'); fol.classList.toggle('on', S.readFilter === 'following');
      const posts = S.posts.filter(visible).filter((p) => S.readFilter === 'all' || S.follow.has(p.pubkey)).sort((a, b) => b.at - a.at).slice(0, 200);
      list.textContent = '';
      if (!posts.length) list.append(h('p', { class: 'muted empty' }, S.readFilter === 'following' ? 'Nothing from writers you follow yet.' : 'No posts yet.'));
      for (const p of posts) {
        list.append(h('button', { class: 'item post', onclick: () => go('post', p.id) },
          h('span', { class: 'ititle' }, p.title), h('span', { class: 'muted small' }, nameOf(p.pubkey) + ' · ' + when(p.at))));
      }
    },
  };
}

function viewWrite() {
  if (!canSpeak()) { el.view.append(backTo('reading', 'Reading'), needSeat()); return { key: seatKey }; }
  const title = h('input', { type: 'text', maxlength: String(MAX.postTitle), placeholder: 'Title', 'aria-label': 'Title', id: 'posttitle' });
  const body = h('textarea', { rows: '12', maxlength: String(MAX.postBody), placeholder: 'Write your piece', 'aria-label': 'Your piece', id: 'postbody' });
  const err = h('p', { class: 'error small' });
  const publish = () => {
    if (!title.value.trim()) { err.textContent = 'Give it a title.'; return; }
    if (!body.value.trim()) { err.textContent = 'Write something first.'; return; }
    const ev = sign(K_POST, [], JSON.stringify({ title: title.value.trim(), body: body.value }));
    go('post', ev.id);
  };
  [title, body].forEach((i) => i.addEventListener('input', () => { err.textContent = ''; }));
  el.view.append(backTo('reading', 'Reading'), h('div', { class: 'card pad' }, h('h2', {}, 'Write'), title, body,
    h('div', { class: 'row' }, h('button', { class: 'primary', id: 'publish', onclick: publish }, 'Publish')), err));
  return { key: seatKey };
}

function viewPost(id) {
  const head = h('div', { class: 'card pad', id: 'post' }), list = h('div', { class: 'card thread', id: 'messages' });
  el.view.append(backTo('reading', 'Reading'), head, h('h3', {}, 'Discussion'), list, canSpeak() && id ? composer(id, false) : needSeat());
  let drawn = '';
  return {
    key: seatKey,
    refresh() {
      const p = S.posts.find((x) => x.id === id);
      const state = p && visible(p) ? p.id + (S.follow.has(p.pubkey) ? 'f' : 'n') + nameOf(p.pubkey) : 'none';
      if (state !== drawn) {
        drawn = state; head.textContent = '';
        if (state === 'none') head.append(h('p', { class: 'muted' }, 'Looking for this post'));
        else {
          const following = S.follow.has(p.pubkey);
          head.append(h('h2', { id: 'posthead' }, p.title),
            h('div', { class: 'row between' }, h('p', { class: 'muted small' }, nameOf(p.pubkey) + ' · ' + when(p.at)),
              p.pubkey === S.pk ? null : h('button', { class: 'chip' + (following ? ' on' : ''), id: 'follow', onclick: () => {
                if (following) S.follow.delete(p.pubkey); else S.follow.add(p.pubkey);
                saveSet('fkn.follow', S.follow); scheduleRefresh();
              } }, following ? 'Following' : 'Follow')),
            h('p', { class: 'text body' }, p.body));
        }
      }
      if (id) fillThread(list, id);
    },
  };
}

// --- you ---

function viewYou() {
  const seatBox = h('div', { class: 'card pad', id: 'seat' });
  const listsBox = h('div', {});
  const hostBox = h('div', {});
  let seatDrawn = '';

  // backup words
  const wordsOut = h('p', { class: 'words', id: 'words', hidden: true });
  const showBtn = h('button', { id: 'showwords', onclick: () => {
    wordsOut.hidden = !wordsOut.hidden; wordsOut.textContent = wordsOut.hidden ? '' : S.words; showBtn.textContent = wordsOut.hidden ? 'Show my words' : 'Hide my words';
  } }, 'Show my words');
  const restoreIn = h('textarea', { rows: '2', placeholder: 'twelve words separated by spaces', 'aria-label': 'Backup words', id: 'restorewords', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' });
  const rerr = h('p', { class: 'error small' });
  let armed = false;
  const restoreBtn = h('button', { id: 'restore', onclick: () => {
    const w = restoreIn.value.trim().toLowerCase().split(/\s+/).join(' ');
    let good = false; try { good = validateWords(w); } catch (e) { good = false; }
    if (!good) { rerr.textContent = 'Those words are not a valid backup.'; armed = false; restoreBtn.textContent = 'Restore'; return; }
    if (!armed) { armed = true; restoreBtn.textContent = 'Replace the identity on this device'; rerr.textContent = 'This device will forget its current identity.'; return; }
    makeIdentity(w); location.reload();
  } }, 'Restore');
  restoreIn.addEventListener('input', () => { rerr.textContent = ''; armed = false; restoreBtn.textContent = 'Restore'; });
  const backup = h('div', { class: 'card pad' }, h('h2', {}, 'Your backup words'),
    h('p', { class: 'muted small' }, 'These twelve words are your identity. Write them on paper. Anyone who has them is you.'),
    h('div', { class: 'row' }, showBtn), wordsOut,
    h('label', { for: 'restorewords' }, 'Move an identity to this device'), restoreIn, h('div', { class: 'row' }, restoreBtn), rerr);

  // editions and quiet reading
  const emsg = h('p', { class: 'muted small', id: 'editionmsg' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', id: 'openedition', 'aria-label': 'Open an edition file' });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (f.size > 30000000) { emsg.textContent = 'That file is too large to be an edition.'; return; }
    f.text().then((t) => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } emsg.textContent = loadEdition(j) || 'Edition opened. Every note in it was checked.'; fileIn.value = ''; });
  });
  const saveBtn = h('button', { id: 'saveedition', onclick: () => {
    if (!S.net) { emsg.textContent = 'Nothing to save yet.'; return; }
    emsg.textContent = 'Saved ' + saveEdition() + ' notes. Send the file to anyone, by any app.';
  } }, 'Save an edition file');
  const quietBtn = h('button', { id: 'quiet', 'aria-pressed': S.quiet ? 'true' : 'false', onclick: () => { store.set('fkn.quiet', S.quiet ? '0' : '1'); location.reload(); } },
    S.quiet ? 'Turn quiet reading off' : 'Turn quiet reading on');
  const editions = h('div', { class: 'card pad', id: 'editions' }, h('h2', {}, 'Editions'),
    h('p', { class: 'muted small' }, 'An edition is one file holding this network\'s notes. It can travel by any messenger. Every note is checked when the file is opened, so it does not matter who passed it on.'),
    h('div', { class: 'row' }, saveBtn), h('label', { for: 'openedition' }, 'Open an edition file'), fileIn, emsg,
    h('h3', {}, 'Quiet reading'),
    h('p', { class: 'muted small' }, 'While it is on, this device contacts no host and reads from editions only, so no host sees its internet address. The site this page loads from still does. You cannot speak until you turn it off.'),
    h('div', { class: 'row' }, quietBtn));

  el.view.append(seatBox, hostBox, editions, backup, listsBox,
    h('p', { class: 'muted small note' }, 'Test build. Everything written here is public and permanent. To speak, your device contacts hosts, and they can see its internet address; use Tor Browser if that matters.'));

  return {
    refresh() {
      // seat
      const mine = memberOf(S.pk), p = S.pending;
      const key = mine ? 'm' + mine.name : S.quiet ? 'q' : p ? (p.cert ? 'g' : 'w') + p.code : 'r' + (S.net ? '1' : '0');
      if (key !== seatDrawn) {
        seatDrawn = key; seatBox.textContent = '';
        if (mine) seatBox.append(h('h2', {}, 'You are ', h('b', { id: 'myname' }, mine.name)), h('p', { class: 'muted small' }, 'You hold a seat. You can speak in every room, write, and vote.'));
        else if (S.quiet) seatBox.append(h('h2', {}, 'Reading quietly'), h('p', { class: 'muted small' }, 'Turn quiet reading off below to take a seat or speak.'));
        else if (p && p.cert) seatBox.append(h('h2', { id: 'granted' }, 'Seat granted'), h('p', { class: 'muted small' }, 'It switches on within two minutes. Keep this page open. The wait keeps the host from matching your request to your name.'));
        else if (p) seatBox.append(h('h2', {}, 'Waiting for the host'), h('p', { class: 'muted small' }, 'Tell the host this code, privately: ', h('b', { id: 'code' }, p.code), '. The host approves the code and never sees the name you picked.'),
          h('div', { class: 'row' }, h('button', { id: 'startover', onclick: () => { S.pending = null; store.set('fkn.pending.' + S.cfg.s, 'null'); scheduleRefresh(); } }, 'Start over')));
        else {
          const input = h('input', { type: 'text', maxlength: '20', placeholder: 'river-42', 'aria-label': 'Pick a name', id: 'name', autocapitalize: 'none', autocomplete: 'off' });
          const err = h('p', { class: 'error small' });
          const ask = () => {
            const name = input.value.trim().toLowerCase();
            if (!NAME_RE.test(name)) { err.textContent = 'Use 3 to 20 small letters, numbers or hyphens.'; return; }
            if (!S.net) { err.textContent = 'Still looking for this network. Try again in a moment.'; return; }
            askForSeat(name);
          };
          input.addEventListener('input', () => { err.textContent = ''; });
          seatBox.append(h('h2', {}, 'Take a seat'), h('p', { class: 'muted small' }, 'Reading is open to everyone. A seat lets you speak. One person, one seat.'),
            h('label', { for: 'name' }, 'Pick a name'), input, h('div', { class: 'row' }, h('button', { class: 'primary', id: 'ask', onclick: ask }, 'Ask for a seat')), err);
        }
      }
      // host
      hostBox.textContent = '';
      if (S.isHost) {
        const waiting = [...S.requests.entries()].filter(([id]) => !S.grants.has(id) && !S.ignored.has(id)).sort((a, b) => a[1].at - b[1].at);
        const link = inviteLink();
        const untaken = Math.max(0, S.grants.size - (S.members.size - 1));   // grants handed out but not yet claimed
        const linkBox = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invite link', id: 'link' });
        const copied = h('span', { class: 'muted small' });
        const box = h('div', { class: 'card pad', id: 'host' }, h('h2', {}, 'You host this network'),
          h('p', { class: 'muted small', id: 'seated' }, S.members.size + ' seated. ' + (untaken ? untaken + (untaken === 1 ? ' seat' : ' seats') + ' granted and not yet taken. ' : '') + 'Share this link:'), linkBox,
          h('div', { class: 'row' }, h('button', { onclick: () => {
            linkBox.select();
            try { navigator.clipboard.writeText(link).then(() => { copied.textContent = 'Copied'; }, () => { copied.textContent = 'Select and copy it by hand'; }); }
            catch (e) { copied.textContent = 'Select and copy it by hand'; }
          } }, 'Copy link'), copied),
          h('p', { class: 'muted small' }, 'Network key: ', h('span', { class: 'mono', id: 'netkey' }, S.cfg.s)));
        if (waiting.length) box.append(h('h3', {}, 'Asking for a seat'), h('p', { class: 'muted small' }, 'Seat only the codes people gave you privately. You will not see which name a code becomes.'));
        // A stranger can copy a code. If two requests show the same one, neither is safe to seat.
        const codes = new Map();
        for (const [, r] of waiting) codes.set(codeOf(r.pubkey), (codes.get(codeOf(r.pubkey)) || 0) + 1);
        for (const [id, r] of waiting.slice(0, 50)) {
          const code = codeOf(r.pubkey), clash = codes.get(code) > 1;
          box.append(h('div', { class: 'ask' }, h('p', {}, 'Code ', h('b', { class: 'reqcode' }, code), h('span', { class: 'muted' }, '  ' + when(r.at))),
            clash ? h('p', { class: 'error small clash' }, 'Two requests show this code. Seat neither. Ask the person to start over.') : null,
            h('div', { class: 'row' }, clash ? null : h('button', { class: 'primary approve', onclick: () => grantSeat(id) }, 'Seat them'),
              h('button', { class: 'ignore', onclick: () => { S.ignored.add(id); scheduleRefresh(); } }, 'Ignore'))));
        }
        hostBox.append(box);
      }
      // following and muted
      listsBox.textContent = '';
      const lists = [['Writers you follow', S.follow, 'fkn.follow', 'Unfollow'], ['People you muted', S.muted, 'fkn.mute', 'Unmute']];
      for (const [title, set, key2, verb] of lists) {
        if (!set.size) continue;
        const box = h('div', { class: 'card pad' }, h('h2', {}, title));
        for (const pk of set) {
          box.append(h('div', { class: 'row between' }, h('span', {}, nameOf(pk)),
            h('button', { class: 'link unlist', onclick: () => { set.delete(pk); saveSet(key2, set); scheduleRefresh(); } }, verb)));
        }
        listsBox.append(box);
      }
    },
  };
}

// --- first run: no network yet ---

function viewSetup(base) {
  app.textContent = '';
  const net = h('input', { type: 'text', maxlength: '40', value: 'FKN', 'aria-label': 'Network name', id: 'netname' });
  const name = h('input', { type: 'text', maxlength: '20', placeholder: 'river-42', 'aria-label': 'Your name here', id: 'hostname', autocapitalize: 'none', autocomplete: 'off' });
  const err = h('p', { class: 'error small' });
  const create = () => {
    const n = name.value.trim().toLowerCase();
    if (!net.value.trim()) { err.textContent = 'Give the network a name.'; return; }
    if (!NAME_RE.test(n)) { err.textContent = 'Your name: 3 to 20 small letters, numbers or hyphens.'; return; }
    const cfg = { s: S.hostPk, relays: base.relays, custom: base.custom, fromFile: false };
    start(cfg);
    location.hash = hashFor('you');
    publishNet(net.value.trim());
    publishClaim(n, signSeat(1, subject(S.pk, n), S.seatSk));   // the host's own seat, signed directly
  };
  [net, name].forEach((i) => i.addEventListener('input', () => { err.textContent = ''; }));
  app.append(h('header', {}, h('h1', {}, 'Start a network'),
    h('p', { class: 'muted' }, 'You become its host. You decide who gets a seat. Anyone with the link can read.')),
    h('div', { class: 'card pad' }, h('label', { for: 'netname' }, 'Network name'), net, h('label', { for: 'hostname' }, 'Your name here'), name,
      h('div', { class: 'row' }, h('button', { class: 'primary', id: 'create', onclick: create }, 'Create network')), err));
}

// ---------- start ----------

function start(cfg) {
  S.cfg = cfg;
  S.T = 'fkn' + cfg.s.slice(0, 16);
  S.isHost = S.hostPk === cfg.s;
  S.seatSk = S.isHost ? seatSecret(S.hostSk) : null;
  S.fast = params().get('fast') === '1';            // testing only: claim a granted seat at once
  S.quiet = store.get('fkn.quiet') === '1';
  S.certOk = new Set(store.json('fkn.certok.' + cfg.s, []));
  S.pending = store.json('fkn.pending.' + cfg.s, null);
  S.muted = new Set(store.json('fkn.mute.' + cfg.s, []));
  S.follow = new Set(store.json('fkn.follow.' + cfg.s, []));
  S.lastSeen = store.json('fkn.seen.' + cfg.s, {});
  S.netDeadline = Date.now() + 2500;
  buildShell();
  const filters = [
    { kinds: NOTE_KINDS, '#t': [S.T], limit: 2000 },
    { kinds: [K_NET], authors: [cfg.s], '#d': ['fkn:net'] },
  ];
  S.pool = new Pool(S.quiet ? [] : cfg.relays, filters, { event: incoming, status: scheduleRefresh });
  if (S.isHost) {
    // The host's browser keeps the network note and re-sends it to any relay that lost it.
    const saved = store.json('fkn.net.' + cfg.s, null);
    if (saved) { S.seen.add(saved.id); takeNet(saved); S.pool.publish(saved); }
  }
  // The latest edition: a static file of signed notes. Each note is checked like any other,
  // so the file needs no trust, and reading works even when no relay can be reached.
  fetch('./editions/latest.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j) loadEdition(j);
  }).catch(() => {});
  // A granted seat that was never claimed (tab closed in between) is claimed after a short look around.
  setTimeout(checkPending, 4000);
  mount();
  scheduleRefresh();
}

function relaysFrom(text) { return String(text || '').split(',').map((x) => x.trim()).filter((x) => /^wss?:\/\/\S+$/.test(x)); }

async function boot() {
  loadIdentity();
  const p = params();
  let s = p.get('s') || '', relays = relaysFrom(p.get('relays')), fromFile = false;
  const custom = relays.length > 0;
  if (!HEX64.test(s)) {
    try {
      const res = await fetch('./network.json', { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        if (j && HEX64.test(j.s || '')) { s = j.s; fromFile = true; if (!custom && Array.isArray(j.relays)) relays = relaysFrom(j.relays.join(',')); }
      }
    } catch (e) { /* no built-in network */ }
  }
  const base = { relays: relays.length ? relays : DEFAULT_RELAYS, custom };
  if (HEX64.test(s)) start({ s, relays: base.relays, custom, fromFile }); else viewSetup(base);
}

window.addEventListener('hashchange', () => {
  const s = params().get('s');
  if (!S.cfg || (s && s !== S.cfg.s)) { location.reload(); return; }
  mount();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
