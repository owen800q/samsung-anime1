# DPlayer

DPlayer 1.27.1, MIT licensed. The bundled distribution is copied without changes from
https://github.com/DIYgod/DPlayer at bc43cc0ac2470f3b3552414a81e64b913b107bb3.
The build itself identifies v1.27.1-3-gb0ba40b. See DPlayer-LICENSE.

The two embedded stylesheets are allowed by exact SHA-256 hashes in src/_headers;
tests/player.test.mjs verifies those hashes. No third-party CDN is required.
The app keeps its existing multi-source canvas renderer inside the DPlayer container.
src/player.js replaces the upstream fullscreen methods so iOS or rejected browser
fullscreen requests use web fullscreen instead of losing the sibling canvas.
