// FKN test build. One page is the whole app.
// - Identity is twelve words; every key is derived from them in the browser.
// - A network is a key. Its host signs the list of seated members.
// - Rooms, messages, polls and long posts are signed notes held by open relays.
// - Every browser shows only notes from seated members.
import { getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { generateSeedWords, validateWords, privateKeyFromSeedWords } from 'nostr-tools/nip06';

const K_MSG = 4270, K_JOIN = 4271, K_ROOM = 4272, K_POST = 4273, K_POLL = 4274, K_VOTE = 4275, K_ROSTER = 30078;
const NOTE_KINDS = [K_MSG, K_JOIN, K_ROOM, K_POST, K_POLL, K_VOTE];
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
  cfg: null, T: '', words: '', sk: null, pk: '', hostSk: null, hostPk: '', isHost: false, pool: null,
  roster: null, rosterDeadline: 0,
  seen: new Set(), queue: [], limbo: new Map(), draining: false, joinsChecked: 0,
  byId: new Map(), rooms: [], posts: [], byRoot: new Map(), polls: new Map(), votes: new Map(), joins: new Map(),
  ignored: new Set(), muted: new Set(), follow: new Set(), lastSeen: {},
  reply: null, lastSent: 0, readFilter: 'all',
};

const memberOf = (pk) => (S.roster ? S.roster.members[pk] : null);
const nameOf = (pk) => { const m = memberOf(pk); return m ? m.name : 'unknown'; };
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
  if (ev.kind === K_ROSTER) { S.seen.add(ev.id); takeRoster(ev); return; }
  if (!NOTE_KINDS.includes(ev.kind) || tagVal(ev, 't') !== S.T) return;
  S.seen.add(ev.id);
  S.queue.push(ev);
  drain();
}

function takeRoster(ev) {
  if (ev.pubkey !== S.cfg.s || tagVal(ev, 'd') !== 'fkn:roster') return;
  if (S.roster && !(ev.created_at > S.roster.at || (ev.created_at === S.roster.at && ev.id < S.roster.id))) return;
  let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
  if (!ok) return;
  let body; try { body = JSON.parse(ev.content); } catch (e) { return; }
  if (!body || typeof body.members !== 'object' || body.members === null) return;
  const members = {};
  for (const [pk, m] of Object.entries(body.members)) {
    if (HEX64.test(pk) && m && NAME_RE.test(m.name || '')) members[pk] = { name: m.name };
  }
  S.roster = { at: ev.created_at, id: ev.id, name: clip(String(body.name || 'FKN'), 40), members };
  // Notes that arrived before their author had a seat get a second look.
  for (const pk of Object.keys(members)) {
    const held = S.limbo.get(pk);
    if (held) { S.queue.push(...held); S.limbo.delete(pk); }
  }
  drain(); scheduleRefresh();
}

