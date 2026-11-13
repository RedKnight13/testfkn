// Publishes two seat requests that show the same code, as a stranger copying someone's code would.
import WebSocket from 'ws';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';

const [netTag, url] = process.argv.slice(2);
const sk = generateSecretKey();
const at = Math.floor(Date.now() / 1000);
const blind = (c) => c.repeat(96);
const notes = ['a', 'b'].map((c) => finalizeEvent({ kind: 4271, created_at: at, tags: [['t', netTag]], content: JSON.stringify({ blind: blind(c) }) }, sk));
const ws = new WebSocket(url);
let acks = 0;
ws.on('open', () => notes.forEach((n) => ws.send(JSON.stringify(['EVENT', n]))));
ws.on('message', () => { acks += 1; if (acks >= notes.length) { console.log(notes[0].pubkey); ws.close(); process.exit(0); } });
