// Prints every note the relay holds for a network tag, as JSON. Used by the test to inspect what is public.
import WebSocket from 'ws';

const [netTag, url] = process.argv.slice(2);
const out = [];
const ws = new WebSocket(url);
ws.on('open', () => ws.send(JSON.stringify(['REQ', 'dump', { '#t': [netTag] }])));
ws.on('message', (raw) => {
  const d = JSON.parse(raw);
  if (d[0] === 'EVENT') out.push(d[2]);
  else if (d[0] === 'EOSE') { console.log(JSON.stringify(out)); ws.close(); process.exit(0); }
});
