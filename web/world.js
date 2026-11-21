/* 台灣 1:1 — 建模 (道路、護欄、路邊設施、隧道、橋墩、地形、航照、建築) 與分區串流
 *
 * 效能設計 (舊版量到: 每幀 520 萬三角形、690 次繪製、建模與著色器編譯造成 0.2~1.4 秒卡頓):
 *  - 3.84 km 的分區再切成 480 m 小塊 (SUB)，鏡頭與陰影都能逐塊剔除 (大網格的包圍球太大，等於沒剔除)
 *  - 依種類決定顯示距離: 路面/護欄/隧道 (base) 全部；防眩板、導桿等 (prop) 1.4 km；反光片等小東西 (fine) 350 m；
 *    陰影只有玩家附近的小塊投射
 *  - 地形三級解析度 (30 / 60 / 120 m)，邊緣加裙邊蓋住接縫
 *  - 建模用產生器分段做，每幀限時 (BUDGET_MS)，不會一次卡住
 */
(function () {
'use strict';
const { T, params, setStatus, INDEX, TS, TC, TSTEP, TN, TGI, tkey, tileBuf, Z16, WAYS, PT_INDEX, ptKey, CELL, GRID, cellKey,
  ingestDetail, roadAt, TERR, LCLS, landcoverAt, terrainAt, cityAt, HOOKS, BARRIER_INSET, setupShoulders, rightEdge } = TW;
const { renderer, MOBILE, scene, GLOW_LAMP, patch, TERRAIN_SPEC,
  matLampPole, matSoundWall, matSoundUpper, matSoundPost, matBillboard, matBillboardBack, matLampHead, matAsphalt, matConcrete, matBarrier, matGore,
  matPost, matPostBand, matDrum, matDrumBand, matGlare, matCityRoad, matWall, matRoof, matJointSteel, matJointRubber,
  matReflBlack, matRetro, matTunnelWall, matCabinet, matRail, matPortal, matTunnelLight, matWater, matTerrain } = TW;
const S = () => TW.S;   // 玩家狀態 (drive.js 建立)

// ======================================================================= 幾何建構
class GB {
  // mode: '' 只有位置；'uv' 加 aUv；'road' 加 aUv + 車道屬性 (aLs, aLanes)
  constructor(mode = '') { this.p = []; this.i = []; this.mode = mode; if (mode) this.uv = []; if (mode === 'road') { this.ls = []; this.ln = []; } this.nrm = null; }
  get n() { return this.p.length / 3; }
  v(x, y, z) { this.p.push(x, z, -y); return this.n - 1; }  // 資料座標 -> three
  /** 完整頂點 [x, y, z, u, v, ls, ln] */
  vv(a) { const k = this.v(a[0], a[1], a[2]); if (this.uv) this.uv.push(a[3] || 0, a[4] || 0); if (this.ls) { this.ls.push(a[5] || 0); this.ln.push(a[6] || 0); } return k; }
  q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geometry() {
    if (!this.i.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    if (this.uv) g.setAttribute('aUv', new T.Float32BufferAttribute(this.uv, 2));
    if (this.ls) { g.setAttribute('aLs', new T.Float32BufferAttribute(this.ls, 1)); g.setAttribute('aLanes', new T.Float32BufferAttribute(this.ln, 1)); }
    g.setIndex(this.n > 65535 ? new T.Uint32BufferAttribute(this.i, 1) : new T.Uint16BufferAttribute(this.i, 1));
    if (this.nrm) g.setAttribute('normal', new T.Float32BufferAttribute(this.nrm, 3)); else g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
  mesh(mat, opts = {}) {
    const g = this.geometry(); if (!g) return null;
    const m = new T.Mesh(g, mat);
    m.castShadow = !!opts.cast; m.receiveShadow = opts.receive !== false;
    m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}
function box(g, cx, cy, tx, ty, hx, hy, z0, z1) {
  // tx,ty: 沿線方向；法向 = (-ty, tx)
  const nx = -ty, ny = tx;
  const c = (sx, sy, z) => g.v(cx + tx * sx * hx + nx * sy * hy, cy + ty * sx * hx + ny * sy * hy, z);
  const a0 = c(-1, -1, z0), a1 = c(1, -1, z0), a2 = c(1, 1, z0), a3 = c(-1, 1, z0);
  const b0 = c(-1, -1, z1), b1 = c(1, -1, z1), b2 = c(1, 1, z1), b3 = c(-1, 1, z1);
  g.q(a3, a2, a1, a0); g.q(b0, b1, b2, b3);
  g.q(a0, a1, b1, b0); g.q(a1, a2, b2, b1); g.q(a2, a3, b3, b2); g.q(a3, a0, b0, b3);
}
/** 圓片 (軸沿路線方向 tx,ty，面向來車)：中心 (cx, cy, cz)、半徑 r、厚 th */
function disc(g, cx, cy, cz, tx, ty, r, th, seg = 12) {
  const nx = -ty, ny = tx, b = g.n;
  for (const f of [-1, 1]) {
    const ox = cx + tx * th * 0.5 * f, oy = cy + ty * th * 0.5 * f;
    g.v(ox, oy, cz);
    for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; g.v(ox + nx * Math.cos(a) * r, oy + ny * Math.cos(a) * r, cz + Math.sin(a) * r); }
  }
  const back = b, front = b + seg + 1;
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    g.i.push(back, back + 1 + j, back + 1 + i);
    g.i.push(front, front + 1 + i, front + 1 + j);
    g.q(back + 1 + i, back + 1 + j, front + 1 + j, front + 1 + i);
  }
}
const withUv = (m) => { if (m) m.geometry.setAttribute('uv', m.geometry.getAttribute('aUv')); return m; };

// ======================================================================= 小塊 (SUB x SUB 公尺) 與種類
// 小塊大小: 路面/護欄 (base，到 7 km 都要畫) 用大塊 (少繪製呼叫，不投射陰影)；
// 小物件 (只畫 1.4 km 內、會投射陰影) 用小塊，陰影只算玩家旁邊幾塊
const SUB = +(params.get('sub') || 1920), SUB_P = +(params.get('subp') || 640);
const subKey = (x, y, sz) => (Math.floor(x / sz) * 100003 + Math.floor(y / sz)) * 2 + (sz === SUB ? 0 : 1);
// 種類 -> [GB 模式, 材質, 投射陰影, 接受陰影, 顯示距離類別]
const R_PROP = MOBILE ? 800 : 1400, R_FINE = MOBILE ? 200 : 350, R_LAMP = MOBILE ? 1500 : 3000, R_SHADOW = MOBILE ? 0 : 320;
const CATS = {
  road: ['road', () => matAsphalt, 0, 1, 'base'], city: ['road', () => matCityRoad, 0, 1, 'mid'], skirt: ['', () => matConcrete, 0, 1, 'base'],
  barrier: ['uv', () => matBarrier, 0, 1, 'base'], pier: ['', () => matConcrete, 0, 1, 'base'], gore: ['road', () => matGore, 0, 1, 'base'],
  tunnel: ['uv', () => matTunnelWall, 0, 1, 'base'], swall: ['', () => matSoundWall, 0, 1, 'mid'], supper: ['', () => matSoundUpper, 0, 1, 'mid'],
  bboard: ['uv', () => matBillboard, 0, 1, 'mid'], bback: ['', () => matBillboardBack, 0, 1, 'mid'], bpole: ['', () => matLampPole, 0, 1, 'mid'],
  glare: ['', () => matGlare, 1, 1, 'prop'], gpost: ['', () => matPost, 1, 1, 'prop'], gband: ['', () => matPostBand, 0, 1, 'prop'],
  drum: ['', () => matDrum, 1, 1, 'prop'], drumb: ['', () => matDrumBand, 0, 1, 'prop'], spost: ['', () => matSoundPost, 1, 1, 'prop'],
  tlight: ['', () => matTunnelLight, 0, 0, 'prop'], jsteel: ['', () => matJointSteel, 0, 1, 'prop'], jrubber: ['', () => matJointRubber, 0, 1, 'prop'],
  lampPole: ['', () => matLampPole, 1, 1, 'lamp'], lampHead: ['', () => matLampHead, 0, 1, 'lamp'],
  tcab: ['', () => matCabinet, 0, 1, 'fine'], reflBlack: ['', () => matReflBlack, 0, 1, 'fine'], reflFace: ['uv', () => matRetro, 0, 0, 'fine'],
};
const KIND_R = { base: 1e9, mid: MOBILE ? 2000 : 3200, prop: R_PROP, fine: R_FINE, lamp: R_LAMP };
// 同模式、同材質、同顯示類別、同陰影設定的種類共用一個網格 (少一次繪製呼叫)
const SLOT = {};
for (const [cat, c] of Object.entries(CATS)) { const k = [c[0], c[1]().uuid, c[2], c[3], c[4]].join('|'); SLOT[cat] = Object.keys(CATS).find((o) => { const d = CATS[o]; return [d[0], d[1]().uuid, d[2], d[3], d[4]].join('|') === k; }); }
/** 一個分區建模時的暫存: 小塊 key -> { x, y, gb: {種類: GB}, glows: [], extra: [Object3D] } */
class Build {
  constructor() { this.chunks = new Map(); }
  chunk(x, y, sz = SUB) {
    const k = subKey(x, y, sz);
    let c = this.chunks.get(k);
    if (!c) this.chunks.set(k, c = { x: (Math.floor(x / sz) + 0.5) * sz, y: (Math.floor(y / sz) + 0.5) * sz, r: sz * 0.75, gb: {}, glows: [], extra: [], strips: new Map() });
    return c;
  }
  /** (x, y) 所在小塊的某種類幾何 */
  g(cat, x, y) { cat = SLOT[cat]; const c = this.chunk(x, y, CATS[cat][4] === 'base' || CATS[cat][4] === 'mid' ? SUB : SUB_P); return c.gb[cat] || (c.gb[cat] = new GB(CATS[cat][0])); }
}
/** 帶狀網格 (路面、護欄、隧道…): 每列一組斷面頂點，相鄰兩列依 pairs 連成四邊形。
 *  每個四邊形放進兩列中點所在的小塊；跨小塊時前一列在新小塊重放一次 (所以小塊之間沒有缺口) */
class Strip {
  constructor(B, cat, pairs) { this.B = B; this.cat = SLOT[cat]; this.pairs = pairs; this.prev = null; this.id = Strip.next++; this.row = 0; }
  /** verts: [[x,y,z,u,v,ls,ln], ...]；ok = false: 這一列跟上一列之間不連 */
  add(verts, ok = true) {
    const row = this.row++;
    if (this.prev && ok) {
      const p = this.prev, c = this.B.chunk((p.v[0][0] + verts[0][0]) / 2, (p.v[0][1] + verts[0][1]) / 2);
      const g = c.gb[this.cat] || (c.gb[this.cat] = new GB(CATS[this.cat][0]));
      const last = c.strips.get(this.id);
      const pi = last && last.row === p.row ? last.idx : p.v.map((a) => g.vv(a));
      const ci = verts.map((a) => g.vv(a));
      for (const [a, b] of this.pairs) g.q(pi[a], pi[b], ci[b], ci[a]);
      c.strips.set(this.id, { row, idx: ci });
    }
    this.prev = { v: verts, row };
  }
}
Strip.next = 0;

// ======================================================================= 國道道路
// 混凝土護欄斷面 (照街景: 底部小斜趾、上半近乎垂直、平頂)；[橫向 m, 高 m]
const BARRIER = [[-0.32, 0], [-0.3, 0.07], [-0.2, 0.16], [-0.11, 0.84], [-0.08, 0.87], [0.08, 0.87], [0.11, 0.84], [0.2, 0.16], [0.3, 0.07], [0.32, 0]];
const BAR_PAIRS = BARRIER.slice(0, -1).map((_, j) => [j * 2, j * 2 + 1]);
/** 門架 (指示牌 / CMS / ETC) 位置: gid -> [節點 idx]。照實景，門架立柱那一段中央護欄會降低 (BAR_LOW) */
const BAR_LOW = 0.62, BAR_NOTCH = 2.0, BAR_RAMP = 0.02;   // 直接降一階 (不做斜坡)
let GANTRY_SPOTS = null;
function gantrySpots(gid) {
  if (!GANTRY_SPOTS) {
    GANTRY_SPOTS = new Map();
    const add = (g, i) => { if (g == null || i == null) return; if (!GANTRY_SPOTS.has(g)) GANTRY_SPOTS.set(g, []); GANTRY_SPOTS.get(g).push(i); };
    const read = (id) => { try { const el = document.getElementById(id); return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; } };
    const live = read('extra-live'), guides = read('extra-signs');
    if (live) { for (const c of live.cms || []) if ((c.pages || []).length) add(c.way, c.idx); if (!params.has('noetc')) for (const e of live.etc || []) add(e.way, e.idx); }
    if (guides) for (const g of guides) add(g.gid, g.idx);
  }
  return GANTRY_SPOTS.get(gid) || [];
}
/** 這條路左側 (中央) 護欄上的門架位置 (沿線距離)。共用的中央護欄也要算對向那條路的門架 */
function barrierNotches(w) {
  const out = [], { P, s, n } = w;
  for (const i of gantrySpots(w.gid)) if (i < n) out.push(s[i]);
  if (w.oppL) {
    const opp = new Set(); for (const o of w.oppL) if (o) opp.add(o);
    for (const o of opp) for (const i of gantrySpots(o.gid)) {
      if (i >= o.n) continue;
      const x = o.P[i * 3], y = o.P[i * 3 + 1];
      let best = 40, bd = -1;
      for (let k = 0; k < n - 1; k++) {
        const ax = P[k * 3], ay = P[k * 3 + 1], dx = P[k * 3 + 3] - ax, dy = P[k * 3 + 4] - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / L2)), d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
        if (d < best) { best = d; bd = s[k] + (s[k + 1] - s[k]) * t; }
      }
      if (bd >= 0) out.push(bd);
    }
  }
  return out;
}
/** 沿線距離 d 處的點: { k 線段, x, y, z } */
function along(w, d, k0 = 0) {
  const { P, s, n } = w;
  let k = k0; while (k < n - 2 && s[k + 1] < d) k++;
  const t = Math.min(1, Math.max(0, (d - s[k]) / ((s[k + 1] - s[k]) || 1)));
  return { k, t, x: P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t, y: P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t, z: P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t };
}

/** 沿路某點的護欄中心 (世界座標): 跟護欄網格一樣用兩個節點的「節點位置 + 節點法向 × 偏移」內插
 *  (舊做法用左節點的偏移和法向，在路肩加寬漸變段與彎道上物件會離開護欄) */
const OBJ_DEV = { n: 0, bad: 0, max: 0 }, OBJ_CHECK = params.has('objcheck');
if (OBJ_CHECK) setInterval(() => console.log('[test] objcheck ' + JSON.stringify(OBJ_DEV) + ' joints ' + JSON.stringify(JSTAT)), 15000);
const JSTAT = { placed: 0, dup: 0 };
function oPt(w, oAt, p) {
  const { P, nx, ny, n } = w, k = p.k, k1 = Math.min(k + 1, n - 1), t = p.t || 0, a = oAt(k), b = oAt(k1);
  const x0 = P[k * 3] + nx[k] * a, y0 = P[k * 3 + 1] + ny[k] * a, x1 = P[k1 * 3] + nx[k1] * b, y1 = P[k1 * 3 + 1] + ny[k1] * b;
  const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
  if (OBJ_CHECK) { const d = Math.hypot(x - (p.x + nx[k] * a), y - (p.y + ny[k] * a)); OBJ_DEV.n++; if (d > 0.05) OBJ_DEV.bad++; if (d > OBJ_DEV.max) OBJ_DEV.max = d; }
  return { x, y };
}
/** 國道外側路邊設施: 市區段的隔音牆 (實心綠色板、下段深綠上段淺綠、4 m 一根柱子) 與約每 1.2 km 一面廣告看板 */
function roadside(B, w, oAt, inward) {
  const { nx, ny, hw, M } = w, L = w.len;
  if (L < 30) return;
  const out = -inward;   // 外側方向 (乘在左法向上)
  // 每 20 m 判一次旁邊是不是市區，前後各延伸 40 m (隔音牆一路延伸過市區邊緣，不會一段一段)
  const step = 20, ns = Math.ceil(L / step) + 1, urb = new Uint8Array(ns);
  for (let q = 0, k = 0; q < ns; q++) {
    const p = along(w, q * step, k); k = p.k;
    const ox = nx[p.k] * out, oy = ny[p.k] * out;
    let u = 0;
    for (const dd of [35, 60, 90]) { const xx = p.x + ox * (hw + dd), yy = p.y + oy * (hw + dd); if (landcoverAt(xx, yy) === 5 || cityAt(xx, yy)) { u = 1; break; } }
    urb[q] = u;
  }
  const wall = new Uint8Array(ns);
  for (let q = 0; q < ns; q++) if (urb[q]) for (let r = Math.max(0, q - 2); r <= Math.min(ns - 1, q + 2); r++) wall[r] = 1;
  for (let d = 2, k = 0; d < L - 2; d += 4) {
    if (!wall[Math.min(ns - 1, Math.round(d / step))]) continue;
    const p = along(w, d, k); k = p.k; if ((M[p.k] | M[p.k + 1]) & 2) continue;
    const tx = ny[p.k], ty = -nx[p.k], ox = nx[p.k] * out, oy = ny[p.k] * out;
    // 照實景: 一般路段隔音牆立在護欄外約 1.4 m 的地上 (門架外側立柱就站在護欄與隔音牆之間)；橋上沒有地，立在護欄頂上
    const onGround = !w.bridge, off = onGround ? 1.45 : 0.18, z0 = onGround ? p.z - 3 : p.z + 0.86, zb = onGround ? p.z + 0.9 : p.z + 1.75;
    const q = oPt(w, oAt, p), cx = q.x + ox * off, cy = q.y + oy * off;
    box(B.g('swall', cx, cy), cx, cy, tx, ty, 2.0, 0.07, z0, zb);
    box(B.g('supper', cx, cy), cx, cy, tx, ty, 2.0, 0.07, zb, p.z + 4.2);
    const sp = B.g('spost', cx, cy);
    box(sp, cx - tx * 2, cy - ty * 2, tx, ty, 0.09, 0.11, z0, p.z + 4.35);
    box(sp, cx, cy, tx, ty, 2.0, 0.05, p.z + 4.2, p.z + 4.32);   // 頂部壓條
  }
  // 廣告看板: 市區段約每 1.2 km 一面 (位置由 gid 決定)，立在護欄外 9 m，面向來車並往路內轉 18°
  const first = 250 + ((w.gid * 7919) % 900);
  for (let d = first, idx = w.gid; d < L - 60; d += 1200, idx++) {
    if (!urb[Math.min(ns - 1, Math.round(d / step))]) continue;
    const p = along(w, d); if ((M[p.k] | M[p.k + 1]) & 2) continue;
    const tx = ny[p.k], ty = -nx[p.k], ox = nx[p.k] * out, oy = ny[p.k] * out;
    const q = oPt(w, oAt, p), bx = q.x + ox * 9, by = q.y + oy * 9;
    const gz = terrainAt(bx, by), base = Math.min(gz, p.z), top = p.z + 13, bot = top - 4.2;
    if (p.z - gz > 25) continue;   // 高架很高的地方不放
    box(B.g('bpole', bx, by), bx, by, tx, ty, 0.35, 0.35, base - 0.5, bot + 0.5);
    const a = 0.31, fx = -tx * Math.cos(a) - ox * Math.sin(a), fy = -ty * Math.cos(a) - oy * Math.sin(a);   // 板面朝向
    const ux = -fy, uy = fx, hwB = 6.0, ad = idx % 6, u0 = (ad % 3) / 3, v0 = 1 - Math.floor(ad / 3) / 2;
    const g = B.g('bboard', bx, by), i0 = g.n, fxo = fx * 0.12, fyo = fy * 0.12;
    g.v(bx + fxo - ux * hwB, by + fyo - uy * hwB, bot); g.uv.push(u0 + 1 / 3, v0 - 0.5);
    g.v(bx + fxo + ux * hwB, by + fyo + uy * hwB, bot); g.uv.push(u0, v0 - 0.5);
    g.v(bx + fxo + ux * hwB, by + fyo + uy * hwB, top); g.uv.push(u0, v0);
    g.v(bx + fxo - ux * hwB, by + fyo - uy * hwB, top); g.uv.push(u0 + 1 / 3, v0);
    g.q(i0, i0 + 1, i0 + 2, i0 + 3);
    box(B.g('bback', bx, by), bx, by, ux, uy, hwB + 0.15, 0.1, bot - 0.15, top + 0.15);   // 背板 + 邊框
    box(B.g('bpole', bx, by), bx, by, ux, uy, hwB, 0.08, bot - 0.6, bot - 0.45);           // 下方維修走道
  }
}

/** 反光片一支: 底座 → 支柱 → 黑色圓框 → 黃色反光面 (迎著來車)；(x, y, z0) 是護欄頂 */
function addReflector(B, x, y, z0, tx, ty) {
  const K = B.g('reflBlack', x, y), F = B.g('reflFace', x, y), nx = -ty, ny = tx;
  const b0 = K.n, seg = 8;
  for (const zz of [z0, z0 + 0.018]) for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; K.v(x + tx * Math.cos(a) * 0.085 + nx * Math.sin(a) * 0.055, y + ty * Math.cos(a) * 0.085 + ny * Math.sin(a) * 0.055, zz); }
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; K.q(b0 + i, b0 + j, b0 + seg + j, b0 + seg + i); K.i.push(b0 + seg, b0 + seg + j, b0 + seg + i); }
  box(K, x, y, tx, ty, 0.022, 0.022, z0 + 0.018, z0 + 0.15);   // 支柱
  box(K, x, y, tx, ty, 0.03, 0.03, z0 + 0.07, z0 + 0.11);      // 束環
  const zc = z0 + 0.24;
  disc(K, x, y, zc, tx, ty, 0.1, 0.034, 16);                   // 黑色圓框
  const fx = x - tx * 0.019, fy = y - ty * 0.019, r = 0.083, fs = 16, f0 = F.n;
  F.v(fx, fy, zc); F.uv.push(0, 0);
  for (let i = 0; i < fs; i++) { const a = i / fs * Math.PI * 2; F.v(fx + nx * Math.cos(a) * r, fy + ny * Math.cos(a) * r, zc + Math.sin(a) * r); F.uv.push(Math.cos(a), Math.sin(a)); }
  for (let i = 0; i < fs; i++) F.i.push(f0, f0 + 1 + ((i + 1) % fs), f0 + 1 + i);
}

