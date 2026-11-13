// Builds editions/latest.json: the network's signed notes as one static file.
//
// The file needs no trust. Every note in it carries its author's signature and every
// member carries a seat certificate, and the app checks both again when it reads the file.
// Anyone can mirror the file anywhere; the app can read from it when no relay is reachable.
//
// Usage: node scripts/edition.mjs [network.json] [editions/latest.json]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { verifySeat } from '../src/seat.js';

const K_SEAT = 4277, K_NET = 30078;
const MEMBER_KINDS = [4270, 4272, 4273, 4274, 4275];   // messages, rooms, posts, polls, votes
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const MAX_NOTES = 5000, WAIT_MS = 20000;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;

const netFile = process.argv[2] || 'network.json';
const outFile = process.argv[3] || 'editions/latest.json';
if (!existsSync(netFile)) { console.log('No ' + netFile + ' yet, so there is no network to collect. Nothing to do.'); process.exit(0); }

const cfg = JSON.parse(readFileSync(netFile, 'utf8'));
if (!HEX64.test(cfg.s || '')) { console.error(netFile + ' has no valid network key "s".'); process.exit(1); }
const relays = Array.isArray(cfg.relays) && cfg.relays.length ? cfg.relays : DEFAULT_RELAYS;
const tag = 'fkn' + cfg.s.slice(0, 16);
const tagOf = (ev, name) => { const t = (ev.tags || []).find((x) => Array.isArray(x) && x[0] === name); return t ? t[1] : null; };

const found = new Map();
function consider(ev) {
  if (!ev || typeof ev.id !== 'string' || found.has(ev.id) || typeof ev.content !== 'string' || ev.content.length > 30000) return;
  const isNet = ev.kind === K_NET && ev.pubkey === cfg.s && tagOf(ev, 'd') === 'fkn:net';
  const isNote = (ev.kind === K_SEAT || MEMBER_KINDS.includes(ev.kind)) && tagOf(ev, 't') === tag;
  if (!isNet && !isNote) return;
  let ok = false; try { ok = verifyEvent(ev); } catch (e) { ok = false; }
  if (ok) found.set(ev.id, ev);
}

// Start from the previous edition, so a note that relays later drop is not lost.
let previous = [];
if (existsSync(outFile)) { try { previous = JSON.parse(readFileSync(outFile, 'utf8')).events || []; } catch (e) { previous = []; } }
previous.forEach(consider);

const WS = globalThis.WebSocket || (await import('ws')).default;
function collect(url) {
  return new Promise((resolve) => {
    let ws; let done = false;
    const finish = (why) => { if (done) return; done = true; console.log(url + ': ' + why); try { ws.close(); } catch (e) { /* closed */ } resolve(); };
    try { ws = new WS(url); } catch (e) { finish('could not connect'); return; }
    const timer = setTimeout(() => finish('timed out'), WAIT_MS);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'edition',
      { kinds: [K_SEAT, ...MEMBER_KINDS], '#t': [tag], limit: 5000 },
      { kinds: [K_NET], authors: [cfg.s], '#d': ['fkn:net'] }]));
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch (e) { return; }
      if (d[0] === 'EVENT' && d[2]) consider(d[2]);
      else if (d[0] === 'EOSE') { clearTimeout(timer); finish('done'); }
    };
    ws.onerror = () => { clearTimeout(timer); finish('unreachable'); };
    ws.onclose = () => { clearTimeout(timer); finish('closed'); };
  });
}
await Promise.all(relays.map(collect));

// Keep the newest network note, every valid seat, and the newest notes written by seated members.
const all = [...found.values()];
const net = all.filter((e) => e.kind === K_NET).sort((a, b) => b.created_at - a.created_at)[0];
if (!net) { console.log('The network note was not found on any relay. Nothing written.'); process.exit(0); }
let body = {}; try { body = JSON.parse(net.content); } catch (e) { body = {}; }
const era = Number.isInteger(body.era) && body.era > 0 ? body.era : 1;
const seats = all.filter((e) => e.kind === K_SEAT).filter((e) => {
  try { const c = JSON.parse(e.content); return NAME_RE.test(c.name || '') && verifySeat(c.cert, era, e.pubkey + '|' + c.name, body.seatKey); } catch (err) { return false; }
});
const members = new Set(seats.map((e) => e.pubkey));
const notes = all.filter((e) => MEMBER_KINDS.includes(e.kind) && members.has(e.pubkey))
  .sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES);
const events = [net, ...seats, ...notes].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));

const before = new Set(previous.map((e) => e.id));
const same = events.length === before.size && events.every((e) => before.has(e.id));
if (same) { console.log('No new notes. Edition unchanged (' + events.length + ' notes).'); process.exit(0); }
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ v: 1, network: cfg.s, built: new Date().toISOString(), count: events.length, events }));
console.log('Edition written: ' + events.length + ' notes, ' + members.size + ' members.');
process.exit(0);
