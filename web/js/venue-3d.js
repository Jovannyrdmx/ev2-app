import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Schematic geometry uses the original 2D coordinates, not invented venue dimensions.
export function create(container, options = {}) {
  const t = options.t || ((key) => key);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b101b);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t('venue.hint'));
  container.replaceChildren();
  container.classList.add('venue-frame');
  const toolbar = document.createElement('div');
  toolbar.className = 'venue-tools';
  const viewport = document.createElement('div');
  viewport.className = 'venue-viewport';
  viewport.appendChild(canvas);
  container.append(toolbar, viewport);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xcfefff, 0x293144, 2.6));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(250, 650, 250); scene.add(light);
  let group = new THREE.Group(); scene.add(group);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 180; controls.maxDistance = 2200;
  controls.target.set(0, 0, 0);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const cursor = new THREE.Vector2();
  let plan = { tables: [], landmarks: [], canvas: { width: 800, height: 580 } };
  let floor = 'baja'; let mode = 'view'; let picks = []; let down = null; let drag = null;
  let disposed = false;
  const buttons = [];
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  function reset(top = false) {
    const size = plan.canvas || { width: 800, height: 580 };
    const span = Math.max(Number(size.width), Number(size.height));
    controls.target.set(0, 0, 0);
    camera.position.set(top ? 0 : span * 0.65, span * (top ? 1.7 : 1.05), top ? 0.1 : span * 1.05);
    camera.aspect = (viewport.clientWidth || 800) / (viewport.clientHeight || 530);
    camera.updateProjectionMatrix(); camera.lookAt(controls.target); camera.updateMatrixWorld();
    const corners = [-1,1].flatMap((x) => [-1,1].map((z) =>
      new THREE.Vector3(x*Number(size.width)/2,0,z*Number(size.height)/2).project(camera)));
    const fit = Math.max(...corners.flatMap((p) => [Math.abs(p.x),Math.abs(p.y)]));
    camera.position.multiplyScalar(Math.max(.45, fit/.85));
    controls.update(); render();
  }
  for (const [key, action] of [
    ['venue.reset', () => reset()], ['venue.top', () => reset(true)],
    ['venue.zoomIn', () => { camera.position.sub(controls.target).multiplyScalar(0.82).add(controls.target); controls.update(); render(); }],
    ['venue.zoomOut', () => { camera.position.sub(controls.target).multiplyScalar(1.22).add(controls.target); controls.update(); render(); }],
  ]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = t(key); button.onclick = action;
    toolbar.appendChild(button); buttons.push([button, key]);
  }
  function disposeGroup() {
    group.traverse((object) => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials.filter(Boolean)) { material.map?.dispose(); material.dispose(); }
    });
    scene.remove(group);
    group = new THREE.Group(); scene.add(group); picks = [];
  }
  function box(w, h, d, color, x, y, z, data, opacity = 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.65, transparent: opacity < 1, opacity }));
    mesh.position.set(x, y, z); mesh.userData = data || {};
    group.add(mesh);
    if (data) picks.push(mesh);
    return mesh;
  }
  function label(text, x, y, z, width, data, color = '#edf5ff', compact = false) {
    const textureCanvas = document.createElement('canvas');
    const tw = compact ? 128 : 512; const th = compact ? 80 : 96;
    textureCanvas.width = tw; textureCanvas.height = th;
    const ctx = textureCanvas.getContext('2d');
    ctx.font = compact ? '700 52px Inter, sans-serif' : '600 48px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const bg = compact ? Math.min(tw,ctx.measureText(String(text)).width+16) : tw;
    ctx.fillStyle = 'rgba(8,15,27,.92)'; ctx.fillRect((tw-bg)/2, 0, bg, th);
    ctx.fillStyle = color; ctx.fillText(String(text), tw/2, th/2, tw-12);
    const texture = new THREE.CanvasTexture(textureCanvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true }));
    sprite.position.set(x, y, z); sprite.scale.set(width, width * th / tw, 1);
    sprite.userData = data || {}; group.add(sprite);
    if (data) picks.push(sprite);
  }
  function update(next, settings = {}) {
    plan = next; floor = settings.floor || floor;
    mode = settings.mode || mode;
    controls.enabled = mode === 'view';
    disposeGroup();
    const size = plan.canvas || { width: 800, height: 580 };
    const sx = Number(size.width); const sy = Number(size.height);
    box(sx, 8, sy, 0x1b2536, 0, -6, 0);
    const shown = (plan.tables || []).filter((row) => row.floor === floor || row.floor === 'ambas');
    const zones = new Map();
    for (const table of shown) {
      const key = `${table.floor || 'baja'}|${table.section || ''}`;
      if (!zones.has(key)) zones.set(key, []);
      zones.get(key).push(table);
    }
    for (const [key, tables] of zones) {
      const x1 = Math.min(...tables.map((r) => Number(r.x) - Number(r.radius || 24)));
      const x2 = Math.max(...tables.map((r) => Number(r.x) + Number(r.radius || 24)));
      const y1 = Math.min(...tables.map((r) => Number(r.y) - Number(r.radius || 24)));
      const y2 = Math.max(...tables.map((r) => Number(r.y) + Number(r.radius || 24)));
      const data = { kind: 'zone', key };
      box(x2-x1+8, 1, y2-y1+8, tables[0].color || '#00bfff',
        (x1+x2-sx)/2, 0, (y1+y2-sy)/2, data, 0.1);
      if (options.editable) label(tables[0].section || t('venue.zone'), (x1+x2-sx)/2, 5,
        y1-sy/2-8, Math.min(135, Math.max(x2-x1, 90)), data);
    }
    for (const landmark of (plan.landmarks || []).filter((r) => r.floor === floor || r.floor === 'ambas')) {
      const w = Number(landmark.width || 60); const d = Number(landmark.height || 50);
      const x = Number(landmark.x) + w/2-sx/2; const z = Number(landmark.y)+d/2-sy/2;
      const height = ['bar','dj','stage'].includes(landmark.type) ? 27 : 3;
      const colors = { bar: '#bf9b56', dance_area: '#39866a', dj: '#7860a6', entrance: '#287f9c' };
      const data = { kind: 'landmark', key: landmark.code };
      box(w,height,d,colors[landmark.type] || '#58667b',x,height/2,z,data);
      const areaKey = `venue.area.${landmark.type}`;
      label(t(areaKey) === areaKey ? landmark.name : t(areaKey), x, height+14,z,Math.max(70,Math.min(w,130)), data);
    }
    for (const table of shown) {
      const radius = Number(table.radius || 24);
      const x = Number(table.x)-sx/2; const z = Number(table.y)-sy/2;
      const selected = table.id === settings.selectedId;
      const mine = table.id === settings.myTableId;
      const available = settings.availableIds ? settings.availableIds.has(table.id) : table.status === 'available';
      const color = mine ? '#00ff00' : selected ? '#fff19c' : available ? (table.color || '#45cbe5') : '#626b7e';
      const data = { kind: 'table', key: table.id, zone: `${table.floor || 'baja'}|${table.section || ''}` };
      const top = new THREE.Mesh(new THREE.CylinderGeometry(radius*.8,radius*.8,6,20),
        new THREE.MeshStandardMaterial({ color, roughness: .45, metalness: .08 }));
      top.position.set(x,25,z); top.userData=data; group.add(top); picks.push(top);
      box(8,22,8,0x353f50,x,11,z,data);
      // Seating is symbolic: capacities still come from the stored table record.
      for(let i=0;i<4;i++) {
        const angle=i*Math.PI/2;
        box(10,14,10,color,x+Math.cos(angle)*radius,7,z+Math.sin(angle)*radius,data);
      }
      label(table.code || table.table_number, x, 44, z, 44, data, selected?'#fff19c':'#edf5ff', true);
    }
    for (const [button,key] of buttons) button.textContent=t(key);
    render();
  }
  function pointer(event) {
    const rect = canvas.getBoundingClientRect();
    cursor.set((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1);
    ray.setFromCamera(cursor, camera);
  }
  function hit(event) {
    pointer(event);
    const all = ray.intersectObjects(picks, false);
    const match = all.find(({object}) => mode === 'zone'
      ? ['table','zone'].includes(object.userData.kind)
      : mode === 'landmark' ? object.userData.kind==='landmark' : object.userData.kind==='table');
    if (!match) return null;
    const data = match.object.userData;
    return mode === 'zone' ? { kind:'zone',key:data.zone || data.key } : data;
  }
  function point(event) {
    pointer(event);
    return ray.ray.intersectPlane(plane,new THREE.Vector3());
  }
  function start(event) {
    if (drag) return;
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    down={x:event.clientX,y:event.clientY};
    const target=hit(event);
    if (!options.editable || mode==='view' || !target) return;
    const origin=point(event); if (!origin) return;
    drag={target,origin,pointerId:event.pointerId};
    controls.enabled=false; canvas.setPointerCapture(event.pointerId);
    options.onDragStart?.(target);
    event.stopImmediatePropagation();
  }
  function move(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const at=point(event); if (!at) return;
    options.onMove?.(drag.target,at.x-drag.origin.x,at.z-drag.origin.z);
  }
  function end(event) {
    if(drag && drag.pointerId===event.pointerId) {
      if(canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      options.onDragEnd?.(drag.target,event.type==='pointercancel'); drag=null; down=null;
      controls.enabled=mode==='view'; return;
    }
    if(down && Math.hypot(event.clientX-down.x,event.clientY-down.y)<6) {
      const target=hit(event); if(target) options.onSelect?.(target);
    }
    down=null;
  }
  canvas.addEventListener('pointerdown',start,true);
  canvas.addEventListener('pointermove',move);
  canvas.addEventListener('pointerup',end);
  canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('webglcontextlost',(event)=>{event.preventDefault();options.onUnavailable?.();});
  function resize() {
    const width=viewport.clientWidth; const height=viewport.clientHeight;
    if(!width || !height) return;
    camera.aspect=width/height; camera.updateProjectionMatrix(); renderer.setSize(width,height,false); render();
  }
  const observer=new ResizeObserver(resize); observer.observe(viewport);
  controls.addEventListener('change',render);
  reset(); resize();
  return {
    update, reset, resize,
    dispose() {
      disposed=true; observer.disconnect(); controls.dispose(); disposeGroup();
      renderer.dispose(); renderer.forceContextLoss(); container.replaceChildren();
    },
  };
}