/** 節點 i 某一側 (side = +1 左 / -1 右) 跟旁邊同高度平行道路之間的空隙 (路緣到路緣，含加寬路肩)。
 *  分岔 / 匯流處兩條路慢慢分開時，中間會露出底下的側牆與地面 (很醜)，用這個量來補平 */
const GAP_FILL = 12, GAP_LOG = params.has('gaplog') ? { n: 0 } : null;
function edgeGap(w, i, side) {
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2], nx = w.nx[i], ny = w.ny[i], tx = ny, ty = -nx;
  const mine = w.hw + (side > 0 ? (w.eL ? w.eL[i] : 0) : (w.eR ? w.eR[i] : 0)), R = mine + GAP_FILL + 16;
  let best = null;
  const seen = new Set();
  for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
    const a = GRID.get(cellKey(cx, cy)); if (!a) continue;
    for (let j = 0; j < a.length; j += 2) {
      const o = WAYS[a[j]], si = a[j + 1];
      if (!o || o === w || o.city || o.tunnel) continue;
      const id = a[j] * 100000 + si; if (seen.has(id)) continue; seen.add(id);
      const ax = o.P[si * 3], ay = o.P[si * 3 + 1], L = Math.hypot(o.P[si * 3 + 3] - ax, o.P[si * 3 + 4] - ay);
      if (L < 1e-3) continue;
      const ux = (o.P[si * 3 + 3] - ax) / L, uy = (o.P[si * 3 + 4] - ay) / L, dot = ux * tx + uy * ty;
      if (Math.abs(dot) < 0.85) continue;
      const t = (x - ax) * ux + (y - ay) * uy; if (t < 0 || t > L) continue;
      const qx = ax + ux * t, qy = ay + uy * t, qz = o.P[si * 3 + 2] + (o.P[si * 3 + 5] - o.P[si * 3 + 2]) * (t / L);
      if (Math.abs(qz - z) > 0.8) continue;
      const lat = (qx - x) * nx + (qy - y) * ny; if (lat * side <= 0) continue;
      setupShoulders(o);
      const f = t / L, ex = (arr) => arr ? arr[si] + (arr[si + 1] - arr[si]) * f : 0;
      const facesLeft = (lat > 0) === (dot > 0);   // 對方面向我的是它的左側還是右側
      const theirs = o.hw + (facesLeft ? ex(o.eR) : ex(o.eL));
      const g = Math.abs(lat) - mine - theirs;
      if (g < -0.3 || g > GAP_FILL) continue;
      if (!best || g < best.g) best = { g, z: qz };
    }
  }
  return best;
}
function addRoad(B, w) {
  setupShoulders(w);
  const { P, nx, ny, s, n, hw, M } = w;
  const EL = (i) => w.eL ? w.eL[i] : 0, ER = (i) => w.eR ? w.eR[i] : 0, PR = (i) => !!(w.pair && w.pair[i]);
  // 路面 (u 座標從原本左路緣起算，加寬的路肩 u < 0 / u > width，標線位置不變)
  const lsT = w.ls + (w.tunnel ? 100 : 0);   // 隧道旗標: 著色器用 aLs >= 50 判斷
  const road = new Strip(B, 'road', [[0, 1]]);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], le = hw + EL(i), re = hw + ER(i);
    road.add([[x + nx[i] * le, y + ny[i] * le, z, -EL(i), s[i], lsT, w.lanes], [x - nx[i] * re, y - ny[i] * re, z, w.width + ER(i), s[i], lsT, w.lanes]],
      !(i > 0 && (M[i - 1] & M[i] & 4)));   // bit2: 匝道整段在主線路面內，不畫
  }
  // 側面 / 梁底 (左右各一條帶子；落在別條路面上、或中央分隔接著對向路面就不做)
  const depth = w.bridge ? 2.2 : (w.tunnel ? 0.6 : 2.0);
  const sl = new Strip(B, 'skirt', [[1, 0]]), sr = new Strip(B, 'skirt', [[0, 1]]), sb = w.bridge ? new Strip(B, 'skirt', [[1, 0]]) : null;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], le = hw + EL(i), re = hw + ER(i);
    const lx = x + nx[i] * le, ly = y + ny[i] * le, rx = x - nx[i] * re, ry = y - ny[i] * re;
    const okL = i > 0 && !((M[i - 1] | M[i]) & 1) && !(PR(i - 1) && PR(i) && !w.bridge), okR = i > 0 && !((M[i - 1] | M[i]) & 2);
    sl.add([[lx, ly, z], [lx, ly, z - depth]], okL);
    sr.add([[rx, ry, z], [rx, ry, z - depth]], okR);
    if (sb) sb.add([[lx, ly, z - depth], [rx, ry, z - depth]]);
  }
  // 分岔 / 匯流楔形空隙: 兩條路各補一半 (混凝土鋪面，跟路面同高)，蓋住底下的側牆
  if (!w.tunnel && !w.city && !params.has('nofill')) for (const side of [1, -1]) {
    const bit = side > 0 ? 1 : 2, fs = new Strip(B, 'skirt', [[0, 1]]);
    let prev = false;
    for (let i = 0; i < n; i++) {
      const gp = (M[i] & bit) ? null : edgeGap(w, i, side);
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], e = hw + (side > 0 ? EL(i) : ER(i)) - 0.05;
      if (!gp || gp.g < 0.05) { prev = false; continue; }
      const o = e + gp.g / 2 + 0.1, zz = Math.min(z, (z + gp.z) / 2) - 0.015;
      if (GAP_LOG && GAP_LOG.n < 12 && gp.g > 1) { GAP_LOG.n++; console.log('[test] gap ' + w.gid + ' ' + i + ' g ' + gp.g.toFixed(1) + ' at ' + x.toFixed(0) + ',' + y.toFixed(0) + ',' + z.toFixed(1)); }
      const a = [x + nx[i] * side * e, y + ny[i] * side * e, zz], b = [x + nx[i] * side * o, y + ny[i] * side * o, zz];
      fs.add(side > 0 ? [b, a] : [a, b], prev);
      prev = true;
    }
  }
  // 紐澤西護欄 (左右；分合流處落在別條路面上的段落不放；隧道內是檢修步道，不放)
  if (!w.tunnel) for (const [edge, inward, bit] of [[hw, -1, 1], [-hw, 1, 2]]) {
    const o = edge + inward * BARRIER_INSET;
    // 護欄中心 (左法向偏移): 國道主線左邊 = 中央護欄 (w.bc)、右邊 = 加寬後路緣往內 0.35 m
    const oAt = (i) => w.bc ? (bit === 1 ? w.bc[i] : -(hw + ER(i)) + BARRIER_INSET) : o;
    // 共用的中央護欄 (左邊有對向路面) 只由 gid 小的那一條建
    const notMine = (i) => bit === 1 && PR(i) && w.oppL[i] && w.oppL[i].gid < w.gid;
    const bar = new Strip(B, 'barrier', BAR_PAIRS);
    // 斷面位置: 每個節點 + 門架降低段的前後 (降低段 ±BAR_NOTCH，兩端 BAR_RAMP 斜坡)
    const notch = bit === 1 ? barrierNotches(w) : [], LF = BAR_LOW / 0.87;
    const hf = (d) => { let f = 1; for (const c of notch) { const e = Math.abs(d - c); if (e < BAR_NOTCH + BAR_RAMP) f = Math.min(f, e <= BAR_NOTCH ? LF : LF + (1 - LF) * (e - BAR_NOTCH) / BAR_RAMP); } return f; };
    const st = [];
    for (let i = 0; i < n; i++) st.push([s[i], i]);
    for (const c of notch) for (const dd of [-BAR_NOTCH - BAR_RAMP, -BAR_NOTCH, BAR_NOTCH, BAR_NOTCH + BAR_RAMP]) { const d = c + dd; if (d > 0.05 && d < s[n - 1] - 0.05) st.push([d, -1]); }
    st.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const segOk = (k) => !((M[k] | M[k + 1]) & bit) && !(notMine(k) && notMine(k + 1));
    let k = 0;
    for (let q = 0; q < st.length; q++) {
      const [d, node] = st[q];
      while (k < n - 2 && s[k + 1] < d) k++;
      let cx, cy, cz, nnx, nny, ok;
      if (node >= 0) { const oi = oAt(node); nnx = nx[node]; nny = ny[node]; cx = P[node * 3] + nnx * oi; cy = P[node * 3 + 1] + nny * oi; cz = P[node * 3 + 2]; ok = node > 0 && segOk(node - 1); }
      else {
        const t = Math.min(1, Math.max(0, (d - s[k]) / ((s[k + 1] - s[k]) || 1))), a = oAt(k), b = oAt(k + 1);
        nnx = nx[k] + (nx[k + 1] - nx[k]) * t; nny = ny[k] + (ny[k + 1] - ny[k]) * t; const nl = Math.hypot(nnx, nny) || 1; nnx /= nl; nny /= nl;
        cx = P[k * 3] + nx[k] * a + (P[k * 3 + 3] + nx[k + 1] * b - P[k * 3] - nx[k] * a) * t;
        cy = P[k * 3 + 1] + ny[k] * a + (P[k * 3 + 4] + ny[k + 1] * b - P[k * 3 + 1] - ny[k] * a) * t;
        cz = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t; ok = q > 0 && segOk(k);
      }
      const f = notch.length ? hf(d) : 1, verts = [];
      for (let j = 0; j < BARRIER.length - 1; j++) for (const [a, h] of [BARRIER[j], BARRIER[j + 1]]) verts.push([cx + nnx * a, cy + nny * a, cz + h * f - 0.03, d, h * f]);
      bar.add(verts, ok);
    }
    const nearNotch = (d, r) => notch.some((c) => Math.abs(d - c) < r);
    // 防眩板: 中央分隔護欄頂上每 4 m 一片，板面幾乎垂直路線 (擋對向車燈、側面看得穿)
    if (bit === 1 && !w.link && w.oneway && !params.has('noglare')) {
      let skip = false;
      for (let d = 2, k = 0; d < s[n - 1]; d += 4) {
        const p = along(w, d, k); k = p.k;
        if ((M[k] | M[k + 1]) & bit) continue;
        if (nearNotch(d, BAR_NOTCH + BAR_RAMP + 0.3)) continue;   // 門架立柱那一段沒有防眩板
        if (w.bc) skip = notMine(k);
        else if (((d - 2) / 4) % 10 === 0) {   // 快速道路: 每 40 m 看一次旁邊是不是緊貼著對向路面
          const pr = roadAt(p.x + nx[k] * (hw + 1.6), p.y + ny[k] * (hw + 1.6), p.z, 0, 1.5);
          skip = !!(pr && pr.w !== w && !pr.w.city && Math.abs(pr.z - p.z) < 1.5 && pr.tx * ny[k] + pr.ty * -nx[k] < -0.8 && pr.w.gid < w.gid);
        }
        if (skip) continue;
        const q = oPt(w, oAt, p), x = q.x, y = q.y, a = 0.21;   // 板面轉 12°
        const tx = ny[k] * Math.cos(a) + nx[k] * Math.sin(a), ty = -nx[k] * Math.cos(a) + ny[k] * Math.sin(a), g = B.g('glare', x, y);
        box(g, x, y, tx, ty, 0.022, 0.12, p.z + 0.84, p.z + 1.55);
        box(g, x, y, ny[k], -nx[k], 0.03, 0.03, p.z + 0.8, p.z + 0.9);   // 底座
      }
    }
    // 隔音牆 + 廣告看板: 國道主線外側
    if (bit === 2 && !w.link && w.oneway && !params.has('nowall')) roadside(B, w, oAt, inward);
    // 路燈: 中央分隔島每 40 m 一支雙臂燈
    if (bit === 1 && !w.link && w.oneway && !params.has('nolamps')) {
      for (let d = 2, k = 0; d < s[n - 1]; d += 40) {
        const p = along(w, d, k); k = p.k;
        if ((M[k] | M[k + 1]) & bit) continue;
        if (nearNotch(d, 3.5)) continue;   // 跟門架立柱撞在一起
        if (w.bc) { if (notMine(k)) continue; }
        else {
          const pr = roadAt(p.x + nx[k] * (hw + 1.6), p.y + ny[k] * (hw + 1.6), p.z, 0, 1.5);
          if (pr && pr.w !== w && !pr.w.city && Math.abs(pr.z - p.z) < 1.5 && pr.tx * ny[k] + pr.ty * -nx[k] < -0.8 && pr.w.gid < w.gid) continue;
        }
        const q = oPt(w, oAt, p), x = q.x, y = q.y, z = p.z;
        const lp = B.g('lampPole', x, y), lh = B.g('lampHead', x, y);
        box(lp, x, y, ny[k], -nx[k], 0.09, 0.09, z + 0.85, z + 10.5);
        box(lp, x, y, ny[k], -nx[k], 0.05, 2.0, z + 10.3, z + 10.42);
        for (const sd of [-1, 1]) {
          const lx = x + nx[k] * sd * 1.9, ly = y + ny[k] * sd * 1.9;
          box(lh, lx, ly, ny[k], -nx[k], 0.32, 0.16, z + 10.12, z + 10.3);
          B.chunk(x, y, SUB_P).glows.push(lx, z + 10.05, -ly);
        }
      }
    }
    // 反光片: 外側護欄每 24 m 一支 (黃色圓形稜鏡反光片)，反光面朝來車
    if (bit === 2) for (let d = 12, k = 0; d < s[n - 1]; d += 24) {
      const p = along(w, d, k); k = p.k;
      if ((M[k] | M[k + 1]) & bit) continue;
      const q = oPt(w, oAt, p);
      addReflector(B, q.x, q.y, p.z + 0.87, ny[k], -nx[k]);
    }
  }
  if (w.tunnel) addTunnel(B, w);
}

