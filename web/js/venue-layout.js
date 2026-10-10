/* Shared, deterministic layout operations. No money or availability decisions. */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2VenueLayout = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const zoneKey = (table) => `${table.floor || 'baja'}|${table.section || ''}`;
  function members(plan, kind, key) {
    if (kind === 'zone') return plan.tables.filter((t) => zoneKey(t) === key);
    return (kind === 'table' ? plan.tables : plan.landmarks)
      .filter((t) => (kind === 'table' ? t.id : t.code) === key);
  }
  function move(plan, kind, key, dx, dy) {
    const next = copy(plan);
    const selected = members(next, kind, key);
    if (!selected.length || !Number.isFinite(dx) || !Number.isFinite(dy)) return next;
    const size = next.canvas || { width: 800, height: 580 };
    let minX = -Infinity; let maxX = Infinity; let minY = -Infinity; let maxY = Infinity;
    for (const item of selected) {
      const isTable = kind !== 'landmark';
      const r = Number(item.radius || 24);
      minX = Math.max(minX, (isTable ? r : 0) - Number(item.x));
      minY = Math.max(minY, (isTable ? r : 0) - Number(item.y));
      maxX = Math.min(maxX, size.width - Number(item.x) - (isTable ? r : Number(item.width || 0)));
      maxY = Math.min(maxY, size.height - Number(item.y) - (isTable ? r : Number(item.height || 0)));
    }
    const x = Math.max(minX, Math.min(maxX, dx));
    const y = Math.max(minY, Math.min(maxY, dy));
    for (const item of selected) {
      item.x = Math.round((Number(item.x) + x) * 100) / 100;
      item.y = Math.round((Number(item.y) + y) * 100) / 100;
    }
    return next;
  }
  function changes(original, draft) {
    const changed = (list, before, key) => list.filter((item) => {
      const old = before.find((r) => r[key] === item[key]);
      return old && (Number(old.x) !== Number(item.x) || Number(old.y) !== Number(item.y));
    }).map((item) => ({ [key]: item[key], x: Number(item.x), y: Number(item.y) }));
    return {
      revision: Number(original.revision || 0),
      tables: changed(draft.tables, original.tables, 'id'),
      landmarks: changed(draft.landmarks, original.landmarks, 'code'),
    };
  }
  let loading;
  function load3D() {
    if (globalThis.EV2Venue3D) return Promise.resolve(globalThis.EV2Venue3D);
    if (!loading) loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/venue-3d.js';
      script.onload = () => resolve(globalThis.EV2Venue3D);
      script.onerror = () => { loading = null; script.remove(); reject(new Error('3D unavailable')); };
      document.head.appendChild(script);
    });
    return loading;
  }
  return { copy, zoneKey, members, move, changes, load3D };
}));
