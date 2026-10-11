/**
 * Inventory → Menú list: the product name must be fully readable and the price must
 * keep its own fixed width. `.field { width: 100% }` once beat `w-24`, so the price
 * input swallowed the row and pushed name and toggle off-screen on phones.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'manager-screen.js'), 'utf8');
const start = src.indexOf('function renderMenuList()');
const body = src.slice(start, src.indexOf('prender.onclick', start));

describe('renderMenuList', () => {
  test('name is not truncated and is addressable', () => {
    expect(body).toMatch(/nombre\.className = '[^']*break-words/);
    expect(body).not.toMatch(/nombre\.className = '[^']*truncate/);
    expect(body).toContain("nombre.dataset.role = 'drink-name'");
  });

  test('price input has inline width, a $ sign and an accessible label', () => {
    expect(body).toContain("precio.style.width = '5.5rem'");
    expect(body).toContain("precio.style.flex = '0 0 auto'");
    expect(body).toContain("signo.textContent = '$'");
    expect(body).toContain("precio.setAttribute('aria-label', t('inv.menuPrice'))");
    expect(body).not.toMatch(/precio\.className = '[^']*\bw-24\b/);
  });
});