// ======================================================================= 匝道槽化區 (白色斑馬紋、兩側白實線、橘色導桿、鼻端黃色緩衝桶)
const GORE_MAX = 9;
/** 最近的同向主線 (投影點、左法向、橫向距離)；搜尋周圍 3x3 格 */
function projMainRT(x, y, z, tx, ty) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  let best = null;
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
    const a = GRID.get(cellKey(ix, iy)); if (!a) continue;
    for (let q = 0; q < a.length; q += 2) {
      const w = WAYS[a[q]], i = a[q + 1];
      if (w.link || w.city) continue;
      const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L = Math.hypot(dx, dy);
      if (L < 1e-3) continue;
      const ux = dx / L, uy = dy / L;
      if (ux * tx + uy * ty < 0.7) continue;
      const t = ((x - ax) * ux + (y - ay) * uy) / L;
      if (t < -0.02 || t > 1.02) continue;
      const tc = Math.min(1, Math.max(0, t)), pz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * tc;
      if (Math.abs(pz - z) > 3) continue;
      const px = ax + dx * tc, py = ay + dy * tc, lat = (x - px) * -uy + (y - py) * ux;
      if (!best || Math.abs(lat) < Math.abs(best.lat)) best = { w, i, px, py, pz, nx: -uy, ny: ux, lat };
    }
  }
  return best;
}
function addGore(B, w, r) {
  const { P, n } = w, dir = r.e === 0 ? 1 : -1, side = r.side;
  const G = new Strip(B, 'gore', [[0, 1]]);
  let dist = 0, lastPost = -1e9, drums = false, prevGap = null, prevM = null, gapRow = true;
  for (let k = r.e; k >= 0 && k < n && dist < 450; k += dir) {
    if (k !== r.e) dist += Math.hypot(P[k * 3] - P[(k - dir) * 3], P[k * 3 + 1] - P[(k - dir) * 3 + 1]);
    const m = projMainRT(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], w.ny[k], -w.nx[k]);
    if (!m) break;
    const mE = side < 0 ? rightEdge(m.w, m.i) : m.w.hw;   // 主線那一側的路緣 (右側有加寬的路肩)
    const gap = side * m.lat - mE - w.hw;
    if (side * m.lat <= 0 || (prevGap != null && gap < prevGap - 1.5) || (prevM && m.w !== prevM.w && Math.abs(m.lat - prevM.lat) > 4)) break;   // 找到別條主線: 停
    prevGap = gap; prevM = m;
    if (gap < 0.3) { gapRow = true; continue; }   // 還疊在主線路面上: 槽化區從兩路緣分開的地方才開始
    const ex = m.px + side * m.nx * mE, ey = m.py + side * m.ny * mE, ez = m.pz;
    const lx = P[k * 3] - side * m.nx * w.hw, ly = P[k * 3 + 1] - side * m.ny * w.hw, lz = P[k * 3 + 2];
    const W = Math.max(0, Math.hypot(lx - ex, ly - ey));
    G.add([[ex, ey, ez + 0.01, dist, 0, W, 0], [lx, ly, lz + 0.01, dist, W, W, 0]], !gapRow);
    gapRow = false;
    if (W > 1.2 && dist - lastPost >= 2.5) {   // 導桿: 槽化區中線，每 2.5 m 一支
      lastPost = dist;
      const px = (ex + lx) / 2, py = (ey + ly) / 2, pz = (ez + lz) / 2;
      box(B.g('gpost', px, py), px, py, w.ny[k], -w.nx[k], 0.045, 0.045, pz, pz + 0.75);
      box(B.g('gband', px, py), px, py, w.ny[k], -w.nx[k], 0.05, 0.05, pz + 0.5, pz + 0.62);
    }
    if (gap > GORE_MAX) {   // 鼻端 (護欄開始處) 放三個黃色緩衝桶
      if (!drums) {
        drums = true;
        for (let d = 0; d < 3; d++) {
          const f = (d + 1) / 4, qx = ex + (lx - ex) * f, qy = ey + (ly - ey) * f, qz = ez + (lz - ez) * f;
          box(B.g('drum', qx, qy), qx, qy, w.ny[k], -w.nx[k], 0.42, 0.42, qz, qz + 0.95);
          box(B.g('drumb', qx, qy), qx, qy, w.ny[k], -w.nx[k], 0.43, 0.43, qz + 0.55, qz + 0.68);
        }
      }
      break;
    }
  }
}

