# testfkn

FKN test build. One static page, no server of our own.

Everything written through this build is public and permanent. It is for testing only.

## What it does

- **Identity is twelve words.** Every key is made from them in the browser. Nothing is registered anywhere.
- **Blind seats.** To speak you need a seat. You ask, the page shows a short code, you give the code to the
  host privately. The host approves the code. The host signs your request without being able to see which
  name and handle it becomes, so the member list cannot be matched to the people who asked.
  A name is locked into its seat for as long as the network key lasts.
- **Rooms, replies, polls, long posts.** All of them are signed notes held by open relays. Every browser
  shows only notes from seated members. One seat, one vote.
- **Editions.** An edition is one file with the network's notes in it. The page reads `editions/latest.json`
  from wherever it is served, and anyone seated can save an edition file and pass it on by any messenger.
  Every note is checked when the file is opened, so the file needs no trust.
- **Quiet reading.** A switch under *You*. While it is on, the device contacts no relay and reads from
  editions only.
- **Offline copy.** After the first visit the page and the last edition open with no connection.

## What it does not do yet

- **Proof of a real ID.** Today the host decides who gets a seat. A zero-knowledge ID proof would take the
  host's place at exactly that step. It is not built.
- **Hiding the device's address while speaking.** Relays see the internet address of a device that posts.
  Tor Browser hides it. Nothing in this build does.
- **More than one host.** One key grants seats. If it is lost, no new seats can be granted.

## Known limits

- The host cannot see which name a code became, but if only one person is seated at a time the host can
  guess from timing. Seat people in groups.
- A relay sees both the request and the later claim from the same address and can link them.
- A granted seat is claimed at a minute mark, up to about a minute and a half later. The page must stay open.
- Writing style, an unlocked phone and screenshots give people away. No software fixes those.

## Files

- `index.html` and `sw.js` are the built app. GitHub Pages serves them from this branch.
- `src/` holds the source: `app.js` (the app), `seat.js` (blind seat signatures), `template.html`, `sw.js`.
- `scripts/edition.mjs` collects the network's notes from relays into `editions/latest.json`.
  It needs `network.json` next to `index.html`: `{ "s": "<network key>" }`. With that file in place the
  plain address also opens the network, without a key in the link.
- `npm install`, then `npm run build` rebuilds the two files.
- `npm test` runs the whole flow in a headless browser against a small local relay
  (needs Python with Playwright and a Chrome install). `node test/seat-test.mjs` checks the signatures.
