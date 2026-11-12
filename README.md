# testfkn

FKN test build. One static page, no server.

- `index.html` and `sw.js` are the built app. GitHub Pages serves them from this branch.
- `src/` holds the source. `npm install`, then `npm run build` rebuilds the two files.
- `npm test` runs the full flow in a headless browser against a small local relay
  (needs Python with Playwright and a Chrome install).

Everything written through this build is public and permanent. It is for testing only.