// ======================================================================= 伸縮縫 (橋梁接縫): 每座橋墩上方與橋頭各一道；車輪壓過時「叩」一聲
const JGRID = new Map(), JCELL = 50, JSEEN = new Set();
// 伸縮縫 = { x, y: 路中心線上的點, z, tx, ty: 路線方向, hL, hR: 往左 / 往右到路緣 (含加寬的路肩), k: 路段 }
function addJoint(j) {
  const r = Math.max(j.hL, j.hR) + 2;
  for (let cx = Math.floor((j.x - r) / JCELL); cx <= Math.floor((j.x + r) / JCELL); cx++)
    for (let cy = Math.floor((j.y - r) / JCELL); cy <= Math.floor((j.y + r) / JCELL); cy++) {
      const k = cx * 100003 + cy;
      let a = JGRID.get(k); if (!a) JGRID.set(k, a = []); a.push(j);
    }
}
/** 路段 w 第 i 段上、離 (x, y) 最近的中心線點 -> 伸縮縫 (垂直路線、左右到路緣) */
function jointOn(w, i, x, y) {
  setupShoulders(w);
  const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L = Math.hypot(dx, dy) || 1;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
  const lerp = (a) => a ? a[i] + (a[i + 1] - a[i]) * t : 0;
  return { x: ax + dx * t, y: ay + dy * t, z: P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t, tx: dx / L, ty: dy / L, hL: w.hw + lerp(w.eL), hR: w.hw + lerp(w.eR), k: w.k };
}
/** 分區的伸縮縫 (需要鄰區資料)。同一座橋墩撐兩個方向的橋面時，每條各一道 */
function computeJoints(rec) {
  const out = [];
  // 已經有一道幾乎重疊的伸縮縫 (同方向、前後 5 m 內、左右範圍有重疊) 就不再放：
  // 兩方向橋墩錯開幾公尺、匝道疊在主線上、橋頭剛好有橋墩，都會讓同一處出現兩道
  const dup = (j) => {
    const nx = -j.ty, ny = j.tx;
    for (const o of JGRID.get(Math.floor(j.x / JCELL) * 100003 + Math.floor(j.y / JCELL)) || []) {
      if (Math.abs(o.z - j.z) > 1.5) continue;
      const dt = o.tx * j.tx + o.ty * j.ty; if (Math.abs(dt) < 0.9) continue;
      if (Math.abs((o.x - j.x) * j.tx + (o.y - j.y) * j.ty) > 5) continue;
      const c = (o.x - j.x) * nx + (o.y - j.y) * ny, lo = c - (dt > 0 ? o.hR : o.hL), hi = c + (dt > 0 ? o.hL : o.hR);
      if (Math.min(j.hL, hi) - Math.max(-j.hR, lo) > 0.5) return true;
    }
    return false;
  };
  const mk = (j) => {
    const key = j.k + ':' + Math.round(j.x) + ',' + Math.round(j.y);
    if (JSEEN.has(key)) return;
    JSEEN.add(key);
    if (dup(j)) { JSTAT.dup++; return; }
    JSTAT.placed++; out.push(j); addJoint(j);
  };
  const A = rec.piers;
  for (let k = 0; k < A.length / 9; k++) {   // 橋墩上方: 帽梁上的每一條橋面
    const x = A[k * 9], y = A[k * 9 + 1], top = A[k * 9 + 6], cells = new Set(), best = new Map();
    for (const [ox, oy] of [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]]) cells.add(cellKey(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL)));
    for (const c of cells) {
      const a = GRID.get(c); if (!a) continue;
      for (let q = 0; q < a.length; q += 2) {
        const w = WAYS[a[q]], i = a[q + 1];
        if (w.city || w.tunnel) continue;
        const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L2 = dx * dx + dy * dy;
        if (L2 < 1e-6) continue;
        const t = ((x - ax) * dx + (y - ay) * dy) / L2; if (t < 0 || t > 1) continue;
        const lat = Math.abs(((x - ax) * -dy + (y - ay) * dx) / Math.sqrt(L2)), z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
        if (Math.abs(z - (top + 2.2)) > 1.5 || lat > w.hw + 16) continue;   // 在這座帽梁上
        if (w.M && (w.M[i] & 4)) continue;                                    // 匝道整段疊在主線路面內
        // 路線中心要落在帽梁範圍內 (只撐另一個方向的橋墩不算)
        const pnx = -A[k * 9 + 3], pny = A[k * 9 + 2], sc = (ax + dx * t - x) * pnx + (ay + dy * t - y) * pny;
        const c0 = Math.min(A[k * 9 + 7], A[k * 9 + 8]), c1 = Math.max(A[k * 9 + 7], A[k * 9 + 8]);
        if (sc < c0 - 1.5 || sc > c1 + 1.5) continue;
        const b = best.get(w); if (!b || lat < b.d) best.set(w, { d: lat, i });
      }
    }
    // 主線先放 (重疊時保留主線那一道)
    for (const [w, b] of [...best].sort((p, q) => (p[0].link ? 1 : 0) - (q[0].link ? 1 : 0) || q[0].hw - p[0].hw)) mk(jointOn(w, b.i, x, y));
  }
  for (const k of rec.ways) {             // 橋頭 (橋接地面路段處)
    const w = WAYS[k];
    if (!w.bridge || w.city) continue;
    for (const i of [0, w.n - 1]) {
      const others = PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || [];
      if (!others.some(([o]) => o !== w.k && !WAYS[o].bridge)) continue;
      mk(jointOn(w, Math.min(i, w.n - 2), w.P[i * 3], w.P[i * 3 + 1]));
    }
  }
  return out;
}
function addJoints(B, list) {
  for (const j of list) {
    const nx = -j.ty, ny = j.tx, half = (j.hL + j.hR) / 2 - 0.25, off = (j.hL - j.hR) / 2, cx = j.x + nx * off, cy = j.y + ny * off;
    const st = B.g('jsteel', cx, cy), rb = B.g('jrubber', cx, cy);
    box(st, cx + j.tx * 0.17, cy + j.ty * 0.17, j.tx, j.ty, 0.12, half, j.z - 0.03, j.z + 0.012);
    box(st, cx - j.tx * 0.17, cy - j.ty * 0.17, j.tx, j.ty, 0.12, half, j.z - 0.03, j.z + 0.012);
    box(rb, cx, cy, j.tx, j.ty, 0.05, half, j.z - 0.03, j.z + 0.004);
  }
}
/** 車軸從 (ax,ay) 移到 (bx,by) 時有沒有壓過伸縮縫 (左右範圍分開算) */
function crossedJoint(ax, ay, bx, by, z) {
  const a = JGRID.get(Math.floor(bx / JCELL) * 100003 + Math.floor(by / JCELL));
  if (!a) return false;
  for (const j of a) {
    if (Math.abs(z - j.z) > 1.5) continue;
    const d0 = (ax - j.x) * j.tx + (ay - j.y) * j.ty, d1 = (bx - j.x) * j.tx + (by - j.y) * j.ty;
    if (d0 * d1 > 0 || d0 === d1) continue;
    const lat = (bx - j.x) * -j.ty + (by - j.y) * j.tx;
    if (lat <= j.hL && -lat <= j.hR) return true;
  }
  return false;
}

