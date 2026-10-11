/**
 * The manager's side menu (desktop) has a fixed height and 15+ sections. With
 * `overflow: visible` the lower sections were cut off and unreachable on short screens.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'manager.html'), 'utf8');
const nav = html.match(/<nav id="mgr-nav"[^>]*>/)[0];

describe('manager side menu', () => {
  test('scrolls vertically on desktop when it does not fit', () => {
    expect(nav).toContain('lg:overflow-y-auto');
    expect(nav).toContain('lg:overflow-x-hidden');
    expect(nav).not.toContain('lg:overflow-visible');
  });

  test('keeps its fixed height so the scroll lives inside the menu', () => {
    expect(nav).toContain('lg:h-[calc(100vh-57px)]');
  });
});
