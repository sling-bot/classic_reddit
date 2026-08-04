hls.js v1.6.16
https://github.com/video-dev/hls.js
Licensed under Apache-2.0 - see LICENSE-hls.txt

Bundled because Chrome and Firefox cannot play HLS natively, and Reddit
serves v.redd.it video only as an HLS manifest. Safari plays HLS directly
and skips this library entirely.

This is dist/hls.min.js, unmodified, from the npm package `hls.js`.
Unminified source: https://github.com/video-dev/hls.js/releases/tag/v1.6.16
(Firefox add-on review requires you to point at original sources for any
minified library you ship.)

To shrink the extension later, dist/hls.light.min.js is 346KB instead of
530KB and drops subtitle/DRM support. Same API - a drop-in swap.