// ======================================================================= 橋墩
/** 橋墩 (前處理已避開下層道路): 柱子可能往側邊偏移，帽梁延伸過去撐住橋面 */
function addPier(B, A, k) {
  let [x, y, tx, ty, offL, zg, top, capL, capR] = A.subarray(k * 9, k * 9 + 9);
  const nx = -ty, ny = tx, g = B.g('pier', x, y);
  box(g, x + nx * offL, y + ny * offL, tx, ty, 1.0, 1.25, zg - 1.0, top - 1.4);   // 柱
  // 國道路肩加寬後橋面變寬: 帽梁兩端跟著加長 (橋墩方向可能跟路線相反)
  const r = roadAt(x, y, top + 0.2, -3, 1.0);
  if (r && r.w.eL) {
    const same = r.w.nx[r.i] * nx + r.w.ny[r.i] * ny > 0, eL = r.w.eL[r.i], eR = r.w.eR[r.i];
    if (capL > capR) [capL, capR] = [capR, capL];
    capR += same ? eL : eR; capL -= same ? eR : eL;
  }
  const mid = (capL + capR) / 2;
  box(g, x + nx * mid, y + ny * mid, tx, ty, 0.9, (capR - capL) / 2, top - 1.4, top);   // 帽梁
}

// ======================================================================= 隧道
const isTunnelEnd = (w, i) => !(PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || []).some(([k]) => k !== w.k && WAYS[k].tunnel);
/** 隧道內壁斷面 [橫向 (左正), 高度]：路緣 → 檢修步道 → 直牆 2.9 m → 橢圓拱頂 (頂高 7.2 m) → 另一側 */
function tunnelProfile(hw) {
  const a = hw + 0.9, H = 7.2, Hw = 2.9, out = [[-hw, 0], [-hw, 0.25], [-a, 0.25], [-a, Hw]];
  for (let j = 1; j < 20; j++) { const t = Math.PI * j / 20; out.push([-Math.cos(t) * a, Hw + Math.sin(t) * (H - Hw)]); }
  out.push([a, Hw], [a, 0.25], [hw, 0.25], [hw, 0]);
  return { pts: out, a, H, Hw };
}
function addTunnel(B, w) {
  const { P, nx, ny, n, hw, s } = w;
  const { pts, a, H, Hw } = tunnelProfile(hw), M = pts.length;
  const st = new Strip(B, 'tunnel', pts.slice(0, -1).map((_, j) => [j + 1, j]));
  for (let i = 0; i < n; i++) st.add(pts.map(([lat, up]) => [P[i * 3] + nx[i] * lat, P[i * 3 + 1] + ny[i] * lat, P[i * 3 + 2] + up, s[i], up]));
  // 兩排隧道燈 (拱頂兩側 45°)，每 3 m 一盞；消防箱每 51 m 一個 (右側牆面)
  const th = Math.PI / 4, lampLat = Math.sin(th) * a * 0.97, lampUp = Hw + Math.cos(th) * (H - Hw) * 0.97;
  for (let d = 1.5, k = 0; d < s[n - 1]; d += 3) {
    const p = along(w, d, k); k = p.k;
    for (const sd of [-1, 1]) { const lx = p.x + nx[k] * lampLat * sd, ly = p.y + ny[k] * lampLat * sd; box(B.g('tlight', lx, ly), lx, ly, ny[k], -nx[k], 0.6, 0.16, p.z + lampUp - 0.08, p.z + lampUp + 0.04); }
    if (Math.round(d / 3) % 17 === 0) {
      const cx = p.x - nx[k] * (a - 0.09), cy = p.y - ny[k] * (a - 0.09);
      box(B.g('tcab', cx, cy), cx, cy, ny[k], -nx[k], 0.4, 0.09, p.z + 0.85, p.z + 1.85);
    }
  }
  for (const i of [0, n - 1]) if (isTunnelEnd(w, i)) B.chunk(P[i * 3], P[i * 3 + 1]).extra.push(portalMesh(w, i));
}
/** 隧道洞口 (照國道 3 號街景): 外凸的拱形遮罩、上方弧形鐵欄杆、兩側白底彩色波浪擋土牆 */
function portalMesh(w, i) {
  const { pts, a, H } = tunnelProfile(w.hw);
  const LH = 3.5, T0 = 0.7, kx = (a + T0) / a, ky = (H + T0) / H;
  const outer = pts.map(([l, u]) => [l * (Math.abs(l) > w.hw + 0.5 ? kx : 1), u * ky]);
  // 區域座標: GB.v(橫向, -外推距離, 高度) -> three (橫向, 高度, 外推)
  const g = new GB(), M = pts.length;
  const ring = (P, zl) => { const b = g.n; for (const [l, u] of P) g.v(l, -zl, u); return b; };
  const i0 = ring(pts, 0), i1 = ring(pts, LH), o0 = ring(outer, -0.4), o1 = ring(outer, LH);
  for (let j = 0; j < M - 1; j++) {
    g.q(i0 + j, i1 + j, i1 + j + 1, i0 + j + 1);
    g.q(o0 + j, o0 + j + 1, o1 + j + 1, o1 + j);
    g.q(i1 + j, o1 + j, o1 + j + 1, i1 + j + 1);
  }
  const grp = new T.Group();
  grp.add(g.mesh(matConcrete, { cast: true }));
  // 擋土牆 (梯形，中間挖遮罩的外形)
  const W = a + 10, sh = new T.Shape();
  sh.moveTo(-W, -1.5); sh.lineTo(W, -1.5); sh.lineTo(W, 4.4); sh.lineTo(a + 1.5, H + 2.4); sh.lineTo(-(a + 1.5), H + 2.4); sh.lineTo(-W, 4.4); sh.lineTo(-W, -1.5);
  const hole = new T.Path();
  hole.moveTo(outer[0][0], -0.2);
  for (const [l, u] of outer) hole.lineTo(l, Math.max(u, -0.2));
  hole.lineTo(outer[0][0], -0.2);
  sh.holes.push(hole);
  const fg = new T.ExtrudeGeometry(sh, { depth: 1.0, bevelEnabled: false, curveSegments: 4 });
  fg.translate(0, 0, -1.0);
  const face = new T.Mesh(fg, matConcrete); face.castShadow = face.receiveShadow = true; face.matrixAutoUpdate = false; grp.add(face);
  // 兩側翼牆: 沿道路往外 28 m，洞口處 5 m 高、往外降到 1 m；內面畫彩色波浪；牆底接到地面
  const ww = new GB('uv'), WL = 28, steps = 14, hAt = (zl) => Math.max(1.0, 5.0 - 4.0 * zl / WL);
  const px0 = w.P[i * 3], py0 = w.P[i * 3 + 1], pz0 = w.P[i * 3 + 2], sg = i === 0 ? -1 : 1;
  const Xd = [w.nx[i] * sg, w.ny[i] * sg], Zd = [w.ny[i] * sg, -w.nx[i] * sg];
  const baseAt = (lat, zl) => Math.min(-0.3, terrainAt(px0 + Xd[0] * lat + Zd[0] * zl, py0 + Xd[1] * lat + Zd[1] * zl) - pz0 - 0.5);
  for (const sd of [-1, 1]) {
    const xi = sd * (a + 0.15), xo = sd * (a + 0.7);
    const strip = (x, f, z0) => {
      const b = ww.n;
      for (let k = 0; k <= steps; k++) { const zl = WL * k / steps, h = hAt(zl); ww.v(x, -zl, Math.max(z0, baseAt(x, zl))); ww.uv.push(f, h); ww.v(x, -zl, h); ww.uv.push(f, h); }
      return b;
    };
    const fi = strip(xi, 1, -60), fo = strip(xo, 0, -60);
    for (let k = 0; k < steps; k++) {
      ww.q(fi + k * 2, fi + k * 2 + 2, fi + k * 2 + 3, fi + k * 2 + 1);
      ww.q(fo + k * 2, fo + k * 2 + 1, fo + k * 2 + 3, fo + k * 2 + 2);
      ww.q(fi + k * 2 + 1, fi + k * 2 + 3, fo + k * 2 + 3, fo + k * 2 + 1);
    }
    const e = steps * 2;
    ww.q(fi + e, fo + e, fo + e + 1, fi + e + 1);
  }
  const wing = ww.mesh(matPortal, { cast: true }); if (wing) grp.add(wing);
  // 弧形欄杆: 沿遮罩前端頂部，立柱每 1.1 m、上下兩根橫桿
  const r = new GB(), arch = outer.filter(([, u]) => u > H * 0.55);
  const post = (l, u, zl) => box(r, l, -zl, 1, 0, 0.025, 0.025, u, u + 1.05);
  const beam = (p, q, zl, dz) => {
    const dl = q[0] - p[0], du = q[1] - p[1], L = Math.hypot(dl, du) || 1, nl = -du / L * 0.022, nu = dl / L * 0.022, b = r.n;
    for (const aa of [p, q]) for (const [sl, su, sz] of [[1, 1, 1], [-1, -1, 1], [-1, -1, -1], [1, 1, -1]]) r.v(aa[0] + nl * sl, -(zl + 0.022 * sz), aa[1] + dz + nu * su);
    for (let f = 0; f < 4; f++) { const f2 = (f + 1) % 4; r.q(b + f, b + f2, b + 4 + f2, b + 4 + f); }
  };
  const zl = LH - 0.3;
  let acc = 1e9;
  for (let j = 0; j < arch.length; j++) {
    if (j > 0) { acc += Math.hypot(arch[j][0] - arch[j - 1][0], arch[j][1] - arch[j - 1][1]); beam(arch[j - 1], arch[j], zl, 1.0); beam(arch[j - 1], arch[j], zl, 0.5); }
    if (acc > 1.1) { post(arch[j][0], arch[j][1], zl); acc = 0; }
  }
  const rail = r.mesh(matRail, { cast: true }); if (rail) grp.add(rail);
  // 擺到洞口: 外推方向 = 離開隧道的方向
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2];
  const Z = new T.Vector3(w.ny[i] * sg, 0, w.nx[i] * sg), Y = new T.Vector3(0, 1, 0), X = new T.Vector3().crossVectors(Y, Z);
  const mtx = new T.Matrix4().makeBasis(X, Y, Z); mtx.setPosition(x, z, -y);
  grp.matrixAutoUpdate = false; grp.matrix.copy(mtx);
  return grp;
}

