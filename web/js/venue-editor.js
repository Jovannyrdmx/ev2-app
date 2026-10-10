/* Admin-only layout draft. Position changes are committed in one revision-checked transaction. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const L = window.EV2VenueLayout;
  const t = (key) => window.EV2Format.t(key);
  const api = window.EV2.createClient({ baseUrl: document.querySelector('meta[name="ev2:api"]').content });
  let original; let draft; let renderer; let dragBase; let busy = false; let conflict = false;
  let undo = []; let statusKey = 'venue.loading';
  const floor = () => $('editor-floor').value;
  const mode = () => $('editor-mode').value;
  const key = () => $('editor-object').value;
  const path = () => `/nightclubs/${api.session.user.nightclub_id}/floor-plan`;
  const delta = () => original ? L.changes(original, draft) : { tables: [], landmarks: [] };
  const dirty = () => { const d = delta(); return !!(d.tables.length || d.landmarks.length); };
  const status = (value, raw = false) => {
    statusKey = raw ? null : value; $('editor-status').textContent = raw ? value : t(value);
  };
  function remember(before) {
    const d = L.changes(before, draft);
    if (d.tables.length || d.landmarks.length) { undo.push(before); if (undo.length > 50) undo.shift(); }
  }
  function controls() {
    $('editor-save').disabled = busy || conflict || !dirty();
    $('editor-undo').disabled = busy || !undo.length;
    $('editor-cancel').disabled = busy || !dirty();
    $('editor-reload').disabled = busy;
    for (const id of ['editor-floor', 'editor-mode', 'editor-object', 'editor-x', 'editor-y', 'editor-apply']) {
      $(id).disabled = busy || (['editor-object','editor-x','editor-y','editor-apply'].includes(id) && mode() === 'view');
    }
  }
  function selection() {
    const item = L.members(draft, mode(), key())[0];
    $('editor-x').value = item ? Number(item.x) : '';
    $('editor-y').value = item ? Number(item.y) : '';
    controls();
  }
  function draw() {
    renderer?.update(draft, { floor: floor(), mode: busy ? 'view' : mode(),
      selectedId: mode() === 'table' ? key() : null });
    selection();
  }
  function objects() {
    const previous = key(); const select = $('editor-object'); select.replaceChildren();
    const shown = (rows) => rows.filter((r) => r.floor === floor() || r.floor === 'ambas');
    const rows = mode() === 'zone'
      ? [...new Map(shown(draft.tables).map((r) => [L.zoneKey(r), { key: L.zoneKey(r), label: r.section }])).values()]
      : mode() === 'landmark' ? shown(draft.landmarks).map((r) => ({ key: r.code, label: `${t(`venue.area.${r.type}`)} · ${r.code}` }))
        : mode() === 'table' ? shown(draft.tables).map((r) => ({ key: r.id, label: `${r.code} · ${r.section}` })) : [];
    for (const row of rows) { const o = document.createElement('option'); o.value = row.key; o.textContent = row.label; select.append(o); }
    if (rows.some((r) => r.key === previous)) select.value = previous;
    draw();
  }
  function changed() { status(conflict ? 'venue.conflict' : dirty() ? 'venue.dirty' : 'venue.ready'); draw(); }
  async function load() {
    busy = true; controls(); status('venue.loading');
    try {
      const plan = await api.get(path());
      original = L.copy(plan); draft = L.copy(plan); undo = []; conflict = false;
      const select = $('editor-floor'); const previous = floor(); select.replaceChildren();
      for (const f of [...plan.floors].sort((a,b) => (a === 'baja' ? -1 : b === 'baja' ? 1 : a.localeCompare(b)))) {
        const o = document.createElement('option'); o.value = f;
        o.textContent = t(f === 'baja' ? 'map.floorBaja' : f === 'alta' ? 'map.floorAlta' : 'map.floorAmbas'); select.append(o);
      }
      if (plan.floors.includes(previous)) select.value = previous;
      $('editor-work').hidden = false;
      objects(); status('venue.ready');
    } catch (err) { status(window.EV2Format.errorMessage(err), true); }
    finally { busy = false; controls(); if (draft) draw(); }
  }
  $('editor-floor').onchange = objects;
  $('editor-mode').onchange = objects;
  $('editor-object').onchange = draw;
  $('editor-apply').onclick = () => {
    if (busy || mode() === 'view') return;
    const item = L.members(draft, mode(), key())[0]; if (!item) return;
    const x = $('editor-x').valueAsNumber; const y = $('editor-y').valueAsNumber;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const before = L.copy(draft);
    draft = L.move(draft, mode(), key(), x - Number(item.x), y - Number(item.y));
    remember(before); changed();
  };
  $('editor-undo').onclick = () => { if (!busy && undo.length) { draft = undo.pop(); changed(); } };
  $('editor-cancel').onclick = () => {
    if (busy || !window.confirm(t('venue.discard'))) return;
    draft = L.copy(original); undo = []; changed();
  };
  $('editor-reload').onclick = () => {
    if (!busy && (!dirty() || window.confirm(t('venue.discard')))) load();
  };
  $('editor-save').onclick = async () => {
    if (busy || conflict || !dirty()) return;
    busy = true; controls(); draw(); status('venue.saving');
    try {
      const result = await api.put(`${path()}/layout`, delta());
      draft.revision = result.revision; original = L.copy(draft); undo = [];
      status('venue.saved');
    } catch (err) {
      if (err.status === 409) { conflict = true; status('venue.conflict'); }
      else status(window.EV2Format.errorMessage(err), true);
    } finally { busy = false; draw(); }
  };
  function language() {
    window.EV2Format.setLanguage($('editor-language').value);
    document.documentElement.lang = window.EV2Format.locale();
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    if (statusKey) status(statusKey);
    for (const o of $('editor-floor').options) o.textContent = t(o.value === 'baja' ? 'map.floorBaja' : o.value === 'alta' ? 'map.floorAlta' : 'map.floorAmbas');
    if (draft) objects();
  }
  $('editor-language').value = window.EV2Format.getLanguage();
  $('editor-language').onchange = language; language();
  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  async function start() {
    const user = await api.resume();
    if (!user || user.role !== 'admin' || user.must_change_password || user.must_change_pin) {
      location.replace('manager.html'); return;
    }
    await load(); if (!draft) return;
    try {
      const lib = await L.load3D();
      renderer = lib.create($('editor-map'), {
        t, editable: true,
        onUnavailable: () => { $('editor-fallback').hidden = false; },
        onDragStart: (target) => {
          if (busy) return;
          dragBase = L.copy(draft); $('editor-object').value = target.key; selection();
        },
        onMove: (target, dx, dy) => {
          if (busy || !dragBase) return;
          draft = L.move(dragBase, target.kind, target.key, dx, dy); changed();
        },
        onDragEnd: (target, cancel) => {
          if (!dragBase) return;
          if (cancel) draft = dragBase; else remember(dragBase);
          dragBase = null; changed();
        },
      });
      draw();
    } catch { $('editor-fallback').hidden = false; }
  }
  start().catch((err) => status(window.EV2Format.errorMessage(err), true));
}());
