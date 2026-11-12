// A tiny in-memory Nostr-style relay, for local testing only.
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] || 7447);
const events = new Map();
const subs = new Map(); // ws -> Map(subId, filters)

const match = (ev, f) => {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (k[0] !== '#') continue;
    if (!ev.tags.some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) return false;
  }
  return true;
};

const wss = new WebSocketServer({ port });
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d[0] === 'REQ') {
      const [, id, ...filters] = d;
      subs.get(ws).set(id, filters);
      for (const ev of events.values()) if (filters.some((f) => match(ev, f))) ws.send(JSON.stringify(['EVENT', id, ev]));
      ws.send(JSON.stringify(['EOSE', id]));
    } else if (d[0] === 'EVENT') {
      const ev = d[1];
      events.set(ev.id, ev);
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [peer, m] of subs) for (const [id, filters] of m) {
        if (filters.some((f) => match(ev, f))) peer.send(JSON.stringify(['EVENT', id, ev]));
      }
    }
  });
  ws.on('close', () => subs.delete(ws));
});
console.log('relay on', port);