// ======================================================================= 一般道路
/** 鋪在地形上的路面 (市區標線由材質依 aLs=路寬、aLanes=車道代碼 算出)；橋梁加梁身與橋墩 */
function addCityRoad(B, w) {
  const { P, nx, ny, s, n, hw } = w;
  const code = w.cls === 5 ? 0 : (w.oneway ? w.lanes : -w.lanes);   // 0: 巷道無標線；負: 雙向 (中央雙黃線)
  // 路口: 跟別條市區道路共用節點的地方，交叉路面範圍內不畫標線 (舊版標線會一路畫穿路口、兩條路的線疊在一起)；
  // 次要道路在路口內往下 3 cm，避免兩條路面在路口閃爍
  const zones = [];
  for (let i = 0; i < n; i++) {
    let rr = 0, rz = 0, minor = false;
    const hit = (o) => {
      rr = Math.max(rr, o.hw + 0.8); rz = Math.max(rz, o.hw - 0.4);
      if (o.width > w.width + 0.01 || (Math.abs(o.width - w.width) <= 0.01 && o.gid < w.gid)) minor = true;
    };
    const seenO = new Set();
    for (const [k] of PT_INDEX.get(ptKey(P[i * 3], P[i * 3 + 1])) || []) { const o = WAYS[k]; if (o && o !== w && o.city) { seenO.add(o); hit(o); } }
    // 沒有共用節點的交叉 (OSM 偶爾沒接上): 別條市區道路的中心線從這個節點旁邊斜斜穿過
    const x0 = P[i * 3], y0 = P[i * 3 + 1], z0 = P[i * 3 + 2], tx0 = i < n - 1 ? P[i * 3 + 3] - x0 : x0 - P[i * 3 - 3], ty0 = i < n - 1 ? P[i * 3 + 4] - y0 : y0 - P[i * 3 - 2], tl = Math.hypot(tx0, ty0) || 1;
    for (let cx = Math.floor((x0 - 20) / CELL); cx <= Math.floor((x0 + 20) / CELL); cx++) for (let cy = Math.floor((y0 - 20) / CELL); cy <= Math.floor((y0 + 20) / CELL); cy++) {
      const a = GRID.get(cellKey(cx, cy)); if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const o = WAYS[a[j]], si = a[j + 1]; if (!o || o === w || !o.city || seenO.has(o)) continue;
        const ax = o.P[si * 3], ay = o.P[si * 3 + 1], dx = o.P[si * 3 + 3] - ax, dy = o.P[si * 3 + 4] - ay, L = Math.hypot(dx, dy); if (L < 0.5) continue;
        if (Math.abs((dx * tx0 + dy * ty0) / (L * tl)) > 0.8) continue;   // 平行的不算
        const t = Math.min(1, Math.max(0, ((x0 - ax) * dx + (y0 - ay) * dy) / (L * L)));
        if (Math.hypot(ax + dx * t - x0, ay + dy * t - y0) > o.hw + 0.5) continue;
        if (Math.abs(o.P[si * 3 + 2] + (o.P[si * 3 + 5] - o.P[si * 3 + 2]) * t - z0) > 1.5) continue;
        seenO.add(o); hit(o);
      }
    }
    if (rr > 0) zones.push({ c: s[i], r: Math.min(rr, 25), rz: Math.min(Math.max(rz, 0), 24), minor });
  }
  // 雙向分隔的道路在路口會有兩個交點，中間那一小段 (路口中央) 也不畫標線: 相距不到 12 m 的路口範圍合併
  const iv = zones.map((q) => [q.c - q.r, q.c + q.r]).sort((a, b) => a[0] - b[0]), mark = [];
  for (const v of iv) { const L = mark[mark.length - 1]; if (L && v[0] - L[1] < 12) L[1] = Math.max(L[1], v[1]); else mark.push(v.slice()); }
  const inZone = (d) => mark.some((v) => d >= v[0] && d <= v[1]);
  const sunk = (d) => zones.some((q) => q.minor && Math.abs(d - q.c) <= q.rz);   // 下沉段的高低差藏在主要道路路面底下
  const st = [];
  for (let i = 0; i < n; i++) st.push([s[i], i]);
  for (const q of zones) for (const e of [-q.rz - 0.02, -q.rz, q.rz, q.rz + 0.02]) { const d = q.c + e; if (d > 0.01 && d < s[n - 1] - 0.01) st.push([d, -1]); }
  for (const v of mark) for (const d of [v[0] - 0.02, v[0], v[1], v[1] + 0.02]) if (d > 0.01 && d < s[n - 1] - 0.01) st.push([d, -1]);
  st.sort((a, b) => a[0] - b[0]);
  const r = new Strip(B, 'city', [[0, 1]]);
  let k = 0;
  for (const [d, node] of st) {
    while (k < n - 2 && s[k + 1] < d) k++;
    let x, y, z, ux, uy;
    if (node >= 0) { x = P[node * 3]; y = P[node * 3 + 1]; z = P[node * 3 + 2]; ux = nx[node]; uy = ny[node]; }
    else {
      const t = Math.min(1, Math.max(0, (d - s[k]) / ((s[k + 1] - s[k]) || 1)));
      x = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t; y = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t; z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
      ux = nx[k] + (nx[k + 1] - nx[k]) * t; uy = ny[k] + (ny[k + 1] - ny[k]) * t; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
    }
    const cd = zones.length && inZone(d) ? 0 : code, zz = zones.length && sunk(d) ? z - 0.03 : z;
    r.add([[x + ux * hw, y + uy * hw, zz, 0, d, w.width, cd], [x - ux * hw, y - uy * hw, zz, w.width, d, w.width, cd]]);
  }
  if (!w.bridge) return;
  const depth = 1.6, sl = new Strip(B, 'skirt', [[1, 0]]), sr = new Strip(B, 'skirt', [[0, 1]]), sb = new Strip(B, 'skirt', [[1, 0]]);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], lx = x + nx[i] * hw, ly = y + ny[i] * hw, rx = x - nx[i] * hw, ry = y - ny[i] * hw;
    sl.add([[lx, ly, z], [lx, ly, z - depth]]); sr.add([[rx, ry, z], [rx, ry, z - depth]]); sb.add([[lx, ly, z - depth], [rx, ry, z - depth]]);
  }
  for (let d = 15, k = 0; d < s[n - 1] - 5; d += 30) {
    while (k < n - 2 && s[k + 1] < d) k++;
    const x = P[k * 3], y = P[k * 3 + 1], top = P[k * 3 + 2] - depth, g = terrainAt(x, y);
    if (top - g > 3) box(B.g('pier', x, y), x, y, ny[k], -nx[k], 0.7, Math.min(hw * 0.6, 3), g - 1, top);
  }
}

// ======================================================================= 3D 建築: 依 OSM 高度擠出；牆面 UV (沿周長 m, 高度 m, 總高) 給窗戶材質用
const FACADE = [[0.45, 0.40, 0.32], [0.42, 0.42, 0.40], [0.55, 0.54, 0.50], [0.28, 0.19, 0.13], [0.30, 0.30, 0.29], [0.48, 0.37, 0.33], [0.25, 0.29, 0.33]];
const R_BLD = (MOBILE ? 1600 : 4500) + 700;
function* buildBuildings(bld, out) {
  const { bxy, bbase, bh, bcnt, bcol, nb } = bld;
  const chunks = new Map(), CHB = 1000;
  let o = 0;
  for (let b = 0; b < nb; b++) {
    const n = bcnt[b], base = bbase[b], top = base + bh[b], col = FACADE[bcol[b]];
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bxy[(o + i) * 2]; cy += bxy[(o + i) * 2 + 1]; }
    cx /= n; cy /= n;
    const key = Math.floor(cx / CHB) + ',' + Math.floor(cy / CHB);
    let c = chunks.get(key);
    if (!c) chunks.set(key, c = { x: (Math.floor(cx / CHB) + 0.5) * CHB, y: (Math.floor(cy / CHB) + 0.5) * CHB, wp: [], wuv: [], wcol: [], wi: [], rp: [], rcol: [], ri: [] });
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = bxy[(o + i) * 2], ay = bxy[(o + i) * 2 + 1], bx = bxy[(o + j) * 2], by = bxy[(o + j) * 2 + 1], L = Math.hypot(bx - ax, by - ay);
      const v0 = c.wp.length / 3;
      c.wp.push(ax, base, -ay, bx, base, -by, bx, top, -by, ax, top, -ay);
      c.wuv.push(per, 0, bh[b], per + L, 0, bh[b], per + L, bh[b], bh[b], per, bh[b], bh[b]);
      for (let q = 0; q < 4; q++) c.wcol.push(col[0], col[1], col[2]);
      c.wi.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      per += L;
    }
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new T.Vector2(bxy[(o + i) * 2], bxy[(o + i) * 2 + 1]));
    const tris = T.ShapeUtils.triangulateShape(contour.slice(), []);
    const r0 = c.rp.length / 3;
    for (let i = 0; i < n; i++) { c.rp.push(contour[i].x, top, -contour[i].y); c.rcol.push(col[0] * 0.6, col[1] * 0.6, col[2] * 0.6); }
    for (const t of tris) c.ri.push(r0 + t[0], r0 + t[2], r0 + t[1]);
    o += n;
    if ((b & 255) === 255) yield;
  }
  const mk = (p, idx, attrs, mat) => {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(p, 3));
    for (const [k, v, sz] of attrs) g.setAttribute(k, new T.Float32BufferAttribute(v, sz));
    g.setIndex(p.length / 3 > 65535 ? new T.Uint32BufferAttribute(idx, 1) : new T.Uint16BufferAttribute(idx, 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new T.Mesh(g, mat); m.castShadow = false; m.receiveShadow = true; m.matrixAutoUpdate = false;
    return m;
  };
  for (const c of chunks.values()) {
    out.push({ x: c.x, y: c.y, r: CHB * 0.75, kind: 'bld', meshes: [mk(c.wp, c.wi, [['aUv3', c.wuv, 3], ['aCol', c.wcol, 3]], matWall), mk(c.rp, c.ri, [['aCol', c.rcol, 3]], matRoof)], cast: true });
    yield;
  }
}

// ======================================================================= 工作排程: 建模分段做，每幀最多 BUDGET_MS
const BUDGET_MS = +(params.get('budget') || (MOBILE ? 3 : 5));
const JOBS = [];   // { gen, prio }
function addJob(gen, prio = 0) { JOBS.push({ gen, prio }); JOBS.sort((a, b) => a.prio - b.prio); }
function runJobs(budget = BUDGET_MS) {
  const t0 = performance.now();
  while (JOBS.length && performance.now() - t0 < budget) {
    const j = JOBS[0];
    if (j.gen.next().done) JOBS.shift();
  }
}
/** 立刻做完所有排隊的建模 (起點、傳送) */
function flushJobs() { while (JOBS.length) { const j = JOBS.shift(); while (!j.gen.next().done); } }

