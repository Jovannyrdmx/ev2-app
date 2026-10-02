'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const WEB = path.resolve(__dirname, '../../web');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');

describe('Shared UX dialogs and labels', () => {
  let dom;
  let w;
  beforeEach(() => {
    dom = new JSDOM('<body><main><button id="origin">Start</button><input id="email" placeholder="Correo"></main></body>',
      { url: 'https://ev2.local', runScripts: 'outside-only' });
    w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    w.EV2Format = { t: (key) => key };
    w.eval(read('js/ux.js'));
  });
  afterEach(() => dom.window.close());
  it('cancel is focused first and restores focus without approving', async () => {
    const origin = w.document.getElementById('origin');
    origin.focus();
    const result = w.EV2UX.confirm('Move money?');
    expect(w.document.activeElement.textContent).toBe('ux.cancel');
    w.document.activeElement.click();
    expect(await result).toBe(false);
    expect(w.document.activeElement).toBe(origin);
    expect(w.document.querySelector('dialog')).toBeNull();
  });
  it('Escape cancels input without confusing null with an empty value', async () => {
    const result = w.EV2UX.prompt('Reference', 'previous');
    w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel', { cancelable: true }));
    expect(await result).toBeNull();
  });
  it('accept returns the exact entered value and cannot execute HTML', async () => {
    const result = w.EV2UX.prompt('<img src=x onerror=alert(1)>', 'A');
    expect(w.document.querySelector('dialog img')).toBeNull();
    w.document.querySelector('dialog input').value = 'REF-42';
    w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    expect(await result).toBe('REF-42');
  });
  it('double activation never confirms a second action', async () => {
    const first = w.EV2UX.confirm('First');
    expect(await w.EV2UX.confirm('Second')).toBe(false);
    w.document.querySelector('dialog button').click();
    expect(await first).toBe(false);
  });
  it('persistent labels are associated with the field and never duplicated', () => {
    w.EV2UX.enhance(w.document);
    w.EV2UX.enhance(w.document);
    const input = w.document.getElementById('email');
    expect(input.labels.length).toBe(1);
    expect(input.labels[0].textContent).toBe('Correo');
  });
});

describe('Production assets and navigation', () => {
  it.each(['index', 'manager', 'staff', 'bartender', 'almacen', 'driver', 'valet', 'employee-portal'])(
    '%s uses local styles and shared UX', (page) => {
      const html = read(`${page}.html`);
      expect(html).not.toMatch(/cdn\.tailwindcss|fonts\.googleapis|cdnjs\.cloudflare/);
      expect(html).toContain('css/ux.css');
      expect(html).toContain('js/ux.js');
      expect(html).toContain('vendor/tailwind.css');
    });
  it('customer has five main tabs while secondary destinations remain reachable', () => {
    const dom = new JSDOM(read('index.html'));
    const doc = dom.window.document;
    expect([...doc.querySelectorAll('.ux-client-nav [data-view]')].map((b) => b.dataset.view))
      .toEqual(['home', 'menu', 'orders', 'show', 'profile']);
    for (const view of ['map', 'taxi', 'flirt']) {
      expect(doc.querySelector(`[data-ux-view="${view}"]`)).not.toBeNull();
    }
    expect(doc.getElementById('ux-table-list')).not.toBeNull();
    expect(doc.getElementById('ux-menu-search').labels.length).toBe(1);
    dom.window.close();
  });
  it('offline shell includes shared CSS, dialogs and locally hosted fonts', () => {
    const sw = read('sw.js');
    for (const file of ['css/ux.css', 'js/ux.js', 'vendor/tailwind.css', 'vendor/fonts.css']) {
      expect(sw).toContain(file);
      expect(fs.existsSync(path.join(WEB, file))).toBe(true);
    }
  });
});