function drain() {
  if (S.draining) return;
  S.draining = true;
  const step = () => {
    if (!S.roster && Date.now() < S.rosterDeadline) { setTimeout(step, 150); return; }
    let n = 0;
    while (S.queue.length && n < 20) {
      const ev = S.queue.shift(); n += 1;
      if (ev.kind !== K_JOIN && !memberOf(ev.pubkey)) {
        const held = S.limbo.get(ev.pubkey) || [];
        if (held.length < 200 && S.limbo.size < 500) { held.push(ev); S.limbo.set(ev.pubkey, held); }
        continue;
      }
      if (ev.kind === K_JOIN) { S.joinsChecked += 1; if (S.joinsChecked > 400) continue; }
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
  if (ev.kind !== K_MSG && ev.kind !== K_VOTE) { try { body = JSON.parse(ev.content); } catch (e) { return; } if (!body || typeof body !== 'object') return; }
  if (ev.kind === K_JOIN) {
    if (!NAME_RE.test(body.name || '')) return;
    const prev = S.joins.get(ev.pubkey);
    if (!prev || ev.created_at >= prev.at) S.joins.set(ev.pubkey, { name: body.name, at: ev.created_at });
    return;
  }
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

function sign(kind, tags, content, sk) {
  const ev = finalizeEvent({ kind, created_at: now(), tags: [['t', S.T], ...tags], content }, sk || S.sk);
  S.seen.add(ev.id);
  if (kind === K_JOIN || memberOf(ev.pubkey)) take(ev);
  S.pool.publish(ev);
  scheduleRefresh();
  return ev;
}

function publishRoster(name, members) {
  const at = Math.max(now(), (S.roster ? S.roster.at : 0) + 1);
  const ev = finalizeEvent({ kind: K_ROSTER, created_at: at, tags: [['d', 'fkn:roster']], content: JSON.stringify({ name, members }) }, S.hostSk);
  store.set('fkn.roster.' + S.cfg.s, JSON.stringify(ev));
  S.seen.add(ev.id); takeRoster(ev);
  S.pool.publish(ev);
}

function seat(pubkey, wanted) {
  const members = Object.assign({}, S.roster ? S.roster.members : {});
  const taken = new Set(Object.values(members).map((m) => m.name));
  let name = wanted, n = 2;
  while (taken.has(name)) { name = wanted.slice(0, 16) + '-' + n; n += 1; }
  members[pubkey] = { name };
  publishRoster(S.roster ? S.roster.name : 'FKN', members);
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
    el.name.textContent = S.roster ? S.roster.name : 'FKN';
    document.title = el.name.textContent;
    const open = S.pool.open.size, total = S.pool.urls.length;
    el.status.textContent = open ? 'Connected to ' + open + ' of ' + total + ' hosts' : 'Connecting to hosts';
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

const seatKey = () => (memberOf(S.pk) ? 'member' : 'reader');
const backTo = (v, label) => h('button', { class: 'back', id: 'back', onclick: () => go(v) }, '‹ ' + label);
const needSeat = () => h('div', { class: 'card pad' }, h('p', {}, 'You are reading. Take a seat to speak.'),
  h('div', { class: 'row' }, h('button', { class: 'primary', id: 'toseat', onclick: () => go('you') }, 'Take a seat')));

// --- threads: messages and polls under a room or a post ---

function fillThread(list, rootId) {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const msgs = (S.byRoot.get(rootId) || []).filter(visible).map((ev) => ({ at: ev.created_at, id: ev.id, ev }));
  const polls = [...S.polls.values()].filter((p) => p.root === rootId && visible(p)).map((p) => ({ at: p.at, id: p.id, poll: p }));
  // Same-second ties: a reply always sits below the message it answers.
  const parentOf = (x) => (x.ev ? tagVal(x.ev, 'e', 'reply') : null);
  const items = msgs.concat(polls).sort((a, b) => a.at - b.at || (parentOf(a) === b.id ? 1 : parentOf(b) === a.id ? -1 : (a.id < b.id ? -1 : 1))).slice(-300);
  list.textContent = '';
  if (!S.roster) list.append(h('p', { class: 'muted empty' }, 'Looking for this network'));
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
  if (memberOf(S.pk)) acts.append(h('button', { class: 'link reply', onclick: () => setReply(ev) }, 'Reply'));
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
    if (memberOf(S.pk)) card.append(h('button', { class: 'opt' + (mine && mine.i === i ? ' chosen' : ''), onclick: () => sign(K_VOTE, [['e', p.id, 'poll']], String(i)) }, label));
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
    memberOf(S.pk) ? h('button', { id: 'newroom', onclick: () => go('newroom') }, 'New room') : null), list);
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
      if (!S.roster) list.append(h('p', { class: 'muted empty' }, S.pool.open.size ? 'Looking for this network' : 'Connecting'));
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
  if (!memberOf(S.pk)) { el.view.append(backTo('rooms', 'Rooms'), needSeat()); return { key: seatKey }; }
  const title = h('input', { type: 'text', maxlength: String(MAX.title), placeholder: 'Bengaluru water', 'aria-label': 'Room name', id: 'roomtitle' });
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
  el.view.append(backTo('rooms', 'Rooms'), head, list, memberOf(S.pk) && id ? composer(id, true) : needSeat());
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
    memberOf(S.pk) ? h('button', { id: 'write', onclick: () => go('write') }, 'Write') : null), h('div', { class: 'row chips' }, all, fol), list);
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
  if (!memberOf(S.pk)) { el.view.append(backTo('reading', 'Reading'), needSeat()); return { key: seatKey }; }
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
  el.view.append(backTo('reading', 'Reading'), head, h('h3', {}, 'Discussion'), list, memberOf(S.pk) && id ? composer(id, false) : needSeat());
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

  el.view.append(seatBox, hostBox, backup, listsBox,
    h('p', { class: 'muted small note' }, 'Test build. Everything written here is public and permanent. Hosts can see your internet address; use Tor Browser if that matters.'));

  return {
    refresh() {
      // seat
      const mine = memberOf(S.pk), asked = S.joins.get(S.pk);
      const key = mine ? 'm' + mine.name : asked ? 'w' + asked.name : 'r';
      if (key !== seatDrawn) {
        seatDrawn = key; seatBox.textContent = '';
        if (mine) seatBox.append(h('h2', {}, 'You are ', h('b', { id: 'myname' }, mine.name)), h('p', { class: 'muted small' }, 'You hold a seat. You can speak in every room, write, and vote.'));
        else if (asked) seatBox.append(h('h2', {}, 'Waiting for a seat'), h('p', { class: 'muted small' }, 'If the host asks, your name is ', h('b', {}, asked.name), ' and your code is ', h('b', { id: 'code' }, S.pk.slice(0, 6)), '.'));
        else {
          const input = h('input', { type: 'text', maxlength: '20', placeholder: 'river-42', 'aria-label': 'Pick a name', id: 'name', autocapitalize: 'none', autocomplete: 'off' });
          const err = h('p', { class: 'error small' });
          const ask = () => {
            const name = input.value.trim().toLowerCase();
            if (!NAME_RE.test(name)) { err.textContent = 'Use 3 to 20 small letters, numbers or hyphens.'; return; }
            sign(K_JOIN, [], JSON.stringify({ name }));
          };
          input.addEventListener('input', () => { err.textContent = ''; });
          seatBox.append(h('h2', {}, 'Take a seat'), h('p', { class: 'muted small' }, 'Reading is open to everyone. A seat lets you speak. One person, one seat.'),
            h('label', { for: 'name' }, 'Pick a name'), input, h('div', { class: 'row' }, h('button', { class: 'primary', id: 'ask', onclick: ask }, 'Ask for a seat')), err);
        }
      }
      // host
      hostBox.textContent = '';
      if (S.isHost) {
        const members = S.roster ? S.roster.members : {};
        const pending = [...S.joins.entries()].filter(([pk]) => !members[pk] && !S.ignored.has(pk)).sort((a, b) => a[1].at - b[1].at);
        const link = inviteLink();
        const linkBox = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invite link', id: 'link' });
        const copied = h('span', { class: 'muted small' });
        const box = h('div', { class: 'card pad', id: 'host' }, h('h2', {}, 'You host this network'),
          h('p', { class: 'muted small' }, Object.keys(members).length + ' seated. Share this link:'), linkBox,
          h('div', { class: 'row' }, h('button', { onclick: () => {
            linkBox.select();
            try { navigator.clipboard.writeText(link).then(() => { copied.textContent = 'Copied'; }, () => { copied.textContent = 'Select and copy it by hand'; }); }
            catch (e) { copied.textContent = 'Select and copy it by hand'; }
          } }, 'Copy link'), copied),
          h('p', { class: 'muted small' }, 'Network key: ', h('span', { class: 'mono', id: 'netkey' }, S.cfg.s)));
        if (pending.length) box.append(h('h3', {}, 'Asking for a seat'));
        for (const [pk, j] of pending) {
          box.append(h('div', { class: 'ask' }, h('p', {}, h('b', {}, j.name), h('span', { class: 'muted' }, '  code ' + pk.slice(0, 6))),
            h('div', { class: 'row' }, h('button', { class: 'primary approve', onclick: () => seat(pk, j.name) }, 'Seat them'),
              h('button', { onclick: () => { S.ignored.add(pk); scheduleRefresh(); } }, 'Ignore'))));
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
    publishRoster(net.value.trim(), { [S.pk]: { name: n } });
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
  S.muted = new Set(store.json('fkn.mute.' + cfg.s, []));
  S.follow = new Set(store.json('fkn.follow.' + cfg.s, []));
  S.lastSeen = store.json('fkn.seen.' + cfg.s, {});
  S.rosterDeadline = Date.now() + 2500;
  buildShell();
  const filters = [
    { kinds: NOTE_KINDS, '#t': [S.T], limit: 2000 },
    { kinds: [K_ROSTER], authors: [cfg.s], '#d': ['fkn:roster'] },
  ];
  S.pool = new Pool(cfg.relays, filters, { event: incoming, status: scheduleRefresh });
  if (S.isHost) {
    // The host's browser keeps the member list and re-sends it to any relay that lost it.
    const saved = store.json('fkn.roster.' + cfg.s, null);
    if (saved) { S.seen.add(saved.id); takeRoster(saved); S.pool.publish(saved); }
  }
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