// ======================================================================= 分區串流
// 車子附近: 先下載資料 (DATA_R)，鄰近 8 區的資料都到了才建模型 (MESH_R)，遠了丟掉模型 (資料留著，回來不用重下載)
const MESH_R = +(params.get('meshr') || (MOBILE ? 4200 : 7000));
const DATA_R = MESH_R + TS * 1.45;
const TERR_R = +(params.get('terrr') || (MOBILE ? 9000 : 18000));
const TILES = new Map();                       // 細節分區 key -> { key, tx, ty, state, ways, piers, bld, linked, joints, group, chunks, building }
const TERR_REC = new Map();                    // 地形分區 key -> { state, mesh, lod, building, ortho }
let inflight = 0;
const worldGroup = new T.Group();
scene.add(worldGroup);
function tileDist(tx, ty, x, y) {
  const cx = Math.min(Math.max(x, tx * TS), (tx + 1) * TS), cy = Math.min(Math.max(y, ty * TS), (ty + 1) * TS);
  return Math.hypot(x - cx, y - cy);
}
/** 半徑 R 內的分區 [[key, tx, ty, 距離]]，由近到遠 */
function tilesNear(x, y, R) {
  const out = [];
  for (let tx = Math.floor((x - R) / TS); tx <= Math.floor((x + R) / TS); tx++)
    for (let ty = Math.floor((y - R) / TS); ty <= Math.floor((y + R) / TS); ty++) {
      const d = tileDist(tx, ty, x, y);
      if (d <= R) out.push([tkey(tx, ty), tx, ty, d]);
    }
  return out.sort((a, b) => a[3] - b[3]);
}
function whenBuf(kind, key, onOk, onErr) {
  let b;
  try { b = tileBuf(kind, key); } catch (e) { onErr(e); return null; }
  if (b instanceof ArrayBuffer) { onOk(b); return null; }
  inflight++;
  return b.then(onOk, onErr).finally(() => { inflight--; });
}
function requestDetail(key, tx, ty) {
  if (TILES.has(key) || !INDEX.detail[key]) return null;
  const rec = { key, tx, ty, state: 'loading', ways: [], piers: new Float32Array(0), bld: null, linked: false, joints: [], group: null, chunks: [], building: false };
  TILES.set(key, rec);
  return whenBuf('d', key, (buf) => {
    Object.assign(rec, ingestDetail(buf));
    rec.state = 'data';
    // 有隧道: 周圍已建好的地形網格重建 (挖掉穿進隧道的山坡)
    if (rec.ways.some((k) => WAYS[k].tunnel)) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const tr = TERR_REC.get(tkey(tx + dx, ty + dy));
      if (tr) tr.dirty = true;
    }
    for (const f of HOOKS.tile) f(rec);
  }, (e) => { console.warn('分區載入失敗', key, e); setTimeout(() => TILES.delete(key), 3000); });
}
function requestTerrain(key) {
  if (TERR_REC.has(key) || !INDEX.tiles_t[key]) return null;
  const rec = { state: 'loading', mesh: null, lod: -1, building: false, ortho: null };
  TERR_REC.set(key, rec);
  return whenBuf('t', key, (buf) => {
    TERR.set(key, new Int16Array(buf, 0, TN * TN));
    if (buf.byteLength >= TN * TN * 3) LCLS.set(key, new Uint8Array(buf, TN * TN * 2, TN * TN));   // 地表分類 (scripts/landcover.py)
    rec.state = 'data';
  }, (e) => { console.warn('地形載入失敗', key, e); setTimeout(() => TERR_REC.delete(key), 3000); });
}
function neighborsReady(rec) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const k = tkey(rec.tx + dx, rec.ty + dy);
    if (!INDEX.detail[k]) continue;
    const r = TILES.get(k);
    if (!r || r.state !== 'data') return false;
  }
  return true;
}
function disposeObj(o) {
  if (o.parent) o.parent.remove(o);
  o.traverse((q) => { if (q.geometry) q.geometry.dispose(); });
}
/** 一個細節分區的模型 (產生器: 每條路段之間可以暫停) */
function* buildTile(rec) {
  const B = new Build();
  for (const k of rec.ways) {
    const w = WAYS[k];
    if (w.city) { if (!params.has('nocr')) addCityRoad(B, w); }
    else { addRoad(B, w); if (w.ramps && !params.has('nogore')) for (const r of w.ramps) addGore(B, w, r); }
    yield;
  }
  for (let k = 0; k < rec.piers.length / 9; k++) addPier(B, rec.piers, k);
  addJoints(B, rec.joints);
  yield;
  // 小塊 -> 網格
  const g = new T.Group(), chunks = [];
  for (const c of B.chunks.values()) {
    const ch = { x: c.x, y: c.y, r: c.r, meshes: [], kinds: [], casts: [] };
    for (const [cat, gb] of Object.entries(c.gb)) {
      const [, mat, cast, recv, kind] = CATS[cat];
      let m = gb.mesh(mat(), { cast: false, receive: !!recv });
      if (!m) continue;
      if (cat === 'bboard') withUv(m);
      g.add(m); ch.meshes.push(m); ch.kinds.push(kind); ch.casts.push(!!cast);
    }
    if (c.glows.length) {
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.Float32BufferAttribute(c.glows, 3)); pg.computeBoundingSphere();
      const pts = new T.Points(pg, GLOW_LAMP); pts.matrixAutoUpdate = false; g.add(pts); ch.meshes.push(pts); ch.kinds.push('lamp'); ch.casts.push(false);
    }
    for (const e of c.extra) { g.add(e); ch.meshes.push(e); ch.kinds.push('base'); ch.casts.push(false); e.traverse((q) => { if (q.isMesh) q.castShadow = false; }); }
    chunks.push(ch);
    yield;
  }
  if (rec.bld && !params.has('nobld')) yield* buildBuildings(rec.bld, chunks);
  for (const ch of chunks) if (ch.kind === 'bld') for (const m of ch.meshes) g.add(m);
  g.matrixAutoUpdate = false;
  worldGroup.add(g);
  rec.group = g; rec.chunks = chunks; rec.building = false;
  visClock = 0;   // 新模型馬上套用顯示距離
}

// ---- 地形 (三級解析度: 30 / 60 / 120 m；分區邊緣加 20 m 深的裙邊蓋住不同解析度之間的縫)
const LOD_D = MOBILE ? [1800, 4500] : [2500, 6500];
const lodFor = (d) => d < LOD_D[0] ? 0 : d < LOD_D[1] ? 1 : 2;
function* buildTerrain(key, tx, ty, lod) {
  const a = TERR.get(key);
  const ja = Math.max(tx * TC, TGI.J0), jb = Math.min(tx * TC + TC, TGI.J0 + TGI.w - 1);
  const ia = Math.max(ty * TC, TGI.I0), ib = Math.min(ty * TC + TC, TGI.I0 + TGI.h - 1);
  if (!a || jb <= ja || ib <= ia) return null;
  const st = 1 << lod;
  const hh = (I, J) => Z16(a[(I - ty * TC + 1) * TN + (J - tx * TC + 1)]);
  const lc = LCLS.get(key), lcAt = (I, J) => lc ? lc[(I - ty * TC + 1) * TN + (J - tx * TC + 1)] : 0;
  // 格點 (含分區最後一行；步距不整除時最後一格縮短)
  const Js = [], Is = [];
  for (let J = ja; J < jb; J += st) Js.push(J); Js.push(jb);
  for (let I = ia; I < ib; I += st) Is.push(I); Is.push(ib);
  const cols = Js.length, rows = Is.length;
  const g = new GB(); g.nrm = [];
  const W0 = [], W1 = [];
  const vert = (I, J, zOff = 0) => {
    const k = lcAt(I, J), z = hh(I, J);
    W0.push(k === 1 ? 1 : 0, k === 2 ? 1 : 0, k === 3 ? 1 : 0, k === 4 ? 1 : 0);
    W1.push(k === 5 ? 1 : 0, k === 6 ? 1 : 0, k === 7 ? 1 : 0, k === 8 ? 1 : 0);
    const hx = (hh(I, Math.min(J + 1, jb + 1)) - hh(I, Math.max(J - 1, ja - 1))) / (2 * TSTEP), hy = (hh(Math.min(I + 1, ib + 1), J) - hh(Math.max(I - 1, ia - 1), J)) / (2 * TSTEP);
    const L = Math.hypot(hx, hy, 1);
    g.nrm.push(-hx / L, 1 / L, hy / L);
    return g.v(J * TSTEP, I * TSTEP, (k === 1 ? Math.min(z, 0.4) - (z < 0.6 ? 3 : 1.8) : z) + zOff);   // 水底壓低，水面才看得到
  };
  for (const I of Is) for (const J of Js) vert(I, J);
  yield;
  // 隧道口附近山坡比隧道頂還低的方格挖掉 (只有最細的一級要做: 玩家才看得到隧道裡面)
  const inTunnel = (x, y, zt) => { const r = roadAt(x, y, zt + 12, -1.5, 0); return r && r.w.tunnel && zt < r.z + 8.6; };
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const q = i * cols + j, I = Is[i], J = Js[j];
      if (lod === 0) {
        const xc = (J + 0.5) * TSTEP, yc = (I + 0.5) * TSTEP;
        let near = false;
        for (const [px, py] of [[xc, yc], [J * TSTEP, I * TSTEP], [(J + 1) * TSTEP, I * TSTEP], [J * TSTEP, (I + 1) * TSTEP], [(J + 1) * TSTEP, (I + 1) * TSTEP]]) {
          const r = roadAt(px, py, hh(I, J) + 40, -24, 0); if (r && r.w.tunnel) { near = true; break; }
        }
        if (near) {
          let cut = false;
          for (let u = 0; u <= 4 && !cut; u++) for (let v = 0; v <= 4 && !cut; v++) {
            const fu = u / 4, fv = v / 4;
            const zt = (hh(I, J) * (1 - fu) + hh(I, J + 1) * fu) * (1 - fv) + (hh(I + 1, J) * (1 - fu) + hh(I + 1, J + 1) * fu) * fv;
            cut = inTunnel((J + fu) * TSTEP, (I + fv) * TSTEP, zt);
          }
          if (cut) continue;
        }
      }
      g.q(q, q + 1, q + cols + 1, q + cols);
    }
    if ((i & 15) === 15) yield;
  }
  // 裙邊: 四周邊緣往下 20 m (粗細不同的分區接在一起時不會看到縫)
  if (lod > 0) {
    const edge = (list) => {   // list: 邊上的格點 [I, J] (順時針)
      let prevT = -1, prevB = -1;
      for (const [I, J] of list) {
        const t = vert(I, J), b = vert(I, J, -20);
        if (prevT >= 0) g.q(prevT, prevB, b, t);   // 逆時針走一圈，面朝外
        prevT = t; prevB = b;
      }
    };
    edge(Js.map((J) => [ia, J])); edge(Is.map((I) => [I, jb])); edge(Js.slice().reverse().map((J) => [ib, J])); edge(Is.slice().reverse().map((I) => [I, ja]));
  }
  const m = g.mesh(matTerrain);
  m.geometry.setAttribute('aLc0', new T.Float32BufferAttribute(W0, 4));
  m.geometry.setAttribute('aLc1', new T.Float32BufferAttribute(W1, 4));
  m.castShadow = false;
  if (!lc) return m;
  yield;
  // 水面: 碰到水格的方格都畫；水格在原地形高度 (海 = 海平面)，旁邊陸地格壓到地面下 → 岸邊自然切出水線
  const wg = new GB('uv'), idx = new Int32Array(rows * cols).fill(-1);
  const vid = (i, j) => {
    const q = i * cols + j;
    if (idx[q] < 0) {
      const I = Is[i], J = Js[j], z = hh(I, J), water = lcAt(I, J) === 1, sea = z < 0.6;
      idx[q] = wg.v(J * TSTEP, I * TSTEP, water ? (sea ? 0.15 : z - 0.2) : z - 0.8);
      wg.uv.push(sea ? 1 : 0, 0);
    }
    return idx[q];
  };
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
    const I = Is[i], J = Js[j], I2 = Is[i + 1], J2 = Js[j + 1];
    if (lcAt(I, J) !== 1 && lcAt(I, J2) !== 1 && lcAt(I2, J2) !== 1 && lcAt(I2, J) !== 1) continue;
    wg.q(vid(i, j), vid(i, j + 1), vid(i + 1, j + 1), vid(i + 1, j));
  }
  const grp = new T.Group(); grp.add(m);
  const wm = wg.mesh(matWater, { receive: true }); if (wm) grp.add(wm);
  grp.matrixAutoUpdate = false;
  return grp;
}
function* terrainJob(key, tx, ty, r, lod) {
  const gen = buildTerrain(key, tx, ty, lod);
  let res;
  for (;;) { const s = gen.next(); if (s.done) { res = s.value; break; } yield; }
  if (r.mesh && r.mesh !== 'none') disposeObj(r.mesh);
  r.mesh = res || 'none'; r.lod = lod; r.building = false; r.dirty = false;
  if (res) { worldGroup.add(res); if (r.ortho && r.ortho.tex) orthoBind(r, tx, ty); }
}

