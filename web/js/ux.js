/* Shared, presentation-only accessibility and dialogs for EV2. */
(function (root) {
  'use strict';
  const text = (key) => root.EV2Format ? root.EV2Format.t(key) : key;
  let dialogBusy = false;

  function ask(message, initial, entry) {
    if (dialogBusy) return Promise.resolve(entry ? null : false);
    dialogBusy = true;
    const doc = root.document;
    const previous = doc.activeElement;
    const dialog = doc.createElement('dialog');
    dialog.className = 'ux-dialog';
    dialog.setAttribute('aria-labelledby', 'ux-dialog-title');
    dialog.setAttribute('aria-describedby', 'ux-dialog-message');
    const form = doc.createElement('form');
    form.method = 'dialog';
    const title = doc.createElement('h2');
    title.id = 'ux-dialog-title';
    title.textContent = text(entry ? 'ux.enterValue' : 'ux.reviewAction');
    const body = doc.createElement('p');
    body.id = 'ux-dialog-message';
    body.textContent = String(message || '');
    form.append(title, body);
    const input = doc.createElement('input');
    if (entry) {
      input.value = initial == null ? '' : String(initial);
      input.setAttribute('aria-label', String(message || text('ux.enterValue')));
      input.maxLength = 1000;
      form.append(input);
    }
    const actions = doc.createElement('div');
    actions.className = 'ux-dialog-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = text('ux.cancel');
    const accept = doc.createElement('button');
    accept.type = 'submit';
    accept.className = 'ev2-button';
    accept.textContent = text('ux.continue');
    actions.append(cancel, accept);
    form.append(actions);
    dialog.append(form);
    doc.body.append(dialog);
    return new Promise((resolve) => {
      let done = false;
      const finish = (accepted) => {
        if (done) return;
        done = true;
        const value = entry ? (accepted ? input.value : null) : accepted;
        dialog.close();
        dialog.remove();
        dialogBusy = false;
        if (previous && previous.isConnected) previous.focus();
        resolve(value);
      };
      cancel.onclick = () => finish(false);
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
      form.onsubmit = (event) => { event.preventDefault(); finish(true); };
      dialog.showModal();
      (entry ? input : cancel).focus();
      if (entry) input.select();
    });
  }

  function enhance(doc) {
    doc.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea,select').forEach((input) => {
      if (!input.id || input.getAttribute('aria-label') || (input.labels && input.labels.length)) return;
      const name = input.getAttribute('placeholder') || input.getAttribute('title');
      if (!name) return;
      const label = doc.createElement('label');
      label.className = 'ux-field-label';
      label.htmlFor = input.id;
      label.textContent = name;
      const key = input.getAttribute('data-i18n-placeholder') || input.getAttribute('data-i18n-title');
      if (key) label.setAttribute('data-i18n', key);
      // Keep grid placement intact: the field and its label occupy the original cell.
      const wrapper = doc.createElement('div');
      wrapper.className = 'ux-field-wrap';
      ['w-1/2', 'col-span-2', 'flex-1'].forEach((c) => {
        if (input.classList.contains(c)) { wrapper.classList.add(c); input.classList.remove(c); }
      });
      input.before(wrapper);
      wrapper.append(label, input);
      input.style.width = '100%';
    });
    doc.querySelectorAll('button[title],a[title]').forEach((el) => {
      if (!el.getAttribute('aria-label') && !el.textContent.trim()) {
        el.setAttribute('aria-label', el.title);
        if (el.dataset.i18nTitle) el.setAttribute('data-i18n-aria-label', el.dataset.i18nTitle);
      }
    });
    doc.querySelectorAll('[id$="-error"],#auth-error,#banner').forEach((el) => {
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-atomic', 'true');
    });
    doc.querySelectorAll('#toast,#rt-text').forEach((el) => {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    });
  }

  root.EV2UX = {
    confirm: (message) => ask(message, '', false),
    prompt: (message, initial) => ask(message, initial, true),
    enhance,
  };

  if (!root.document) return;
  const boot = () => {
    const doc = root.document;
    enhance(doc);
    const main = doc.querySelector('main');
    if (main) {
      if (!main.id) main.id = 'ux-main';
      main.tabIndex = -1;
      const skip = doc.createElement('a');
      skip.href = `#${main.id}`;
      skip.className = 'ux-skip';
      skip.setAttribute('data-i18n', 'ux.skip');
      skip.textContent = text('ux.skip');
      doc.body.prepend(skip);
    }
    const network = doc.createElement('div');
    network.className = 'ux-connection';
    network.setAttribute('role', 'status');
    network.setAttribute('data-i18n', 'ux.offline');
    network.textContent = text('ux.offline');
    network.hidden = root.navigator.onLine;
    doc.body.prepend(network);
    const update = () => {
      network.textContent = text('ux.offline');
      network.hidden = root.navigator.onLine;
    };
    root.addEventListener('online', update);
    root.addEventListener('offline', update);
    let scheduled = false;
    const observer = new MutationObserver((records) => {
      if (!records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) return;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; enhance(doc); });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  };
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
  else boot();
}(typeof window !== 'undefined' ? window : globalThis));
