/**
 * js/ui.js — the app's own confirm/prompt/toast (D72).
 *
 * The browser's confirm() froze the page and, on the bar's touch PC, showed a tiny OK
 * in the middle of the screen. These tests pin what replaced it: the answer arrives as
 * a promise, Escape and the backdrop say "no", and a dangerous question never starts
 * with the dangerous button focused.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'ui.js'), 'utf8');

function app(lang) {
  const dom = new JSDOM(`<!doctype html><html lang="${lang || 'es'}"><body><button id="before">x</button></body></html>`,
    { runScripts: 'outside-only' });
  dom.window.eval(SRC);
  return { w: dom.window, d: dom.window.document, UI: dom.window.EV2UI };
}
const buttons = (d) => [...d.querySelectorAll('.ev2-dialog-actions button')];

describe('EV2UI.confirm', () => {
  it('confirmar resuelve true y quita el cuadro', async () => {
    const { d, UI } = app();
    const answer = UI.confirm('¿Cancelar la noche?');
    await Promise.resolve();
    expect(d.querySelector('.ev2-dialog p').textContent).toBe('¿Cancelar la noche?');
    buttons(d)[1].click();
    await expect(answer).resolves.toBe(true);
    expect(d.querySelector('.ev2-overlay')).toBeNull();
  });

  it('Escape y el fondo dicen que no', async () => {
    const { w, d, UI } = app();
    const a = UI.confirm('uno');
    await Promise.resolve();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(a).resolves.toBe(false);

    const b = UI.confirm('dos');
    await new Promise((r) => setTimeout(r, 0));
    const overlay = d.querySelector('.ev2-overlay');
    overlay.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await expect(b).resolves.toBe(false);
  });

  it('una pregunta peligrosa empieza con el foco en Cancelar', async () => {
    const { d, UI } = app();
    UI.confirm('¿Desactivar a esta persona?', { danger: true });
    await Promise.resolve();
    const [no, yes] = buttons(d);
    expect(d.activeElement).toBe(no);
    expect(yes.className).toContain('btn-danger');
    expect(d.querySelector('.ev2-dialog').getAttribute('role')).toBe('alertdialog');
  });

  it('dos preguntas seguidas no se enciman: la segunda espera', async () => {
    const { d, UI } = app();
    const a = UI.confirm('primera');
    const b = UI.confirm('segunda');
    await Promise.resolve();
    expect(d.querySelectorAll('.ev2-overlay')).toHaveLength(1);
    buttons(d)[0].click();
    await expect(a).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.querySelector('.ev2-dialog p').textContent).toBe('segunda');
    buttons(d)[1].click();
    await expect(b).resolves.toBe(true);
  });

  it('los botones hablan el idioma de la página', async () => {
    const { d, UI } = app('en');
    UI.confirm('Sure?');
    await Promise.resolve();
    expect(buttons(d).map((b) => b.textContent)).toEqual(['Cancel', 'Confirm']);
  });
});

describe('EV2UI.prompt', () => {
  it('devuelve lo escrito, o null si se cancela', async () => {
    const { d, UI } = app();
    const a = UI.prompt('Referencia', { value: 'SPEI-1' });
    await Promise.resolve();
    const input = d.querySelector('.ev2-dialog input');
    expect(input.value).toBe('SPEI-1');
    input.value = 'SPEI-99';
    buttons(d)[1].click();
    await expect(a).resolves.toBe('SPEI-99');

    const b = UI.prompt('Motivo');
    await new Promise((r) => setTimeout(r, 0));
    buttons(d)[0].click();
    await expect(b).resolves.toBeNull();
  });
});

describe('EV2UI.toast', () => {
  it('ofrece deshacer y lo ejecuta una sola vez', () => {
    const { d, UI } = app();
    let undone = 0;
    UI.toast('Pedido marcado listo', { action: 'Deshacer', onAction: () => { undone += 1; } });
    const b = d.querySelector('.ev2-toast button');
    expect(b.textContent).toBe('Deshacer');
    b.click();
    expect(undone).toBe(1);
    expect(d.querySelector('.ev2-toast')).toBeNull();
    expect(d.querySelector('.ev2-toasts').getAttribute('aria-live')).toBe('polite');
  });
});

describe('Cerrar sesión lleva al inicio, no al login del rol', () => {
  const fs = require('fs');
  const path = require('path');
  const pantallas = ['bartender', 'cashier', 'driver', 'employee', 'index', 'manager', 'staff',
    'valet', 'warehouse'];
  for (const p of pantallas) {
    it(`${p}-screen.js`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', `${p}-screen.js`), 'utf8');
      const salir = src.slice(src.indexOf('function signOut'), src.indexOf('function signOut') + 400);
      expect(salir).toMatch(/location\.replace\('index\.html'\)/);
      expect(salir).not.toMatch(/location\.reload\(\)/);
    });
  }
});
