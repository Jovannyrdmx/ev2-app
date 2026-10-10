/**
 * EV2 — the 3D floor plan bundle (venue-3d).
 *
 * `js/venue-3d.js` imports three.js. The browser loads plain files with no build step,
 * so the module and the part of three.js it uses are bundled once into
 * `vendor/venue-3d.js` (one IIFE exposing `EV2Venue3D`), which is committed and served
 * from our own origin like the rest of the assets (D71). `js/venue-layout.js` loads it
 * only when a screen opens the 3D view.
 *
 * Run through `npm run build:3d`. The output is committed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const WEB = path.join(__dirname, '..');
const vendor = path.join(WEB, 'vendor');
fs.mkdirSync(vendor, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(WEB, 'js', 'venue-3d.js')],
  bundle: true,
  format: 'iife',
  globalName: 'EV2Venue3D',
  outfile: path.join(vendor, 'venue-3d.js'),
  minify: true,
  target: ['es2020'],
  nodePaths: [path.join(WEB, 'node_modules')],
});

// three.js is MIT: its licence travels with the bundle.
fs.copyFileSync(path.resolve(path.dirname(require.resolve('three')), '..', 'LICENSE'),
  path.join(vendor, 'three-LICENSE.txt'));

console.log('venue-3d bundle built');
