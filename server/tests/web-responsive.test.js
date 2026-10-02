'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const WEB = path.resolve(__dirname, '../../web');
const read = file => fs.readFileSync(path.join(WEB, file), 'utf8');

describe('Responsive layout invariants', () => {
  test.each(['index', 'manager', 'staff', 'bartender', 'almacen', 'valet',
    'driver', 'employee-portal', 'pase', 'verificar'])('%s permits device width and user zoom', page => {
    const dom = new JSDOM(read(`${page}.html`));
    const viewport = dom.window.document.querySelector('meta[name="viewport"]').content;
    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1(?:,|$)/);
    dom.window.close();
  });

  test('generated labels preserve all existing grid placement without duplicates', () => {
    const dom = new JSDOM('<body><main><div class="grid"><input id="name" placeholder="Nombre" class="field col-span-3 md:col-span-2"><input id="price" placeholder="Precio" class="field col-span-2"></div></main></body>',
      { url: 'https://ev2.local', runScripts: 'outside-only' });
    const w = dom.window;
    w.eval(read('js/ux.js'));
    w.EV2UX.enhance(w.document);
    w.EV2UX.enhance(w.document);
    const input = w.document.getElementById('name');
    expect(input.parentElement.classList.contains('col-span-3')).toBe(true);
    expect(input.parentElement.classList.contains('md:col-span-2')).toBe(true);
    expect(input.classList.contains('col-span-3')).toBe(false);
    expect(input.labels.length).toBe(1);
    expect(w.document.getElementById('price').parentElement.classList.contains('col-span-2')).toBe(true);
    dom.window.close();
  });

  test('sticky tabs measure their own header, including resized text', async () => {
    const dom = new JSDOM('<body><section id="screen-example"><header class="sticky">Name</header><nav class="sticky">Tabs</nav></section></body>',
      { url: 'https://ev2.local', runScripts: 'outside-only' });
    const w = dom.window;
    const header = w.document.querySelector('header');
    let height = 112;
    header.getClientRects = () => [{}];
    header.getBoundingClientRect = () => ({ height });
    let resize;
    w.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe() {}
    };
    w.eval(read('js/ux.js'));
    await new Promise(resolve => w.document.addEventListener('DOMContentLoaded', resolve));
    const screen = w.document.querySelector('section');
    expect(screen.style.getPropertyValue('--ux-header-height')).toBe('112px');
    height = 160;
    resize();
    expect(screen.style.getPropertyValue('--ux-header-height')).toBe('160px');
    dom.window.close();
  });

  test('shared CSS handles short viewports without disabling page overflow', () => {
    const css = read('css/ux.css');
    expect(css).toContain('@media(max-height:500px)');
    expect(css).toContain('var(--ux-header-height,72px)');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).not.toMatch(/(?:html|body)\s*\{[^}]*overflow(?:-x)?:\s*hidden/);
    expect(css).toContain('body > .min-h-screen');
    expect(css).not.toContain('body > div:first-of-type');
  });
});
