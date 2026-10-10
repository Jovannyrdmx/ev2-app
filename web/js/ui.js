/**
 * EV2 — shared UI pieces every screen can use (D72).
 *
 * `confirm()` from the browser stops the whole page, cannot be styled, looks broken in
 * an iPhone home-screen app and, on the bar's touch PC, shows a tiny OK button in the
 * middle of the screen. This file replaces it with a dialog that matches the app:
 * big buttons at thumb height on a phone, centered on a wide screen, Escape and the
 * backdrop cancel, and the dangerous choice is never the default focus.
 *
 *   EV2UI.confirm(text, { title, ok, cancel, danger })  -> Promise<boolean>
 *   EV2UI.prompt(text, { value, ok, cancel, inputmode })  -> Promise<string|null>
 *   EV2UI.toast(text, { kind: 'ok'|'bad', action, onAction, ms })
 *
 * Screens call it through a one-line `ask()` that falls back to `window.confirm` when
 * this file is not loaded (unit tests evaluate a single screen file on its own).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.EV2UI = factory(root);
}(typeof self !== 'undefined' ? self : this, function (win) {
  'use strict';

  const doc = win.document;
  const LABELS = {
    es: { ok: 'Confirmar', cancel: 'Cancelar', close: 'Cerrar' },
    en: { ok: 'Confirm', cancel: 'Cancel', close: 'Close' },
  };
  const lang = () => {
    const l = (doc.documentElement.getAttribute('lang') || 'es').slice(0, 2);
    return LABELS[l] ? l : 'es';
  };

  let open = null; // only one dialog at a time; a second one waits for the first

  function confirm(text, opts) { return dialog(text, opts || {}, false); }
  function prompt(text, opts) { return dialog(text, opts || {}, true); }

  function dialog(text, o, withInput) {
    const run = () => new Promise((resolve) => {
      const L = LABELS[lang()];
      const previous = doc.activeElement;
      const overlay = doc.createElement('div');
      overlay.className = 'ev2-overlay';
      const dialog = doc.createElement('div');
      dialog.className = 'ev2-dialog';
      dialog.setAttribute('role', o.danger ? 'alertdialog' : 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      if (o.title) {
        const h = doc.createElement('h2');
        h.id = 'ev2-dialog-title';
        h.textContent = o.title;
        dialog.appendChild(h);
        dialog.setAttribute('aria-labelledby', h.id);
      }
      const p = doc.createElement('p');
      p.id = 'ev2-dialog-text';
      p.textContent = String(text == null ? '' : text);
      dialog.appendChild(p);
      dialog.setAttribute('aria-describedby', p.id);

      let input = null;
      if (withInput) {
        input = doc.createElement('input');
        input.className = 'field mt-3';
        input.type = 'text';
        input.value = o.value == null ? '' : String(o.value);
        if (o.inputmode) input.setAttribute('inputmode', o.inputmode);
        input.setAttribute('aria-labelledby', p.id);
        dialog.appendChild(input);
      }

      const actions = doc.createElement('div');
      actions.className = 'ev2-dialog-actions';
      const no = doc.createElement('button');
      no.type = 'button';
      no.className = 'btn-secondary';
      no.textContent = o.cancel || L.cancel;
      const yes = doc.createElement('button');
      yes.type = 'button';
      yes.className = o.danger ? 'btn-danger' : 'ev2-button';
      yes.textContent = o.ok || L.ok;
      actions.append(no, yes);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);

      const finish = (answer) => {
        doc.removeEventListener('keydown', onKey, true);
        overlay.remove();
        open = null;
        if (previous && typeof previous.focus === 'function') previous.focus();
        resolve(answer);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(withInput ? null : false); }
        if (e.key === 'Tab') { // keep focus inside the dialog
          const order = input ? [input, no, yes] : [no, yes];
          const i = order.indexOf(doc.activeElement);
          e.preventDefault();
          order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
        }
      };
      no.onclick = () => finish(withInput ? null : false);
      yes.onclick = () => finish(withInput ? input.value : true);
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
        });
      }
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(withInput ? null : false);
      });
      doc.addEventListener('keydown', onKey, true);
      doc.body.appendChild(overlay);
      // A dangerous action never starts focused: Enter must not delete anything.
      if (input) { input.focus(); input.select(); } else (o.danger ? no : yes).focus();
    });
    open = (open || Promise.resolve()).then(run);
    return open;
  }

  let stack = null;
  function toast(text, opts) {
    const o = opts || {};
    if (!stack || !stack.isConnected) {
      stack = doc.createElement('div');
      stack.className = 'ev2-toasts';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      doc.body.appendChild(stack);
    }
    const el = doc.createElement('div');
    el.className = `ev2-toast${o.kind ? ` ${o.kind}` : ''}`;
    const span = doc.createElement('span');
    span.textContent = String(text == null ? '' : text);
    el.appendChild(span);
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); };
    if (o.action && typeof o.onAction === 'function') {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = o.action;
      b.onclick = () => { close(); o.onAction(); };
      el.appendChild(b);
    }
    stack.appendChild(el);
    timer = setTimeout(close, o.ms || (o.action ? 6000 : 3200));
    return close;
  }

  return { confirm, prompt, toast };
}));