// ---- 地面正射影像 (國土測繪中心 WMTS，政府資料開放授權，畫面下方標示來源)
// 玩家附近的地形分區各拼一張貼圖；全部圖磚都抓到才換上 (離線、抓不到就維持原本的地表上色)
// 解析度分兩級: 1.5 km 內用 z15 (≈ 4.3 m/像素)，再遠用 z14；手機各低一級。圖片在背景解碼 (createImageBitmap)，不卡畫面
const ORTHO = { on: !params.has('noortho'), zNear: MOBILE ? 14 : 15, zFar: MOBILE ? 13 : 14, nearR: 1500, R: MOBILE ? 5000 : 8000, busy: 0, clock: 0 };
const orthoUrl = (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`;
const terrPart = (m) => (m && m !== 'none') ? (m.isMesh ? m : m.children.find((o) => o.geometry && o.geometry.attributes.aLc0)) : null;
const merc = (lat, lon, z) => { const n = 2 ** z; return [(lon + 180) / 360 * n, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n]; };
let ORTHO_MAT = null;   // 共用一個材質樣板 (著色器只編譯一次)；每塊複製一份換貼圖
function orthoMaterial(tex) {
  if (!ORTHO_MAT) ORTHO_MAT = patch(new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, map: new T.Texture() }), TERRAIN_SPEC);
  const m = ORTHO_MAT.clone(); m.onBeforeCompile = ORTHO_MAT.onBeforeCompile; m.customProgramCacheKey = ORTHO_MAT.customProgramCacheKey; m.map = tex;
  return m;
}
/** 貼圖座標: 分區四角的 Web Mercator 座標雙線性內插 (3.84 km 內誤差 < 1 m) */
function orthoBind(r, tx, ty) {
  const tm = terrPart(r.mesh); if (!tm || !r.ortho || !r.ortho.tex) return;
  const { c, mx0, my0, cols, rows } = r.ortho;
  const x0 = tx * TC * TSTEP, y0 = ty * TC * TSTEP, x1 = x0 + TC * TSTEP, y1 = y0 + TC * TSTEP;
  const p = tm.geometry.attributes.position.array, uv = new Float32Array(p.length / 3 * 2);
  for (let k = 0, q = 0; k < p.length; k += 3, q += 2) {
    const fu = (p[k] - x0) / (x1 - x0), fv = (-p[k + 2] - y0) / (y1 - y0);
    const mx = (c[0][0] * (1 - fu) + c[1][0] * fu) * (1 - fv) + (c[2][0] * (1 - fu) + c[3][0] * fu) * fv;
    const my = (c[0][1] * (1 - fu) + c[1][1] * fu) * (1 - fv) + (c[2][1] * (1 - fu) + c[3][1] * fu) * fv;
    uv[q] = (mx - mx0) / cols; uv[q + 1] = 1 - (my - my0) / rows;
  }
  tm.geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
  tm.material = r.ortho.mat;
}
function orthoApply(r, tx, ty, z) {
  const toLL = window.TWX && TWX.gpsSync && TWX.gpsSync.toLatLon;
  if (!toLL || !r.mesh || r.mesh === 'none') return;
  const prev = r.ortho;
  r.ortho = { loading: true, z }; ORTHO.busy++;
  const x0 = tx * TC * TSTEP, y0 = ty * TC * TSTEP, x1 = x0 + TC * TSTEP, y1 = y0 + TC * TSTEP;
  const c = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => merc(...toLL(x, y), z));
  const mx0 = Math.floor(Math.min(...c.map((p) => p[0]))), mx1 = Math.floor(Math.max(...c.map((p) => p[0])));
  const my0 = Math.floor(Math.min(...c.map((p) => p[1]))), my1 = Math.floor(Math.max(...c.map((p) => p[1])));
  const cols = mx1 - mx0 + 1, rows = my1 - my0 + 1, jobs = [];
  for (let yy = my0; yy <= my1; yy++) for (let xx = mx0; xx <= mx1; xx++)
    jobs.push(fetch(orthoUrl(z, xx, yy)).then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); }).then((b) => createImageBitmap(b)).then((im) => [im, xx - mx0, yy - my0]));
  Promise.all(jobs).then((imgs) => {
    ORTHO.busy--;
    if (!TERR_REC.has(tkey(tx, ty)) || !r.ortho || r.ortho.z !== z) { for (const [im] of imgs) im.close(); return; }
    const cv = document.createElement('canvas'); cv.width = cols * 256; cv.height = rows * 256;
    const g2 = cv.getContext('2d');
    for (const [im, i, j] of imgs) { g2.drawImage(im, i * 256, j * 256); im.close(); }
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const mat = orthoMaterial(tex);
    if (prev && prev.tex) { prev.tex.dispose(); prev.mat.dispose(); }   // 換解析度: 新的換上後才丟舊的
    r.ortho = { tex, mat, z, c, mx0, my0, cols, rows };
    orthoBind(r, tx, ty);
  }).catch((e) => {
    ORTHO.busy--; r.ortho = prev && prev.tex ? prev : { fail: true };
    if ((ORTHO.warned = (ORTHO.warned || 0) + 1) <= 3) console.warn('[ortho] 抓不到正射影像，維持原本地表', e && (e.message || e.type || e));
  });
}
function orthoDrop(r) {
  if (r.ortho && r.ortho.tex) { const tm = terrPart(r.mesh); if (tm) tm.material = matTerrain; r.ortho.tex.dispose(); r.ortho.mat.dispose(); }
  r.ortho = null;
}
function orthoFrame(dt) {
  if (!ORTHO.on || (ORTHO.clock -= dt) > 0) return;
  ORTHO.clock = 0.4;
  const P = S();
  let pick = null, pd = 1e9;   // 一次處理一塊: 挑最近、需要換的
  for (const [key, r] of TERR_REC) {
    if (!r.mesh || r.mesh === 'none') continue;
    const [tx, ty] = key.split('_').map(Number);
    const d = tileDist(tx, ty, P.x, P.y);
    if (d > ORTHO.R + 3000) { if (r.ortho && !r.ortho.loading) orthoDrop(r); continue; }
    if (d >= ORTHO.R || (r.ortho && (r.ortho.loading || r.ortho.fail))) continue;
    const want = d < ORTHO.nearR ? ORTHO.zNear : (r.ortho && r.ortho.z === ORTHO.zNear && d < ORTHO.nearR + 1500) ? ORTHO.zNear : ORTHO.zFar;   // 遲滯
    if ((!r.ortho || r.ortho.z !== want) && d < pd) { pd = d; pick = [r, tx, ty, want]; }
  }
  if (!pick || ORTHO.busy >= 2) return;
  orthoApply(...pick);
}

/** opts: x,y (預設車子位置)；all: 不限同時下載數；build: 'all' 全部建 / false 不建 / 預設排進工作佇列 */
function streamTick(opts = {}) {
  const P = S(), x = opts.x != null ? opts.x : P.x, y = opts.y != null ? opts.y : P.y;
  const proms = [];
  const near = tilesNear(x, y, DATA_R);
  for (const [key, tx, ty] of near) {
    if (inflight >= 6 && !opts.all) break;
    const pr = requestDetail(key, tx, ty); if (pr) proms.push(pr);
  }
  const nearT = tilesNear(x, y, TERR_R);
  for (const [key] of nearT) {
    if (inflight >= 8 && !opts.all) break;
    const pr = requestTerrain(key); if (pr) proms.push(pr);
  }
  // 連接 (鄰區資料都到了): 伸縮縫、國道路肩。測試模式不建模型也要做 (AI、自動駕駛、碰撞都用得到)
  for (const [key] of near) {
    const rec = TILES.get(key);
    if (rec && rec.state === 'data' && !rec.linked && neighborsReady(rec)) { for (const k of rec.ways) setupShoulders(WAYS[k]); rec.joints = computeJoints(rec); rec.linked = true; }   // 路肩先設定，伸縮縫才量得到加寬後的路緣
  }
  if (opts.build !== false) {
    for (const [key, , , d] of near) {
      const rec = TILES.get(key);
      if (!rec || rec.state !== 'data') continue;
      if (rec.linked && !rec.group && !rec.building && d <= MESH_R) { rec.building = true; addJob(buildTile(rec), d); }
    }
    for (const [key, tx, ty, d] of nearT) {
      const r = TERR_REC.get(key);
      if (!r || r.state !== 'data' || r.building) continue;
      const want = lodFor(d);
      // 遲滯: 換級要超過門檻 300 m 才重建 (在邊界附近來回開不會一直重建)
      const keep = r.lod >= 0 && Math.abs(want - r.lod) === 1 && lodFor(d + (want > r.lod ? -300 : 300)) === r.lod;
      if (!r.mesh || r.dirty || (r.lod !== want && !keep)) { r.building = true; addJob(terrainJob(key, tx, ty, r, want), d + (r.mesh ? 2000 : 0)); }
    }
    if (opts.build === 'all') flushJobs();
  }
  // 丟掉遠處的模型
  for (const rec of TILES.values()) if (rec.group && tileDist(rec.tx, rec.ty, x, y) > MESH_R + 1500) { disposeObj(rec.group); rec.group = null; rec.chunks = []; }
  for (const [key, r] of TERR_REC) if (r.mesh && r.mesh !== 'none') {
    const [tx, ty] = key.split('_').map(Number);
    if (tileDist(tx, ty, x, y) > TERR_R + 2500) { orthoDrop(r); disposeObj(r.mesh); r.mesh = null; r.lod = -1; }
  }
  return proms;
}
/** 等 (x,y) 附近的資料到齊、模型建好 (起點與傳送用) */
async function ensureArea(x, y, msg) {
  for (let guard = 0; guard < 10; guard++) {
    const proms = streamTick({ x, y, all: true, build: false });
    if (!proms.length) break;
    if (msg) setStatus(msg);
    await Promise.all(proms);
  }
  streamTick({ x, y, build: 'all' });
}

// ---- 顯示距離與陰影 (每 0.3 秒): 依種類決定小塊顯示與否；只有玩家附近的小塊投射陰影
let visClock = 0;
function visFrame(dt) {
  if ((visClock -= dt) > 0) return;
  visClock = 0.3;
  const P = S();
  for (const rec of TILES.values()) for (const ch of rec.chunks) {
    const d = Math.hypot(ch.x - P.x, ch.y - P.y) - ch.r;
    if (ch.kind === 'bld') {
      const vis = d < R_BLD;
      for (const m of ch.meshes) { m.visible = vis; m.castShadow = vis && d < R_SHADOW; }
      continue;
    }
    for (let k = 0; k < ch.meshes.length; k++) {
      const m = ch.meshes[k];
      m.visible = d < KIND_R[ch.kinds[k]];
      if (ch.casts[k]) m.castShadow = m.visible && d < R_SHADOW;
      else if (m.isGroup) { const c = m.visible && d < R_SHADOW; m.traverse((q) => { if (q.isMesh) q.castShadow = c; }); }
    }
  }
}
let streamClock = 0;
function streamFrame(dt) {
  runJobs();
  if ((streamClock -= dt) > 0) return;
  streamClock = 0.25;
  streamTick();
}
const cullBuildings = visFrame;   // 舊名稱 (drive.js 掛在 frame 上)

// ---- 著色器預先編譯: 每種材質一個看不見的小網格，載入時一起編譯 (開車途中第一次看到才編譯會卡 0.2~1.4 秒)
async function warmShaders(camera) {
  const mats = new Set(Object.values(CATS).map((c) => c[1]()).concat([matWall, matRoof, matTerrain, matWater, matConcrete, matRail, matPortal, orthoMaterial(new T.Texture())]));
  const grp = new T.Group(), geo = new T.BufferGeometry();
  const N = 3, pos = new Float32Array(N * 3), z4 = new Float32Array(N * 4), z3 = new Float32Array(N * 3), z2 = new Float32Array(N * 2), z1 = new Float32Array(N);
  geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(z3.slice(), 3));
  for (const [k, a, s] of [['aUv', z2, 2], ['uv', z2, 2], ['aLs', z1, 1], ['aLanes', z1, 1], ['aLc0', z4, 4], ['aLc1', z4, 4], ['aUv3', z3, 3], ['aCol', z3, 3]]) geo.setAttribute(k, new T.BufferAttribute(a.slice(), s));
  for (const m of mats) for (const cast of [false, true]) { const me = new T.Mesh(geo, m); me.castShadow = cast; me.receiveShadow = true; me.frustumCulled = false; grp.add(me); }
  const pts = new T.Points(geo, GLOW_LAMP); pts.frustumCulled = false; grp.add(pts);
  scene.add(grp);
  try { await renderer.compileAsync(scene, camera); } catch (e) { renderer.compile(scene, camera); }
  scene.remove(grp);
}

Object.assign(TW, { BAR_LOW, TILES, TERR_REC, tilesNear, tileDist, streamTick, streamFrame, ensureArea, orthoFrame, cullBuildings, visFrame, crossedJoint,
  warmShaders, runJobs, flushJobs, worldGroup, box, GB });
})();
