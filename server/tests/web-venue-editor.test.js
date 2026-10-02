'use strict';
const L = require('../../web/js/venue-layout');
const F = require('../../web/js/format');
const fs = require('fs');
const path = require('path');
const plan = () => ({
  revision: 7, canvas: { width: 800, height: 580 },
  tables: [
    { id:'a',code:'A',floor:'baja',section:'VIP',x:100,y:100,radius:24,capacity:4,status:'occupied' },
    { id:'b',code:'B',floor:'baja',section:'VIP',x:200,y:100,radius:24,capacity:8,status:'available' },
    { id:'c',code:'C',floor:'alta',section:'VIP',x:200,y:100,radius:24 },
  ],
  landmarks: [{ code:'bar',floor:'baja',x:600,y:20,width:150,height:70 }],
});

describe('Editor wiring and permission guard', () => {
  const { JSDOM } = require('jsdom');
  const read = (name) => fs.readFileSync(path.join(__dirname,'../../web',name),'utf8');
  it('every referenced editor control exists and has no duplicate id', () => {
    const dom = new JSDOM(read('venue-editor.html'));
    const ids = [...dom.window.document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [,id] of read('js/venue-editor.js').matchAll(/\$\('([^']+)'\)/g)) {
      expect(ids).toContain(id);
    }
    dom.window.close();
  });
  it('starts hidden and enforces admin before fetching the layout', () => {
    const dom = new JSDOM(read('venue-editor.html'));
    expect(dom.window.document.getElementById('editor-work').hidden).toBe(true);
    const script = read('js/venue-editor.js');
    expect(script).toContain("user.role !== 'admin'");
    expect(script.indexOf("user.role !== 'admin'")).toBeLessThan(script.indexOf('await load(); if (!draft)'));
    expect(script).toContain('`${path()}/layout`, delta()');
    dom.window.close();
  });
  it('the renderer is local, lazy-loaded and cached for the PWA', () => {
    expect(read('js/venue-layout.js')).toContain("script.src = 'vendor/venue-3d.js'");
    expect(read('sw.js')).toContain("'vendor/venue-3d.js'");
    expect(read('index.html')).not.toContain('<script src="vendor/venue-3d.js"');
  });
});
describe('Draft layout operations', () => {
  it('moves one table without mutating identity, occupancy or capacity', () => {
    const p = plan(); const next = L.move(p,'table','a',20,30);
    expect(p.tables[0].x).toBe(100);
    expect(next.tables[0]).toEqual({ ...p.tables[0],x:120,y:130 });
    expect(next.tables[1]).toEqual(p.tables[1]);
    expect(L.changes(p,next)).toEqual({ revision:7,tables:[{id:'a',x:120,y:130}],landmarks:[] });
  });
  it('moves every table in one floor/zone together, not names on other floors', () => {
    const p = plan(); const next = L.move(p,'zone','baja|VIP',40,-20);
    expect(next.tables.map((r) => r.x)).toEqual([140,240,200]);
    expect(next.tables[1].x-next.tables[0].x).toBe(100);
    expect(L.changes(p,next).tables).toHaveLength(2);
  });
  it('clamps an entire zone without changing its internal spacing', () => {
    const next = L.move(plan(),'zone','baja|VIP',-1000,1000);
    expect(next.tables[0].x).toBe(24);
    expect(next.tables[1].x).toBe(124);
    expect(next.tables[0].y).toBe(556);
  });
  it('keeps the full landmark rectangle inside the canvas', () => {
    expect(L.move(plan(),'landmark','bar',1000,-1000).landmarks[0]).toMatchObject({x:650,y:0});
  });
  it('ignores invalid deltas and unknown selections', () => {
    expect(L.move(plan(),'table','a',NaN,0)).toEqual(plan());
    expect(L.move(plan(),'table','missing',1,1)).toEqual(plan());
  });
  it('undo snapshots and no-op deltas stay clean', () => {
    const p = plan(); expect(L.changes(p,L.copy(p))).toEqual({revision:7,tables:[],landmarks:[]});
  });
  it('has Spanish and English labels for every new UI key', () => {
    const files = ['venue-editor.html','js/venue-editor.js','js/venue-3d.js','index.html'];
    const keys = new Set(files.flatMap((name) => [...fs.readFileSync(path.join(__dirname,'../../web',name),'utf8')
      .matchAll(/venue\.[A-Za-z]+(?:\.[A-Za-z_]+)?/g)].map((m) => m[0])));
    keys.delete('venue.area');
    for (const language of ['es','en']) {
      F.setLanguage(language);
      for (const key of keys) expect(F.t(key)).not.toBe(key);
    }
    F.setLanguage('es');
  });
  it('refreshes the customer plan from revision notifications', () => {
    const C = require('../../web/js/client');
    expect(C.applyEvent({}, {event_type:'floor_plan_updated',payload:{revision:8}})).toEqual({changed:'floorPlan'});
  });
});
