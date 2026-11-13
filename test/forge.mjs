// Sends validly signed notes from a key that has no seat. Every page must ignore them.
// Given a member's certificate and name, it also tries to take a seat with them.
import WebSocket from 'ws';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';

const [netTag, roomId, url, stolenCert, stolenName] = process.argv.slice(2);
const sk = generateSecretKey();
const at = Math.floor(Date.now() / 1000);
const t = ['t', netTag];
const garbage = Array.from({ length: 96 }, (_, i) => '0123456789abcdef'[(i * 7) % 16]).join('');
const notes = [
  finalizeEvent({ kind: 4277, created_at: at, tags: [t], content: JSON.stringify({ name: 'intruder', cert: garbage }) }, sk),
  finalizeEvent({ kind: 4270, created_at: at, tags: [t, ['e', roomId, 'root']], content: 'FORGED-MESSAGE' }, sk),
  finalizeEvent({ kind: 4273, created_at: at, tags: [t], content: JSON.stringify({ title: 'FORGED-POST', body: 'x' }) }, sk),
  finalizeEvent({ kind: 4272, created_at: at, tags: [t], content: JSON.stringify({ title: 'FORGED-ROOM' }) }, sk),
];
if (stolenCert) notes.unshift(finalizeEvent({ kind: 4277, created_at: at, tags: [t], content: JSON.stringify({ name: stolenName || 'thief', cert: stolenCert }) }, sk));
const ws = new WebSocket(url);
let acks = 0;
ws.on('open', () => notes.forEach((n) => ws.send(JSON.stringify(['EVENT', n]))));
ws.on('message', () => { acks += 1; if (acks >= notes.length) { ws.close(); process.exit(0); } });
