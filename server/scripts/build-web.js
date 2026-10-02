'use strict';
// Reproducible local assets. Production serves the checked-in output, without a CDN.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const vendor = path.join(root, 'web/vendor');
fs.mkdirSync(vendor, { recursive: true });
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'web/js/venue-3d.js')],
  bundle: true, format: 'iife', globalName: 'EV2Venue3D',
  outfile: path.join(vendor, 'venue-3d.js'), minify: true, target: ['es2020'],
  nodePaths: [path.join(root, 'server/node_modules')],
});
fs.copyFileSync(path.resolve(path.dirname(require.resolve('three')), '../LICENSE'),
  path.join(vendor, 'three-LICENSE.txt'));
execFileSync(process.execPath, [
  require.resolve('tailwindcss/lib/cli.js'),
  '-c', path.join(root, 'server/tailwind.config.js'),
  '-i', path.join(root, 'web/css/utilities.css'),
  '-o', path.join(vendor, 'tailwind.css'), '--minify',
], { stdio: 'inherit' });
const fa = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
fs.mkdirSync(path.join(vendor, 'fontawesome/css'), { recursive: true });
fs.mkdirSync(path.join(vendor, 'fontawesome/webfonts'), { recursive: true });
fs.copyFileSync(path.join(fa, 'css/all.min.css'), path.join(vendor, 'fontawesome/css/all.min.css'));
for (const file of fs.readdirSync(path.join(fa, 'webfonts'))) {
  if (file.endsWith('.woff2')) fs.copyFileSync(path.join(fa, 'webfonts', file), path.join(vendor, 'fontawesome/webfonts', file));
}
fs.copyFileSync(path.join(fa, 'LICENSE.txt'), path.join(vendor, 'fontawesome/LICENSE.txt'));
fs.mkdirSync(path.join(vendor, 'fonts'), { recursive: true });
let css = '';
for (const [family, weights] of [['inter', [300, 400, 500, 600, 700]], ['poppins', [500, 600, 700]]]) {
  const font = path.dirname(require.resolve(`@fontsource/${family}/package.json`));
  for (const weight of weights) {
    const name = `${family}-latin-${weight}-normal.woff2`;
    fs.copyFileSync(path.join(font, 'files', name), path.join(vendor, 'fonts', name));
    css += `@font-face{font-family:'${family === 'inter' ? 'Inter' : 'Poppins'}';font-style:normal;font-weight:${weight};font-display:swap;src:url('./fonts/${name}') format('woff2')}\n`;
  }
  fs.copyFileSync(path.join(font, 'LICENSE'), path.join(vendor, 'fonts', `${family}-LICENSE.txt`));
}
fs.writeFileSync(path.join(vendor, 'fonts.css'), css);
console.log('EV2 web assets built locally.');
