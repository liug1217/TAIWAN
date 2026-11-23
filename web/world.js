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
  ingestDetail, roadAt, TERR, LCLS, landcoverAt, terrainAt, cityAt, HOOKS, BARRIER_INSET, setupShoulders, rightEdge, nextOptions, DIVERGE } = TW;
const { renderer, MOBILE, scene, GLOW_LAMP, patch, TERRAIN_SPEC,
  matLampPole, matSoundWall, matSoundUpper, matSoundPost, matBillboard, matBillboardBack, matLampHead, matAsphalt, matConcrete, matBarrier, matGore,
  matPost, matPostBand, matDrum, matDrumBand, matGlare, matCityRoad, matWall, matRoof, matJointSteel, matJointRubber,
  matReflBlack, matRetro, matTunnelWall, matCabinet, matRail, matPortal, matTunnelLight, matWater, matTerrain, matLeaf, matSoil, matBark } = TW;
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
  kzmarker: ['uv', () => matKzMarker(), 0, 1, 'prop'], kzhedgeC: ['', () => matKzHedgeC(), 1, 1, 'prop'],
  kzpalm: ['uv', () => matPalm(), 1, 1, 'prop'], kzpalmT: ['', () => matPalmTrunk(), 1, 1, 'prop'],
  kzpost: ['', () => matKzPost(), 1, 1, 'mid'], kzgrass: ['', () => matKzGrass(), 0, 1, 'mid'],
  kzlineY: ['', () => matKzLine(true), 0, 1, 'mid'], kzlineW: ['', () => matKzLine(false), 0, 1, 'mid'],
  kzwall: ['uv', () => matKzWall(), 0, 1, 'mid'], kzlouver: ['uv', () => matKzLouver(), 1, 1, 'mid'], kzhatch: ['uv', () => matKzHatch(false), 0, 1, 'mid'], kzhatchY: ['uv', () => matKzHatch(true), 0, 1, 'mid'],
  wbeam: ['', () => matWBeam(), 1, 1, 'mid'], wpost: ['', () => matWBeam(), 1, 1, 'prop'], wrefl: ['', () => matWRefl(), 0, 1, 'fine'],
  hedge: ['uv', () => matLeaf, 1, 1, 'prop'], soil: ['', () => matSoil, 0, 1, 'prop'],
  kmface: ['uv', () => matKm(), 0, 1, 'prop'], exitface: ['uv', () => matExit(), 0, 1, 'mid'],
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
// ======================================================================= 里程牌
// 資料: extra-live wayMap (gid -> [國道, 方向, 里程]) + extra-kmposts 錨點 (scripts/build_kmposts.py)
var KM = null, MAT_KM = null;   // var: CATS 在檔案前面就會呼叫 matKm()
function kmData() {
  if (KM) return KM;
  const read = (id) => { try { const el = document.getElementById(id); return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; } };
  const live = read('extra-live'), kp = read('extra-kmposts');
  return (KM = { map: (live && live.wayMap) || [], A: (kp && kp.anchors) || {} });
}
/** 把 (x, y) 投影到該國道錨點折線上: { m 里程, dist 離折線距離 } */
function mileageAt(road, x, y, segs = null) {
  const a = kmData().A[road];
  if (!a || a.length < 2) return null;
  let best = null;
  for (const i of segs || a.keys()) {
    if (i >= a.length - 1) continue;
    const [m0, x0, y0] = a[i], [m1, x1, y1] = a[i + 1], dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
    if (L2 < 1) continue;
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / L2)), d = Math.hypot(x0 + dx * t - x, y0 + dy * t - y);
    if (!best || d < best.dist) best = { m: m0 + (m1 - m0) * t, dist: d };
  }
  return best;
}
/** 字元圖集: 0-9 和小數點，綠底白字 (整面都是綠底，所以一個字一個四邊形拼起來就是一塊牌子) */
var KM_CH = '0123456789.';
function matKm() {
  if (MAT_KM) return MAT_KM;
  const KM_CH = '0123456789.';   // 區域常數: CATS 在檔案前面 (全域常數初始化之前) 就會呼叫這裡
  const cw = 64, ch = 96, cv = document.createElement('canvas'); cv.width = cw * KM_CH.length; cv.height = ch;
  const c = cv.getContext('2d');
  c.fillStyle = '#0b6a37'; c.fillRect(0, 0, cv.width, ch);
  c.fillStyle = '#f4f4ee'; c.font = 'bold 84px Arial, Helvetica, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let i = 0; i < KM_CH.length; i++) c.fillText(KM_CH[i], cw * (i + 0.5), ch * 0.54);
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
  return (MAT_KM = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0.12, 0.12, 0.12), roughness: 0.5, side: T.DoubleSide }));
}
/** 一面字: 中心 (cx, cy)、牌面朝 (fx, fy) 那一側的來車看得到；文字由觀看者的左到右 */
function kmFace(g, cx, cy, z, fx, fy, label) {
  const wch = (c) => (c === '.' ? 0.055 : 0.1), W = [...label].reduce((s, c) => s + wch(c), 0);
  const lx = fy, ly = -fx;   // 觀看者 (面向 -f) 的左手方向
  let u = -W / 2;
  for (const c of label) {
    const j = KM_CH.indexOf(c), w = wch(c), u0 = u, u1 = u + w; u = u1;
    if (j < 0) continue;
    const pt = (uu, zz, tu, tv) => g.vv([cx - lx * uu, cy - ly * uu, zz, tu, tv]);
    const a = pt(u0, z - 0.09, j / KM_CH.length, 0), b = pt(u1, z - 0.09, (j + 1) / KM_CH.length, 0);
    const cc = pt(u1, z + 0.09, (j + 1) / KM_CH.length, 1), d = pt(u0, z + 0.09, j / KM_CH.length, 1);
    g.q(a, b, cc, d);
  }
  return W;
}
/** 路段上每個 100 m 整數里程的位置: [{ d 沿線距離, km 里程 (m) }] */
function kmMarks(w) {
  const mp = kmData().map[w.gid], out = [];
  if (!mp || w.len < 20) return out;
  const L = w.len, A = kmData().A[mp[0]];
  if (!A) return out;
  // 效能: 只看路段附近 (外擴 1.5 km) 的錨點線段，不用每個取樣點掃整條國道
  const [bx0, by0, bx1, by1] = w.bb, E = 1500, segs = [];
  for (let i = 0; i < A.length - 1; i++) {
    const [, x0, y0] = A[i], [, x1, y1] = A[i + 1];
    if (Math.max(x0, x1) > bx0 - E && Math.min(x0, x1) < bx1 + E && Math.max(y0, y1) > by0 - E && Math.min(y0, y1) < by1 + E) segs.push(i);
  }
  if (!segs.length) return out;
  let prev = null;
  for (let d = 0, k = 0; d <= L + 19.99; d += 20) {
    const dd0 = Math.min(d, L), p = along(w, dd0, k); k = p.k;
    const r = mileageAt(mp[0], p.x, p.y, segs);
    if (!r || r.dist > 250) { prev = null; continue; }
    if (prev && Math.abs(r.m - prev.m) < 60) {
      const a = Math.floor(prev.m / 100), b = Math.floor(r.m / 100);
      if (a !== b) { const km = Math.max(a, b) * 100; out.push({ d: prev.d + (dd0 - prev.d) * (km - prev.m) / (r.m - prev.m), km }); }
    }
    prev = { m: r.m, d: dd0 };
  }
  return out;
}
function kmPosts(B, w, oAt, notMine, nearNotch) {
  const { nx, ny, M } = w, pair = (k) => !!(w.pair && w.pair[k]);
  for (const { d: dd, km } of kmMarks(w)) {
    const q = along(w, dd), kk = q.k;
    if (((M[kk] | M[kk + 1]) & 1) || nearNotch(dd, 3) || notMine(kk)) continue;
    const c = oPt(w, oAt, q), tx = ny[kk], ty = -nx[kk], z = q.z, label = (km / 1000).toFixed(1);
    box(B.g('bpole', c.x, c.y), c.x, c.y, tx, ty, 0.03, 0.03, z + 0.85, z + 1.36);
    const W = kmFace(B.g('kmface', c.x, c.y), c.x - tx * 0.018, c.y - ty * 0.018, z + 1.5, -tx, -ty, label);
    if (pair(kk) && !w.planter) kmFace(B.g('kmface', c.x, c.y), c.x + tx * 0.018, c.y + ty * 0.018, z + 1.5, tx, ty, label);   // 共用的中央護欄: 背面給對向看
    box(B.g('glare', c.x, c.y), c.x, c.y, tx, ty, 0.014, W / 2 + 0.05, z + 1.36, z + 1.64);
  }
}
/** 隧道內里程牌: 照街景，右側牆面磁磚上緣貼一塊綠底白字 (平貼牆面，面向隧道內) */
function kmTunnel(B, w, a) {
  const { nx, ny } = w;
  for (const { d, km } of kmMarks(w)) {
    const q = along(w, d), k = q.k, lat = a - 0.03;
    const x = q.x - nx[k] * lat, y = q.y - ny[k] * lat, label = (km / 1000).toFixed(1);
    const W = kmFace(B.g('kmface', x, y), x + nx[k] * 0.012, y + ny[k] * 0.012, q.z + 3.2, nx[k], ny[k], label);
    box(B.g('glare', x, y), x, y, nx[k], ny[k], 0.008, W / 2 + 0.05, q.z + 3.06, q.z + 3.34);
  }
}

// ======================================================================= 出口預告牌 (300 / 200 / 100 m)
// 照實景: 右側路肩外一支柱子，直立綠色長牌，上面「300 m」，下面白色斜帶 3 / 2 / 1 條 (左下往右上)
var MAT_EXIT = null;
function matExit() {
  if (MAT_EXIT) return MAT_EXIT;
  const cw = 128, ch = 320, cv = document.createElement('canvas'); cv.width = cw * 3; cv.height = ch;
  const c = cv.getContext('2d');
  for (let j = 0; j < 3; j++) {
    const x0 = j * cw, n = 3 - j;   // 第 0 格 300 m (3 條)、1 格 200 m、2 格 100 m
    c.fillStyle = '#0b6a37'; c.fillRect(x0, 0, cw, ch);
    c.strokeStyle = '#f2f2ec'; c.lineWidth = 5; c.strokeRect(x0 + 5, 5, cw - 10, ch - 10);
    c.fillStyle = '#f2f2ec'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 50px Arial, Helvetica, sans-serif'; c.fillText(String(n * 100), x0 + cw / 2, 46);
    c.font = 'bold 44px Arial, Helvetica, sans-serif'; c.fillText('m', x0 + cw / 2, 92);
    // 斜帶: 牌子下半部平均分配
    c.save(); c.beginPath(); c.rect(x0 + 8, 120, cw - 16, ch - 128); c.clip();
    const top = 120, span = ch - 128, band = 26;
    for (let k = 0; k < n; k++) {
      const yc = top + span * (k + 0.5) / n;
      c.beginPath(); c.moveTo(x0, yc + 34); c.lineTo(x0 + cw, yc - 34); c.lineTo(x0 + cw, yc - 34 + band); c.lineTo(x0, yc + 34 + band); c.closePath(); c.fill();
    }
    c.restore();
  }
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
  return (MAT_EXIT = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0.15, 0.15, 0.15), roughness: 0.5, side: T.DoubleSide }));
}
/** 路段 u 上的出口分岔點 (沿線距離): 匝道從中間分出 (DIVERGE) 或路段在分岔點結束 */
function divergesOn(u) {
  const out = [];
  for (const d of DIVERGE.get(u.gid) || []) if (d.mi < u.n) out.push(u.s[d.mi]);
  if (nextOptions(u, u.n - 1).some((o) => o.o.link && !o.o.city)) out.push(u.len);
  return out;
}
function exitSigns(B, w) {
  const { P, nx, ny, hw, M, s } = w;
  if (w.len < 5) return;
  // 前方 300 m 內的分岔點 (可能在後面接的主線上)，座標換成 w 的沿線距離
  const list = divergesOn(w);
  let u = w, start = w.len;
  for (let hop = 0; hop < 4 && start < w.len + 300; hop++) {
    const nxs = nextOptions(u, u.n - 1).filter((o) => !o.o.link && !o.o.city && o.o.oneway && o.dir > 0 && o.i === 0);
    if (!nxs.length) break;
    const v = (nxs.find((o) => o.o.ref && o.o.ref === w.ref) || nxs[0]).o;
    for (const d of divergesOn(v)) if (start + d < w.len + 300) list.push(start + d);
    start += v.len; u = v;
  }
  list.sort((a, b) => a - b);
  const ds = list.filter((d, i) => i === 0 || d - list[i - 1] > 40);
  for (const D of ds) for (const n of [3, 2, 1]) {
    const d = D - n * 100;
    if (d < 0 || d > w.len) continue;
    const p = along(w, d), k = p.k;
    if ((M[k] | M[Math.min(k + 1, w.n - 1)]) & 2) continue;   // 右邊接著別條路面 (匝道分出中)
    const er = hw + (w.eR ? w.eR[k] : 0) + 0.55, tx = ny[k], ty = -nx[k];
    const x = p.x - nx[k] * er, y = p.y - ny[k] * er, z = p.z;
    box(B.g('bpole', x, y), x + tx * 0.05, y + ty * 0.05, tx, ty, 0.05, 0.05, z - 0.5, z + 1.35);
    box(B.g('bback', x, y), x + tx * 0.012, y + ty * 0.012, tx, ty, 0.012, 0.37, z + 1.3, z + 3.1);
    // 牌面 (朝來車；觀看者左手 = 左法向)
    const g = B.g('exitface', x, y), fx = x - tx * 0.002, fy = y - ty * 0.002, j = 3 - n, u0 = j / 3, u1 = (j + 1) / 3;
    const a = g.vv([fx + nx[k] * 0.35, fy + ny[k] * 0.35, z + 1.32, u0, 0]), b = g.vv([fx - nx[k] * 0.35, fy - ny[k] * 0.35, z + 1.32, u1, 0]);
    const c2 = g.vv([fx - nx[k] * 0.35, fy - ny[k] * 0.35, z + 3.08, u1, 1]), e = g.vv([fx + nx[k] * 0.35, fy + ny[k] * 0.35, z + 3.08, u0, 1]);
    g.q(a, b, c2, e);
  }
}

// ======================================================================= 路燈 (精細模型)
/** 管子: 沿 pts ([x, y, z] 資料座標) 掃一個圓斷面，rs[i] 每點半徑 */
function tube(g, pts, rs, seg = 8) {
  const n = pts.length, b = g.n;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
    let tx = c[0] - a[0], ty = c[1] - a[1], tz = c[2] - a[2]; const L = Math.hypot(tx, ty, tz) || 1; tx /= L; ty /= L; tz /= L;
    // 參考軸: 管子接近垂直時用 x 軸，否則用上方
    let rx = 0, ry = 0, rz = 1; if (Math.abs(tz) > 0.9) { rx = 1; rz = 0; }
    let ux = ty * rz - tz * ry, uy = tz * rx - tx * rz, uz = tx * ry - ty * rx; const U = Math.hypot(ux, uy, uz) || 1; ux /= U; uy /= U; uz /= U;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    for (let j = 0; j < seg; j++) {
      const t = j / seg * Math.PI * 2, cs = Math.cos(t) * rs[i], sn = Math.sin(t) * rs[i];
      g.v(pts[i][0] + ux * cs + vx * sn, pts[i][1] + uy * cs + vy * sn, pts[i][2] + uz * cs + vz * sn);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const j1 = (j + 1) % seg;
    g.q(b + i * seg + j, b + i * seg + j1, b + (i + 1) * seg + j1, b + (i + 1) * seg + j);
  }
  const top = g.v(...pts[n - 1]);   // 頂端封口
  for (let j = 0; j < seg; j++) g.i.push(b + (n - 1) * seg + j, b + (n - 1) * seg + (j + 1) % seg, top);
}
/** 國道路燈 (照街景): 護欄頂上的底座法蘭 + 錐形燈桿 (約 10 m)，頂端分出燈臂，順著圓弧從垂直彎成近水平、末端微微上揚，
 *  掛扁平的燈具 (燈罩朝下)。arms: 每支燈臂伸出的水平方向 [[ax, ay], ...] (單臂 1 支、Y 形 2 支) */
function lampPost(B, x, y, z0, arms) {
  const lp = B.g('lampPole', x, y), lh = B.g('lampHead', x, y);
  const H = 9.6, single = arms.length === 1;
  box(lp, x, y, 1, 0, 0.2, 0.2, z0, z0 + 0.04);                                          // 底座法蘭 (鎖在護欄頂)
  for (const [bx, by] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) box(lp, x + bx * 0.14, y + by * 0.14, 1, 0, 0.018, 0.018, z0 + 0.04, z0 + 0.1);   // 螺栓
  tube(lp, [[x, y, z0 + 0.03], [x, y, z0 + 0.35]], [0.16, 0.12], 8);                     // 根部護套
  const pole = [], pr = [];
  for (let i = 0; i <= 2; i++) { const f = i / 2; pole.push([x, y, z0 + 0.3 + (H - 0.3) * f]); pr.push(0.115 - 0.045 * f); }   // 錐形直桿: 3 圈就夠
  tube(lp, pole, pr, 8);
  const R = single ? 2.7 : 1.8, A = single ? 1.35 : 1.25, ext = single ? 1.3 : 0.9;     // 彎曲半徑、彎到幾度 (rad, 從垂直量)、末端直段
  for (const [ax, ay] of arms) {
    const pts = [], rs = [];
    const sx = x + (single ? 0 : ax * 0.06), sy = y + (single ? 0 : ay * 0.06), sz = z0 + H - (single ? 0.1 : 0.6);
    for (let i = 0; i <= 8; i++) { const t = A * i / 8; pts.push([sx + ax * R * (1 - Math.cos(t)), sy + ay * R * (1 - Math.cos(t)), sz + R * Math.sin(t)]); rs.push(0.07 - 0.02 * i / 8); }
    const e = pts[pts.length - 1], dx = Math.sin(A), dz = Math.cos(A);
    pts.push([e[0] + ax * dx * ext, e[1] + ay * dx * ext, e[2] + dz * ext]); rs.push(0.05);
    tube(lp, pts, rs, 6);
    // 燈具: 扁平長橢圓 (沿燈臂方向)，末端略往下
    const hx = pts[pts.length - 1][0] + ax * 0.35, hy = pts[pts.length - 1][1] + ay * 0.35, hz = pts[pts.length - 1][2] + 0.02;
    box(lh, hx, hy, ax, ay, 0.42, 0.17, hz - 0.1, hz + 0.06);
    box(lh, hx + ax * 0.05, hy + ay * 0.05, ax, ay, 0.3, 0.12, hz - 0.16, hz - 0.1);   // 燈罩
    B.chunk(x, y, SUB_P).glows.push(hx, hz - 0.2, -hy);
  }
}

// ======================================================================= 基隆段中央分隔帶植栽 (照街景: 兩道護欄中間泥土帶，一叢叢圓灌木約 2 m 一叢)
function addPlanter(B, w, notMineP) {
  const { P, nx, ny, s, n } = w, pr = (i) => !!(w.pair && w.pair[i]);
  const soil = new Strip(B, 'soil', [[0, 1]]);
  for (let i = 0; i < n; i++) {
    const c = w.bcC[i], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2] + 0.55;
    soil.add([[x + nx[i] * (c + 0.62), y + ny[i] * (c + 0.62), z], [x + nx[i] * (c - 0.62), y + ny[i] * (c - 0.62), z]], i > 0 && pr(i) && pr(i - 1) && !notMineP(i));
  }
  let seed = (w.gid * 7919) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let d = 1, k = 0; d < s[n - 1]; d += 2.3 + rnd() * 0.8) {   // 照街景: 一叢一叢，中間有空隙
    const p = along(w, d, k); k = p.k;
    if (!(pr(k) && pr(k + 1)) || notMineP(k)) continue;
    const c = w.bcC[k] + (rnd() - 0.5) * 0.2, x = p.x + nx[k] * c, y = p.y + ny[k] * c;
    shrub(B.g('hedge', x, y), x, y, p.z + 0.55, 0.72 + rnd() * 0.25, 0.68 + rnd() * 0.3, rnd);
  }
}
/** 一叢灌木: 橢球內 14 片葉叢卡片 (跟樹同一張葉子貼圖)，法向從中心往外 */
function shrub(g, x, y, z0, rh, rv, rnd) {
  if (!g.nrm) g.nrm = [];
  const cz = z0 + rv * 0.95;
  for (let k = 0; k < 14; k++) {
    let d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 1.6 - 0.6]; const dl = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map((v) => v / dl);
    const rr = 0.25 + 0.5 * Math.sqrt(rnd()), pc = [x + d[0] * rh * rr, y + d[1] * rh * rr, cz + d[2] * rv * rr], sz = (0.9 + rnd() * 0.4) * (rh + rv) * 0.48;
    let nm = [d[0] + rnd() - 0.5, d[1] + rnd() - 0.5, d[2] + rnd() - 0.5]; const nl = Math.hypot(nm[0], nm[1], nm[2]) || 1; nm = nm.map((v) => v / nl);
    const ref = Math.abs(nm[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    let t1 = [nm[1] * ref[2] - nm[2] * ref[1], nm[2] * ref[0] - nm[0] * ref[2], nm[0] * ref[1] - nm[1] * ref[0]]; const tl = Math.hypot(t1[0], t1[1], t1[2]) || 1; t1 = t1.map((v) => v / tl);
    const t2 = [nm[1] * t1[2] - nm[2] * t1[1], nm[2] * t1[0] - nm[0] * t1[2], nm[0] * t1[1] - nm[1] * t1[0]];
    const b0 = g.n;
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = [pc[0] + (t1[0] * cu + t2[0] * cv) * sz / 2, pc[1] + (t1[1] * cu + t2[1] * cv) * sz / 2, pc[2] + (t1[2] * cu + t2[2] * cv) * sz / 2];
      g.vv([v[0], v[1], v[2], (cu + 1) / 2, (cv + 1) / 2]);
      let r = [(v[0] - x) / rh, (v[1] - y) / rh, (v[2] - cz) / rv + 0.3]; const rl = Math.hypot(r[0], r[1], r[2]) || 1;
      g.nrm.push(r[0] / rl, r[2] / rl, -r[1] / rl);   // 資料座標 -> three (x, z, -y)
    }
    g.q(b0, b0 + 1, b0 + 2, b0 + 3);
  }
}

// ======================================================================= W 形鋼板護欄 (照街景: 國 1 基隆段右側)
// 鍍鋅鋼板 W 形斷面 (高 0.31 m、兩道凸肋)，H 型鋼立柱每 2 m 一支，立柱和鋼板之間一塊墊塊，每 3 支立柱頂上一個橘色圓形反光片
var MAT_WBEAM = null;
function matWBeam() { return MAT_WBEAM || (MAT_WBEAM = new T.MeshStandardMaterial({ color: new T.Color(0.6, 0.62, 0.64), metalness: 0.55, roughness: 0.42, side: T.DoubleSide })); }
var MAT_WREFL = null;   // 橘色圓形反光片 (照街景)
function matWRefl() { return MAT_WREFL || (MAT_WREFL = new T.MeshStandardMaterial({ color: new T.Color(0.95, 0.38, 0.06), emissive: new T.Color(0.35, 0.12, 0.02), roughness: 0.35, metalness: 0 })); }
function keelungWay(w) { const mp = kmData().map[w.gid]; return !!mp && mp[0] === '國道1號' && mp[2] < 5000; }
// W 斷面 [往路面的偏移, 高]
const WB_PROF = [[0, 0.55], [0.03, 0.56], [0.085, 0.62], [0.045, 0.675], [0.02, 0.705], [0.045, 0.735], [0.085, 0.79], [0.03, 0.85], [0, 0.86]];
function addGuardrail(B, w) {
  setupShoulders(w);
  const { P, nx, ny, s, n, hw, M } = w, ER = (i) => w.eR ? w.eR[i] : 0;
  const face = (i) => -(hw + ER(i)) + 0.38;   // 鋼板面 (左法向偏移；右側為負)
  const rail = new Strip(B, 'wbeam', WB_PROF.slice(0, -1).map((_, j) => [j, j + 1]));
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], f = face(i);
    rail.add(WB_PROF.map(([o, h]) => [x + nx[i] * (f + o), y + ny[i] * (f + o), z + h]), i > 0 && !((M[i - 1] | M[i]) & 2));
  }
  let post = 0;
  for (let d = 1, k = 0; d < s[n - 1]; d += 2, post++) {
    const p = along(w, d, k); k = p.k;
    if ((M[k] | M[Math.min(k + 1, n - 1)]) & 2) continue;
    const f = face(k), tx = ny[k], ty = -nx[k], g = B.g('wpost', p.x, p.y);
    const at = (off) => [p.x + nx[k] * (f + off), p.y + ny[k] * (f + off)];
    const [bx, by] = at(-0.08), [qx, qy] = at(-0.24);
    box(g, bx, by, tx, ty, 0.075, 0.075, p.z + 0.58, p.z + 0.84);                                 // 墊塊
    box(g, qx, qy, tx, ty, 0.075, 0.006, p.z - 0.4, p.z + 0.8);                                    // H 型鋼: 腹板
    for (const sd of [-1, 1]) { const [fx, fy] = at(-0.24 + sd * 0.05); box(g, fx, fy, tx, ty, 0.075, 0.005, p.z - 0.4, p.z + 0.8); }   // 翼板
    if (post % 3 === 1) {   // 橘色圓形反光片: 立柱頂黑色小支架 + 圓片 (面向來車)
      box(B.g('reflBlack', qx, qy), qx, qy, tx, ty, 0.025, 0.025, p.z + 0.8, p.z + 0.98);
      disc(B.g('reflBlack', qx, qy), qx, qy, p.z + 1.07, tx, ty, 0.1, 0.03, 16);
      disc(B.g('wrefl', qx, qy), qx - tx * 0.02, qy - ty * 0.02, p.z + 1.07, tx, ty, 0.085, 0.012, 16);
    }
  }
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
  const kzLink = !w.city && w.link && !params.has('nokzside') && (kzWeight(P[0], P[1]) > 0 || kzWeight(P[(n - 1) * 3], P[(n - 1) * 3 + 1]) > 0);
  if (!w.tunnel && !w.city && !kzLink && !params.has('nofill')) for (const side of [1, -1]) {
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
    // 基隆段 (國 1 里程 5 km 內) 右側照實景是 W 形鋼板護欄 (橋上、隧道照舊混凝土護欄)
    const wbeam = bit === 2 && !w.bridge && !w.link && keelungWay(w) && !params.has('nowbeam');
    const kzL = !w.city && w.link && !params.has('nokzside') && (kzWeight(P[0], P[1]) > 0 || kzWeight(P[(n - 1) * 3], P[(n - 1) * 3 + 1]) > 0);
    const kzNb = kzL ? kzSameSide(w, bit) : null;   // 每點: 這一側緊貼同向匝道的槽化區中心 (左法向偏移)，沒有 = NaN
    // 護欄中心 (左法向偏移): 國道主線左邊 = 中央護欄 (w.bc)、右邊 = 加寬後路緣往內 0.35 m
    const oAt = (i) => w.bc ? (bit === 1 ? w.bc[i] : -(hw + ER(i)) + BARRIER_INSET) : o;
    // 共用的中央護欄 (左邊有對向路面) 只由 gid 小的那一條建
    const notMineP = (i) => bit === 1 && PR(i) && w.oppL[i] && w.oppL[i].gid < w.gid;
    const notMine = (i) => !w.planter && notMineP(i);   // 植栽分隔帶: 兩道護欄各自建
    const bar = new Strip(B, 'barrier', BAR_PAIRS);
    // 斷面位置: 每個節點 + 門架降低段的前後 (降低段 ±BAR_NOTCH，兩端 BAR_RAMP 斜坡)
    const notch = bit === 1 ? barrierNotches(w) : [], LF = BAR_LOW / 0.87;
    const hf = (d) => { let f = 1; for (const c of notch) { const e = Math.abs(d - c); if (e < BAR_NOTCH + BAR_RAMP) f = Math.min(f, e <= BAR_NOTCH ? LF : LF + (1 - LF) * (e - BAR_NOTCH) / BAR_RAMP); } return f; };
    const st = [];
    for (let i = 0; i < n; i++) st.push([s[i], i]);
    for (const c of notch) for (const dd of [-BAR_NOTCH - BAR_RAMP, -BAR_NOTCH, BAR_NOTCH, BAR_NOTCH + BAR_RAMP]) { const d = c + dd; if (d > 0.05 && d < s[n - 1] - 0.05) st.push([d, -1]); }
    st.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const segOk = (k) => !wbeam && !kzL && !((M[k] | M[k + 1]) & bit) && !(notMine(k) && notMine(k + 1));
    if (kzNb) kzSideDeco(B, w, bit, kzNb, oAt);
    if (wbeam) addGuardrail(B, w);
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
    if (bit === 1 && w.planter) addPlanter(B, w, notMineP);   // 基隆段: 兩道護欄中間的植栽帶 (gid 小的那條建)
    if (bit === 1 && !w.link && w.oneway && !w.planter && !params.has('noglare')) {
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
        box(g, x, y, tx, ty, 0.022, 0.2, p.z + 0.84, p.z + 1.72);   // 照街景: 板寬約 0.4 m、頂端離路面約 1.7 m
        box(g, x, y, ny[k], -nx[k], 0.03, 0.03, p.z + 0.8, p.z + 0.9);   // 底座
      }
    }
    // 里程牌: 中央分隔帶每 100 m 一支 (綠底白字公里數)
    if (bit === 1 && !w.link && w.oneway && !params.has('nokm')) kmPosts(B, w, oAt, notMine, nearNotch);
    // 隔音牆 + 廣告看板: 國道主線外側
    if (bit === 2 && !w.link && w.oneway && !params.has('nowall')) roadside(B, w, oAt, inward);
    // 出口預告牌: 出口前 300 / 200 / 100 m (右側路肩外)
    if (bit === 2 && !w.link && w.oneway && !w.tunnel && !params.has('noexitsign')) exitSigns(B, w);
    // 路燈 (照街景): 共用的中央分隔護欄上每 40 m 一支 Y 形雙臂燈；國道主線沒有對向 (單向高架) 改在右側護欄上立單臂燈，燈臂彎過路面
    if (bit === 1 && !w.link && w.oneway && !params.has('nolamps')) {
      for (let d = 2, k = 0; d < s[n - 1]; d += 40) {
        const p = along(w, d, k); k = p.k;
        if (nearNotch(d, 3.5)) continue;   // 跟門架立柱撞在一起
        const single = !!w.bc && (!PR(k) || w.planter);   // 植栽分隔帶上沒有路燈: 改在右側
        if (single) {
          if ((M[k] | M[k + 1]) & 2) continue;
          const o = -(hw + ER(k)) + BARRIER_INSET;
          lampPost(B, p.x + nx[k] * o, p.y + ny[k] * o, p.z + 0.87, [[nx[k], ny[k]]]);
          continue;
        }
        if ((M[k] | M[k + 1]) & bit) continue;
        if (w.bc) { if (notMine(k)) continue; }
        else {
          const pr = roadAt(p.x + nx[k] * (hw + 1.6), p.y + ny[k] * (hw + 1.6), p.z, 0, 1.5);
          if (pr && pr.w !== w && !pr.w.city && Math.abs(pr.z - p.z) < 1.5 && pr.tx * ny[k] + pr.ty * -nx[k] < -0.8 && pr.w.gid < w.gid) continue;
        }
        const q = oPt(w, oAt, p);
        lampPost(B, q.x, q.y, p.z + 0.87, [[nx[k], ny[k]], [-nx[k], -ny[k]]]);
      }
    }
    // 反光片: 外側護欄每 24 m 一支 (黃色圓形稜鏡反光片)，反光面朝來車
    if (bit === 2 && !wbeam && !kzL) for (let d = 12, k = 0; d < s[n - 1]; d += 24) {
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
    // 基隆端: 路面高度改過，伸縮縫跟著貼到現在的路面 (壓縫判定也用同一個 j.z)
    if (kzWeight(j.x, j.y) > 0 && !j.kz) { j.kz = true; const r = roadAt(j.x, j.y, j.z + 1, -2, 0); if (r) j.z = r.z; else j.skip = true; }
    if (j.skip) continue;
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
  if (kzWeight(x, y) > 0) { const r2 = roadAt(x, y, top + 0.5, -3, 1.0); if (r2 && r2.z < top - 1.0) return; }   // 基隆端: 路面降回地面，原本的橋墩不要了
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
  // 國 1 基隆端的中興 / 大業隧道: 兩個洞口共用一面照實景精細建模的洞門 (由中興隧道建)
  const zx = !params.has('nozx') && zxPair(w);
  // 中興隧道南端 (南下出口) 也照實景建 (石塊拼貼洞門 + V 字形石砌擋土牆)
  const zxExit = !params.has('nozx') && /中興隧道/.test(w.name || '') && w.tunnel && isTunnelEnd(w, n - 1);
  for (const i of [0, n - 1]) if (isTunnelEnd(w, i) && !(zx && i === zx.end) && !(zxExit && i === n - 1)) B.chunk(P[i * 3], P[i * 3 + 1]).extra.push(portalMesh(w, i));
  if (zxExit) { const m = zhongxingExitPortal(w); B.chunk(m.userData.x, m.userData.y).extra.push(m); }
  if (zx && zx.build) { const m = zhongxingPortal(zx); B.chunk(m.userData.x, m.userData.y).extra.push(m); }
  if (!params.has('nokm')) kmTunnel(B, w, a);
  if (w.oneway && !w.link && isTunnelEnd(w, 0) && !zx) { const m = tunnelSign(w); if (m) B.chunk(m.userData.x, m.userData.y).extra.push(m); }
}
/** 中興 (南下入口 = 起點) / 大業 (北上出口 = 終點): 兩條都載入、洞口相距 50 m 內才用共用洞門。
 *  回傳 { end: 這條路跳過一般洞口的端點, build: 由這條建 (中興), zw, dw } */
function zxPair(w) {
  if (!w.tunnel || !/中興隧道|大業隧道/.test(w.name || '')) return null;
  const zw = /中興/.test(w.name) ? w : WAYS.find((o) => o && o.tunnel && /中興隧道/.test(o.name || ''));
  const dw = /大業/.test(w.name) ? w : WAYS.find((o) => o && o.tunnel && /大業隧道/.test(o.name || ''));
  if (!zw || !dw) return null;
  const e = (dw.n - 1) * 3;
  if (Math.hypot(dw.P[e] - zw.P[0], dw.P[e + 1] - zw.P[1]) > 50) return null;
  return { end: w === zw ? 0 : w.n - 1, build: w === zw, zw, dw };
}
// ======================================================================= 中興 / 大業隧道洞門 (照 Google 街景 2024-05 精細建模)
// 實景: 一整面米白色洞門牆 (頂上一排城垛)，兩個馬蹄形洞口外圈深灰石框；中間綠白對角圖案大板，上方深綠底金字「國道中山高速公路」匾；
// 兩洞口上方各一塊「大業隧道」「中興隧道」匾；兩側斜面石砌擋土牆 (邊上一支洩水鋼管)；牆頂草坡上白色大字「大道之行」；
// 兩方向之間是藍白石材鋪面的分隔島；中興洞口右側牆上白牌「中興隧道 長396公尺」，右側路邊紅牌「隧道內禁止變換車道」
function zxTex(w, h, draw, rep) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
  if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
  return t;
}
/** 固定種子亂數 (每次建出來一樣) */
function zxRand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
var ZX_KAI = '"DFKai-SB","BiauKai","標楷體","KaiTi","STKaiti","Noto Serif TC","PMingLiU",serif';
var ZX_HEI = '"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
var ZX_MAT = null;
function zxMats() {
  if (ZX_MAT) return ZX_MAT;
  const R = zxRand(7);
  const std = (o) => new T.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0 }, o));
  // 洞門牆: 米白粉刷，有雨水流下的淡灰污漬 (6 m 一張)
  const wall = zxTex(512, 512, (c, w, h) => {
    c.fillStyle = '#dcd8cc'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) { c.fillStyle = `rgba(${120 + R() * 40},${118 + R() * 40},${105 + R() * 40},${0.03 + R() * 0.05})`; c.fillRect(R() * w, R() * h, 4 + R() * 30, 20 + R() * 160); }
    c.strokeStyle = 'rgba(90,88,80,0.18)'; c.lineWidth = 2;
    for (let x = 0; x <= w; x += w / 2) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  }, [1 / 6, 1 / 6]);
  // 擋土牆: 不規則長方形石塊亂砌 (4 m 一張)
  const stone = zxTex(512, 512, (c, w, h) => {
    c.fillStyle = '#b9b6ad'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 26 + R() * 10) {
      let x = -R() * 40; const rh = 22 + R() * 12;
      while (x < w) { const bw = 30 + R() * 70, g = 200 + R() * 30; c.fillStyle = `rgb(${g | 0},${(g - 3) | 0},${(g - 12) | 0})`; c.fillRect(x + 2, y + 2, bw - 4, rh - 4); x += bw; }
    }
    for (let i = 0; i < 120; i++) { c.fillStyle = `rgba(60,70,50,${0.05 + R() * 0.08})`; c.fillRect(R() * w, R() * h, 3 + R() * 18, 3 + R() * 18); }
  }, [1, 1]);
  const grass = zxTex(256, 256, (c, w, h) => {
    c.fillStyle = '#5a8236'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1800; i++) { const g = R(); c.fillStyle = `rgba(${(40 + g * 60) | 0},${(90 + g * 70) | 0},${(25 + g * 30) | 0},0.5)`; c.fillRect(R() * w, R() * h, 2, 3 + R() * 4); }
  }, [1, 1]);
  // 分隔島鋪面: 灰白石板亂鋪，中間有藍色波浪 (8 m 一張)
  const pave = zxTex(512, 512, (c, w, h) => {
    c.fillStyle = '#bdbcb6'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 22) for (let x = -R() * 30; x < w; x += 28 + R() * 30) { const g = 175 + R() * 55; c.fillStyle = `rgb(${g | 0},${g | 0},${(g - 4) | 0})`; c.fillRect(x + 1.5, y + 1.5, 26 + R() * 20, 19); }
    c.globalAlpha = 0.4; c.fillStyle = '#4a6c96';
    for (let k = 0; k < 2; k++) {
      c.beginPath(); const y0 = 60 + k * 170; c.moveTo(0, y0);
      for (let x = 0; x <= w; x += 16) c.lineTo(x, y0 + Math.sin(x / 60 + k) * 30);
      for (let x = w; x >= 0; x -= 16) c.lineTo(x, y0 + 55 + Math.sin(x / 70 + k * 2) * 25);
      c.fill();
    }
    c.globalAlpha = 1;
  }, [1, 1]);
  // 中間綠白對角大板: 上下白色三角形尖端在中央相接，左右綠色 (上半深綠、下半淺綠)，外圈綠框
  const panel = zxTex(1024, 540, (c, w, h) => {
    const cx = w / 2, cy = h * 0.52;
    c.fillStyle = '#f4f4f0'; c.fillRect(0, 0, w, h);
    const tri = (pts, col) => { c.fillStyle = col; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath(); c.fill(); };
    for (const sx of [0, w]) { tri([[sx, 0], [cx, cy], [sx, cy]], '#1d8f3a'); tri([[sx, cy], [cx, cy], [sx, h]], '#3fb54a'); }
    c.fillStyle = 'rgba(0,0,0,0.04)'; c.fillRect(0, cy, w, h - cy);
    c.strokeStyle = '#1d8f3a'; c.lineWidth = 14; c.strokeRect(7, 7, w - 14, h - 14);
  });
  // 深綠底金字匾
  const plaque = (text, size, sp) => zxTex(Math.round(size * (text.length * (1 + sp) + 1)), size * 2, (c, w, h) => {
    c.fillStyle = '#21402f'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#b9a86a'; c.lineWidth = size * 0.08; c.strokeRect(size * 0.12, size * 0.12, w - size * 0.24, h - size * 0.24);
    c.fillStyle = '#d9c88a'; c.font = `bold ${size}px ${ZX_KAI}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const step = size * (1 + sp), x0 = w / 2 - step * (text.length - 1) / 2;
    [...text].forEach((ch, i) => c.fillText(ch, x0 + step * i, h / 2 + size * 0.05));
  });
  const hillChar = (ch) => zxTex(256, 256, (c, w, h) => { c.fillStyle = '#f7f7f2'; c.font = `bold 230px ${ZX_KAI}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ch, w / 2, h / 2 + 10); });
  const red = zxTex(320, 640, (c, w, h) => {
    c.fillStyle = '#c8202a'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#f4f4f0'; c.lineWidth = 10; c.strokeRect(12, 12, w - 24, h - 24);
    c.fillStyle = '#f4f4f0'; c.font = `bold 96px ${ZX_HEI}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    [...'隧道內禁止'].forEach((ch, i) => c.fillText(ch, w * 0.7, 80 + i * 112));   // 右欄
    [...'變換車道'].forEach((ch, i) => c.fillText(ch, w * 0.3, 80 + i * 112));     // 左欄
  });
  const nameSign = zxTex(512, 256, (c, w, h) => {
    c.fillStyle = '#ecece6'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#2a2a2a'; c.lineWidth = 6; c.strokeRect(10, 10, w - 20, h - 20);
    c.fillStyle = '#1a1a1a'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `bold 92px ${ZX_HEI}`; c.fillText('中 興 隧 道', w / 2, 95);
    c.font = `bold 52px ${ZX_HEI}`; c.fillText('長  396  公尺', w / 2, 192);
  });
  const lane = zxTex(128, 128, (c, w, h) => {
    c.fillStyle = '#0c0c0c'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#35ff6a'; c.beginPath(); c.moveTo(64, 108); c.lineTo(28, 66); c.lineTo(52, 66); c.lineTo(52, 22); c.lineTo(76, 22); c.lineTo(76, 66); c.lineTo(100, 66); c.closePath(); c.fill();
  });
  const chev = zxTex(256, 128, (c, w, h) => {
    c.fillStyle = '#f2c200'; c.fillRect(0, 0, w, h); c.fillStyle = '#151515';
    for (let x = -h; x < w + h; x += 64) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 32, h); c.lineTo(x + 32 + h, 0); c.lineTo(x + h, 0); c.closePath(); c.fill(); }
  });
  const pl = (tex) => std({ map: tex, emissiveMap: tex, emissive: new T.Color(0.15, 0.15, 0.15), roughness: 0.55, side: T.DoubleSide });
  ZX_MAT = {
    wall: std({ map: wall, roughness: 0.9 }), stone: std({ map: stone, roughness: 0.95, side: T.DoubleSide }), grass: std({ map: grass, roughness: 1, side: T.DoubleSide }),
    rim: std({ color: new T.Color(0.2, 0.2, 0.19), roughness: 0.8 }), cap: std({ color: new T.Color(0.62, 0.61, 0.57), roughness: 0.9 }),
    pave: std({ map: pave, roughness: 0.9, side: T.DoubleSide }), panel: pl(panel),
    road: pl(plaque('國道中山高速公路', 120, 0.55)), zname: pl(plaque('中興隧道', 120, 0.35)), dname: pl(plaque('大業隧道', 120, 0.35)),
    chars: [...'大道之行'].map((ch) => std({ map: hillChar(ch), transparent: true, alphaTest: 0.4, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: T.DoubleSide })),
    red: pl(red), nameSign: pl(nameSign), lane: std({ map: lane, emissiveMap: lane, emissive: new T.Color(1, 1, 1), roughness: 0.4 }), chev: pl(chev),
    steel: std({ color: new T.Color(0.55, 0.56, 0.57), metalness: 0.6, roughness: 0.45 }),
  };
  return ZX_MAT;
}
function zhongxingPortal({ zw, dw }) {
  const M = zxMats(), grp = new T.Group();
  const e = (dw.n - 1) * 3, O = [zw.P[0], zw.P[1]], E = [dw.P[e], dw.P[e + 1]], z0 = (zw.P[2] + dw.P[e + 2]) / 2;
  // 洞門座標: sx 沿牆面 (面向洞口時的右手方向)、h 離路面高、sz 往洞外 (朝來車)；原點在中興洞口中心
  const D = Math.hypot(O[0] - E[0], O[1] - E[1]), Xd = [(O[0] - E[0]) / D, (O[1] - E[1]) / D], Zd = [Xd[1], -Xd[0]];
  const W = (sx, h, sz) => [O[0] + Xd[0] * sx + Zd[0] * sz, O[1] + Xd[1] * sx + Zd[1] * sz, z0 + h];
  const add = (geo, mat, cast = true) => { const m = new T.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  const place = (geo) => {   // 形狀座標 (x = sx, y = h, z = sz) -> three
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const q = W(p.getX(i), p.getY(i), p.getZ(i)); p.setXYZ(i, q[0], q[2], -q[1]); }
    geo.computeVertexNormals(); geo.computeBoundingSphere(); return geo;
  };
  /** 四邊形 (四個洞門座標點，逆時針面向觀看者) + uv */
  const quad = (pts, uvs, mat, cast = false) => {
    const g = new GB('uv'); const ids = pts.map((q, i) => { const p = W(q[0], q[1], q[2]); return g.vv([p[0], p[1], p[2], uvs[i][0], uvs[i][1]]); });
    g.q(ids[0], ids[1], ids[2], ids[3]);
    const m = withUv(g.mesh(mat, { cast })); grp.add(m); return m;
  };
  const UV1 = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const xD = -D, aZ = zw.hw + 0.9, aD = dw.hw + 0.9, H = 7.2, Hw = 2.9, RIM = 1.0, TOP = 10.8;
  const arch = (cx, a, k, path) => {   // 馬蹄形洞口 (跟隧道斷面同一條曲線)；k: 往外放大 m
    const A = a + k, HH = H + k;
    path.moveTo(cx - A, -0.6); path.lineTo(cx - A, Hw);
    for (let j = 1; j < 24; j++) { const t = Math.PI * j / 24; path.lineTo(cx - Math.cos(t) * A, Hw + Math.sin(t) * (HH - Hw)); }
    path.lineTo(cx + A, Hw); path.lineTo(cx + A, -0.6); path.lineTo(cx - A, -0.6);
  };
  const L = xD - aD - 5.5, Rr = aZ + 5.5;   // 洞門牆左右端 (照實景: 洞口外側只留一小段平牆就接斜面擋土牆)
  // ---- 洞門牆 (厚 1.2 m，挖兩個洞)
  // 照實景: 洞門牆兩側的邊往外斜 (下窄上寬)，斜邊接著兩側斜面擋土牆；BAT = 牆頂比牆腳往外多出的寬度
  const BAT = 6.5, LT = L - BAT, RT = Rr + BAT;
  const sh = new T.Shape(); sh.moveTo(L, -0.6); sh.lineTo(Rr, -0.6); sh.lineTo(RT, TOP); sh.lineTo(LT, TOP); sh.lineTo(L, -0.6);
  for (const [cx, a] of [[0, aZ], [xD, aD]]) { const hp = new T.Path(); arch(cx, a, 0, hp); sh.holes.push(hp); }
  const wg = new T.ExtrudeGeometry(sh, { depth: 1.2, bevelEnabled: false, curveSegments: 2 }); wg.translate(0, 0, -1.2);
  add(place(wg), M.wall);
  // ---- 中央凸出牆面 (兩個石框之間，掛大板和匾)
  const c0 = xD + aD + RIM + 0.15, c1 = -aZ - RIM - 0.15;
  add(place(new T.BoxGeometry(c1 - c0, TOP + 0.6, 0.3).translate((c0 + c1) / 2, (TOP - 0.6) / 2, 0.15)), M.wall);
  // ---- 石框 (深灰，凸出 0.45 m)
  for (const [cx, a] of [[0, aZ], [xD, aD]]) {
    const rs = new T.Shape(); arch(cx, a, RIM, rs); const hp = new T.Path(); arch(cx, a, 0, hp); rs.holes.push(hp);
    add(place(new T.ExtrudeGeometry(rs, { depth: 0.45, bevelEnabled: false, curveSegments: 2 })), M.rim);
  }
  // ---- 牆頂壓頂 + 城垛
  add(place(new T.BoxGeometry(RT - LT, 0.25, 1.5).translate((LT + RT) / 2, TOP + 0.12, -0.55)), M.cap);
  for (let x = LT + 0.4; x < RT - 0.3; x += 1.1) add(place(new T.BoxGeometry(0.55, 0.42, 0.45).translate(x + 0.27, TOP + 0.45, 0.05)), M.cap, false);
  // ---- 綠白對角大板 + 國道中山高速公路匾
  const pw = c1 - c0 - 0.5, ph = Math.min(7.0, pw / 1.85), pc = (c0 + c1) / 2;
  quad([[pc - pw / 2, 0, 0.32], [pc + pw / 2, 0, 0.32], [pc + pw / 2, ph, 0.32], [pc - pw / 2, ph, 0.32]], UV1, M.panel);
  const rw = Math.min(pw * 1.02, c1 - c0 - 0.2), rh = rw / ((8 * 1.55 + 1) / 2), ry = ph + 0.55;
  add(place(new T.BoxGeometry(rw + 0.12, rh + 0.12, 0.12).translate(pc, ry + rh / 2, 0.36)), M.rim, false);
  quad([[pc - rw / 2, ry, 0.43], [pc + rw / 2, ry, 0.43], [pc + rw / 2, ry + rh, 0.43], [pc - rw / 2, ry + rh, 0.43]], UV1, M.road);
  // ---- 隧道名匾 (各洞口拱頂上方)
  for (const [cx, mat] of [[0, M.zname], [xD, M.dname]]) {
    const nw = 3.4, nh = nw / ((4 * 1.35 + 1) / 2), ny = H + RIM + 0.75;
    add(place(new T.BoxGeometry(nw + 0.1, nh + 0.1, 0.1).translate(cx, ny + nh / 2, 0.05)), M.rim, false);
    quad([[cx - nw / 2, ny, 0.11], [cx + nw / 2, ny, 0.11], [cx + nw / 2, ny + nh, 0.11], [cx - nw / 2, ny + nh, 0.11]], UV1, mat);
  }
  // ---- 白牌「中興隧道 長396公尺」(中興洞口右側牆上)
  { const x0 = aZ + RIM + 0.5, x1 = x0 + 2.4, y0 = 3.0, y1 = 4.2;
    quad([[x0, y0, 0.06], [x1, y0, 0.06], [x1, y1, 0.06], [x0, y1, 0.06]], UV1, M.nameSign); }
  // ---- 洞口上方綠色車道管制燈 (每車道一盞) + 洞口兩側黃黑警示
  for (const [cx, a] of [[0, aZ], [xD, aD]]) {
    for (const sd of [-0.55, 0.55]) {
      const lx = cx + sd * a * 0.62, ly = H - 1.3;
      add(place(new T.BoxGeometry(0.75, 0.75, 0.35).translate(lx, ly, -0.6)), M.rim, false);
      quad([[lx - 0.33, ly - 0.33, -0.42], [lx + 0.33, ly - 0.33, -0.42], [lx + 0.33, ly + 0.33, -0.42], [lx - 0.33, ly + 0.33, -0.42]], UV1, M.lane);
    }
    for (const sd of [-1, 1]) add(place(new T.BoxGeometry(0.5, 0.9, 1.6).translate(cx + sd * (a - 0.35), 0.45, 0.4)), M.chev, false);
  }
  // ---- 兩側斜面擋土牆 (石砌，往來車方向斜降到地面)，牆頂草皮，牆邊洩水鋼管
  const wing = (sgn) => {
    const xe = sgn > 0 ? Rr : L, run = 30;
    const A = [xe, -0.6, 0], B2 = [xe + sgn * BAT, TOP, 0], C = [xe + sgn * 1.2, 0.8, run], Dd = [xe, -0.6, run];
    const pts = sgn > 0 ? [Dd, A, B2, C] : [A, Dd, C, B2];
    quad(pts, pts.map((q) => [(q[0] * sgn + q[2]) / 4, q[1] / 4]), M.stone, true);
    const G1 = [B2[0] + sgn * 8, TOP + 2.5, -2], G2 = [C[0] + sgn * 8, 2.5, run + 2];
    const gp = sgn > 0 ? [B2, G1, G2, C] : [G1, B2, C, G2];
    quad(gp, gp.map((q) => [q[0] / 5, q[2] / 5]), M.grass);
    const pp = []; for (let k = 0; k <= 6; k++) { const f = k / 6; pp.push(W(xe + sgn * (BAT * (1 - f) - 0.4), TOP - (TOP + 0.3) * f, 0.35 + f * 0.1)); }   // 洩水鋼管沿著斜邊
    const tg = new GB(); tube(tg, pp, pp.map(() => 0.12), 8); grp.add(tg.mesh(M.steel, { cast: true }));
  };
  wing(1); wing(-1);
  // ---- 牆頂草坡 + 白色大字「大道之行」
  const back = 22, rise = 7.5;
  // 地形網格在隧道口會把「比隧道頂低」的 30 m 方格整格挖掉 (才看得到洞口)，洞門後面因此破一個大洞、後面的山像浮在半空。
  // 草坡往左右各多鋪 40 m、往後鋪 90 m 把洞補滿: 洞門正後方照實景斜坡，往外 / 往後漸漸貼回地形 (比地形低 0.3 m，地形還在的地方看不到)
  { const BK = 44, FAR = 90, SIDE = 40, xs = [], zs = [];
    for (let x = L - SIDE; x < Rr + SIDE + 0.1; x += 4) xs.push(Math.min(x, Rr + SIDE));
    for (let z = 0; z <= FAR; z += 4) zs.push(z);
    const sm = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const hAt = (sx, d) => {
      const ramp = TOP + 0.25 + rise * Math.min(d, back) / back, q = W(sx, 0, -0.3 - d), tr = terrainAt(q[0], q[1]), ter = tr === 0 ? ramp : tr - z0 - 0.3;   // 地形還沒載入 (0) 就維持斜坡
      const core = ramp + (ter - ramp) * sm((d - back * 0.6) / (BK - back * 0.6));
      const wl = 1 - sm(Math.max(0, LT - 2 - sx, sx - RT - 2) / 12);   // 洞門寬度外: 漸漸變成貼地形
      return ter + (core - ter) * wl;
    };
    const g = new GB('uv'), ids = zs.map((d) => xs.map((x) => { const q = W(x, hAt(x, d), -0.3 - d); return g.vv([q[0], q[1], q[2], x / 5, d / 5]); }));
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) g.q(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
    const m = withUv(g.mesh(M.grass, { cast: false })); grp.add(m); }
  { const span = (RT - LT) * 0.88, cs = 7.5, x0 = (LT + RT) / 2 - span / 2, f0 = 0.03, f1 = f0 + cs / Math.hypot(back, rise);
    for (let k = 0; k < 4; k++) {
      const cx = x0 + span * (k + 0.5) / 4, p = (u, f) => [cx + u * cs / 2, TOP + 0.3 + rise * f, -0.3 - back * f];
      quad([p(-1, f0), p(1, f0), p(1, f1), p(-1, f1)], UV1, M.chars[k]);
    } }
  // ---- 分隔島藍白石材鋪面: 兩方向路面內側邊之間，從洞門往外鋪到兩條路靠攏
  {
    const nb = (w, node, wantEnd) => (PT_INDEX.get(ptKey(w.P[node * 3], w.P[node * 3 + 1])) || []).map(([k, i]) => [WAYS[k], i]).find(([o, i]) => o !== w && !o.tunnel && !o.link && (wantEnd ? i === o.n - 1 : i === 0));
    const zp = nb(zw, 0, true), dn = nb(dw, dw.n - 1, false);
    const edge = (o, d, fromEnd) => {   // 路面左緣 (分隔島那一側)
      setupShoulders(o);
      const p = along(o, fromEnd ? Math.max(0, o.len - d) : Math.min(o.len, d)), k = p.k, ex = o.hw + (o.eL ? o.eL[k] : 0) + 0.15;
      return [p.x + o.nx[k] * ex, p.y + o.ny[k] * ex, p.z];
    };
    if (zp && dn) {
      const g = new GB('uv');
      let prev = null;
      for (let d = 0; d <= 60; d += 3) {
        const a = edge(zp[0], d, true), b = edge(dn[0], d, false);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.2) break;
        const zz = (a[2] + b[2]) / 2 + 0.04;
        const ia = g.vv([a[0], a[1], zz, a[0] / 8, a[1] / 8]), ib = g.vv([b[0], b[1], zz, b[0] / 8, b[1] / 8]);
        if (prev) g.q(prev[1], prev[0], ia, ib);
        prev = [ia, ib];
      }
      const m = g.mesh(M.pave, { cast: false }); if (m) { withUv(m); grp.add(m); }
      // 紀念柱: 分隔島上離洞口最遠、寬度還放得下台座 (直徑 11 m + 兩側護欄) 的地方
      if (!params.has('nomonument')) for (let d = 70; d >= 16; d -= 2) {
        const a2 = edge(zp[0], d, true), b2 = edge(dn[0], d, false);
        if (Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) < 12.6) continue;
        grp.add(zxMonument((a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, (a2[2] + b2[2]) / 2 + 0.04, Xd));
        break;
      }
    }
  }
  // ---- 紅牌「隧道內禁止變換車道」: 中興方向右側路邊、洞口前 14 m
  { const x = zw.hw + 3.2, h0 = 2.6, bw = 1.6, bh = 3.2;
    const tg = new GB(); tube(tg, [W(x + 0.95, -1.2, 14.1), W(x + 0.95, h0 + bh + 0.3, 14.1)], [0.08, 0.07], 8); grp.add(tg.mesh(M.steel, { cast: true }));
    add(place(new T.BoxGeometry(bw + 0.06, bh + 0.06, 0.05).translate(x, h0 + bh / 2, 13.97)), M.steel, true);
    quad([[x - bw / 2, h0, 14.0], [x + bw / 2, h0, 14.0], [x + bw / 2, h0 + bh, 14.0], [x - bw / 2, h0 + bh, 14.0]], UV1, M.red); }
  const c = W(xD / 2, 0, 0);
  grp.userData = { x: c[0], y: c[1] };
  return grp;
}

// ======================================================================= 中興隧道南端 (南下出口) 洞門 (照 Google 街景 2024-05)
// 實景: 灰白不規則石塊拼貼的洞門牆，中段一道突出的橫線腳 (下面一排小托架)，上段中央金字匾；拱圈外深灰石框；牆頂一排鋼管欄杆；
// 兩側巨大的深灰不規則石砌斜擋土牆 (V 字形路塹)，右側擋土牆頂也有欄杆；左側牆腳一支單臂路燈
var ZXE_MAT = null;
function zxeMats() {
  if (ZXE_MAT) return ZXE_MAT;
  const R = zxRand(31);
  // 不規則石塊拼貼: 格點亂數偏移 → 每格一塊不規則四邊形 (有些再斜切成兩塊)，石縫深灰
  const mosaic = (light) => zxTex(512, 512, (c, w, h) => {
    const N = 9, P = [];
    for (let j = 0; j <= N; j++) { const row = []; for (let i = 0; i <= N; i++) { const edge = i === 0 || i === N || j === 0 || j === N; row.push([i * w / N + (edge ? 0 : (R() - 0.5) * w / N * 0.7), j * h / N + (edge ? 0 : (R() - 0.5) * h / N * 0.7)]); } P.push(row); }
    for (let i = 0; i < N; i++) { P[N][i][0] = P[0][i][0]; P[i][N][1] = P[i][0][1]; }   // 上下、左右接得起來 (可重複貼)
    c.fillStyle = light ? '#5e5d58' : '#3c3d39'; c.fillRect(0, 0, w, h);
    const stone = (pts) => {
      const g = light ? 185 + R() * 55 : 95 + R() * 60, tint = light ? 0 : R() * 10;
      c.fillStyle = `rgb(${g | 0},${(g + tint) | 0},${(g - 4) | 0})`;
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath(); c.fill();
    };
    const inset = (pts, k) => { const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length; return pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]); };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const q = [P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i]];
      if (R() < 0.45) { stone(inset([q[0], q[1], q[2]], 0.9)); stone(inset([q[0], q[2], q[3]], 0.9)); }
      else stone(inset(q, 0.92));
    }
    // 雨水污漬 (往下流)
    for (let k = 0; k < 90; k++) { c.fillStyle = light ? `rgba(70,72,62,${0.04 + R() * 0.07})` : `rgba(40,55,35,${0.05 + R() * 0.1})`; c.fillRect(R() * w, R() * h, 3 + R() * 14, 30 + R() * 140); }
  }, [1 / 4, 1 / 4]);
  const plaque = zxTex(Math.round(120 * (4 * 1.6 + 1)), 240, (c, w, h) => {
    c.fillStyle = '#4e6a55'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#a99c6c'; c.lineWidth = 10; c.strokeRect(14, 14, w - 28, h - 28);
    c.fillStyle = '#cdbb7f'; c.font = `bold 120px ${ZX_KAI}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const step = 120 * 1.6, x0 = w / 2 - step * 1.5;
    [...'中興隧道'].forEach((ch, i) => c.fillText(ch, x0 + step * i, h / 2 + 6));
  });
  const std = (o) => new T.MeshStandardMaterial(Object.assign({ roughness: 0.92, metalness: 0 }, o));
  ZXE_MAT = {
    face: std({ map: mosaic(true) }), wing: std({ map: mosaic(false), side: T.DoubleSide }),
    plaque: std({ map: plaque, emissiveMap: plaque, emissive: new T.Color(0.12, 0.12, 0.12), roughness: 0.6, side: T.DoubleSide }),
    ledge: std({ color: new T.Color(0.66, 0.66, 0.63) }),
  };
  return ZXE_MAT;
}
function zhongxingExitPortal(zw) {
  const M = zxMats(), ME = zxeMats(), grp = new T.Group();
  const e = zw.n - 1, E = [zw.P[e * 3], zw.P[e * 3 + 1]], z0 = zw.P[e * 3 + 2];
  // 洞門座標: 面向洞口 (站在洞外) 時 sx 往右、sz 往洞外 (= 隧道行進方向)、h 離路面高
  const Zd = [zw.ny[e], -zw.nx[e]], Xd = [zw.nx[e], zw.ny[e]];
  const W = (sx, h, sz) => [E[0] + Xd[0] * sx + Zd[0] * sz, E[1] + Xd[1] * sx + Zd[1] * sz, z0 + h];
  const add = (geo, mat, cast = true) => { const m = new T.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  const place = (geo) => { const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const q = W(p.getX(i), p.getY(i), p.getZ(i)); p.setXYZ(i, q[0], q[2], -q[1]); } geo.computeVertexNormals(); geo.computeBoundingSphere(); return geo; };
  const quad = (pts, uvs, mat, cast = false) => {
    const g = new GB('uv'); const ids = pts.map((q, i) => { const p = W(q[0], q[1], q[2]); return g.vv([p[0], p[1], p[2], uvs[i][0], uvs[i][1]]); });
    g.q(ids[0], ids[1], ids[2], ids[3]); const m = withUv(g.mesh(mat, { cast })); grp.add(m); return m;
  };
  const UV1 = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const a = zw.hw + 0.9, H = 7.2, Hw = 2.9, RIM = 0.9, TOP = 10.8, LEDGE = 8.6;
  const XB = a + 2.6, BAT = 6.2, XT = XB + BAT;   // 牆腳半寬、斜邊往外、牆頂半寬
  const arch = (k, path) => {
    const A = a + k, HH = H + k;
    path.moveTo(-A, -0.6); path.lineTo(-A, Hw);
    for (let j = 1; j < 24; j++) { const t = Math.PI * j / 24; path.lineTo(-Math.cos(t) * A, Hw + Math.sin(t) * (HH - Hw)); }
    path.lineTo(A, Hw); path.lineTo(A, -0.6); path.lineTo(-A, -0.6);
  };
  // ---- 洞門牆 (梯形，兩側斜邊接擋土牆)，石塊拼貼
  const sh = new T.Shape(); sh.moveTo(-XB, -0.6); sh.lineTo(XB, -0.6); sh.lineTo(XT, TOP); sh.lineTo(-XT, TOP); sh.lineTo(-XB, -0.6);
  { const hp = new T.Path(); arch(0, hp); sh.holes.push(hp); }
  const wg = new T.ExtrudeGeometry(sh, { depth: 1.2, bevelEnabled: false, curveSegments: 2 }); wg.translate(0, 0, -1.2);
  add(place(wg), ME.face);
  // 中段凸出 (拱圈兩側到線腳)
  { const cs = new T.Shape(), CW = a + 2.3; cs.moveTo(-CW, -0.6); cs.lineTo(CW, -0.6); cs.lineTo(CW, LEDGE); cs.lineTo(-CW, LEDGE); cs.lineTo(-CW, -0.6);
    const hp = new T.Path(); arch(RIM - 0.05, hp); cs.holes.push(hp);
    add(place(new T.ExtrudeGeometry(cs, { depth: 0.25, bevelEnabled: false, curveSegments: 2 })), ME.face); }
  // 石框
  { const rs = new T.Shape(); arch(RIM, rs); const hp = new T.Path(); arch(0, hp); rs.holes.push(hp);
    add(place(new T.ExtrudeGeometry(rs, { depth: 0.45, bevelEnabled: false, curveSegments: 2 })), M.rim); }
  // 橫線腳 + 下方小托架
  const LW = XB + BAT * LEDGE / TOP;
  add(place(new T.BoxGeometry(2 * LW, 0.28, 0.5).translate(0, LEDGE + 0.14, 0.25)), ME.ledge);
  for (let x = -LW + 0.8; x < LW - 0.6; x += 2.2) add(place(new T.BoxGeometry(0.35, 0.4, 0.35).translate(x, LEDGE - 0.2, 0.18)), ME.ledge, false);
  // 牆頂壓頂
  add(place(new T.BoxGeometry(2 * XT, 0.22, 1.4).translate(0, TOP + 0.11, -0.5)), ME.ledge);
  // 金字匾 (上段中央)
  { const pw = 4.6, ph = pw / ((4 * 1.6 + 1) / 2), py = LEDGE + 0.55;
    add(place(new T.BoxGeometry(pw + 0.12, ph + 0.12, 0.1).translate(0, py + ph / 2, 0.05)), M.rim, false);
    quad([[-pw / 2, py, 0.11], [pw / 2, py, 0.11], [pw / 2, py + ph, 0.11], [-pw / 2, py + ph, 0.11]], UV1, ME.plaque); }
  // ---- 欄杆 (鋼管: 立柱每 1.6 m，上下兩道橫桿)
  const rail = (p0, p1) => {
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), n = Math.max(1, Math.round(L / 1.6));
    const g = new GB();
    for (const hh of [0.5, 1.05]) tube(g, [W(p0[0], p0[1] + hh, p0[2]), W(p1[0], p1[1] + hh, p1[2])], [0.035, 0.035], 6);
    for (let k = 0; k <= n; k++) { const f = k / n, q = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f]; tube(g, [W(q[0], q[1], q[2]), W(q[0], q[1] + 1.1, q[2])], [0.03, 0.03], 5); }
    grp.add(g.mesh(M.steel, { cast: true }));
  };
  rail([-XT, TOP + 0.22, -0.2], [XT, TOP + 0.22, -0.2]);
  // ---- 兩側斜面擋土牆 (深灰石砌，往洞外斜降到路邊)
  const run = 48;
  for (const sg of [1, -1]) {
    const A = [sg * XB, -0.6, 0], B2 = [sg * XT, TOP, 0], C = [sg * (XB + 1.4), 0.9, run], D = [sg * XB, -0.6, run];
    const pts = sg > 0 ? [D, A, B2, C] : [A, D, C, B2];
    quad(pts, pts.map((q) => [q[0] * sg + q[2], q[1]]), ME.wing, true);   // uv 用公尺 (貼圖本身 4 m 重複一次)
    // 牆腳排水溝邊
    add(place(new T.BoxGeometry(0.35, 0.25, run).translate(sg * (XB - 0.2), -0.48, run / 2)), ME.ledge, false);
    // 牆頂草皮 (往外 10 m)
    const G1 = [B2[0] + sg * 10, TOP + 3, -2], G2 = [C[0] + sg * 10, 3.2, run + 2], gp = sg > 0 ? [B2, G1, G2, C] : [G1, B2, C, G2];
    quad(gp, gp.map((q) => [q[0] / 5, q[2] / 5]), M.grass);
    if (sg > 0) rail(B2, C);   // 右側擋土牆頂的欄杆
  }
  // ---- 左側牆腳單臂路燈 (燈臂伸向路面)
  { const lx = -(XB - 0.5), lz = 7, top = 9.6, g = new GB(), pts = [W(lx, -0.2, lz), W(lx, top, lz)];
    tube(g, pts, [0.11, 0.07], 8);
    const arm = []; for (let k = 0; k <= 8; k++) { const t = 1.3 * k / 8; arm.push(W(lx + 2.4 * (1 - Math.cos(t)), top + 2.4 * Math.sin(t) * 0.45, lz)); }
    tube(g, arm, arm.map(() => 0.055), 6); grp.add(g.mesh(M.steel, { cast: true }));
    add(place(new T.BoxGeometry(0.85, 0.16, 0.34).translate(lx + 2.4 * (1 - Math.cos(1.3)) + 0.35, top + 2.4 * Math.sin(1.3) * 0.45 - 0.05, lz)), M.rim, false); }
  // ---- 洞門後方綠色草坡: 補地形在隧道口挖掉的洞 (跟北端洞門一樣)
  { const BK = 36, FAR = 70, SIDE = 30, back = 18, rise = 6, xs = [], zs = [];
    for (let x = -XT - SIDE; x < XT + SIDE + 0.1; x += 4) xs.push(Math.min(x, XT + SIDE));
    for (let z = 0; z <= FAR; z += 4) zs.push(z);
    const sm = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const hAt = (sx, d) => {
      const ramp = TOP + 0.25 + rise * Math.min(d, back) / back, q = W(sx, 0, -0.3 - d), tr = terrainAt(q[0], q[1]), ter = tr === 0 ? ramp : tr - z0 - 0.3;
      const core = ramp + (ter - ramp) * sm((d - back * 0.6) / (BK - back * 0.6));
      const wl = 1 - sm(Math.max(0, -XT - 2 - sx, sx - XT - 2) / 12);
      return ter + (core - ter) * wl;
    };
    const g = new GB('uv'), ids = zs.map((d) => xs.map((x) => { const q = W(x, hAt(x, d), -0.3 - d); return g.vv([q[0], q[1], q[2], x / 5, d / 5]); }));
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) g.q(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
    grp.add(withUv(g.mesh(M.grass, { cast: false }))); }
  grp.userData = { x: E[0], y: E[1] };
  return grp;
}

// ======================================================================= 國 1 基隆端分隔島紀念柱 (照 Google 街景 2024-05)
// 實景: 白色大圓台座 (直徑約 10 m、上窄下寬) → 上層圓平台 + 一圈白色石欄杆 → 石柱 (華表，柱身浮雕盤龍)，
// 柱上段一片橫向雲板，柱頂圓盤上金色梅花 (國道標誌)；總高約 21 m
var ZXM_MAT = null;
function zxmMats() {
  if (ZXM_MAT) return ZXM_MAT;
  const R = zxRand(91);
  const stoneTex = zxTex(256, 256, (c, w, h) => {
    c.fillStyle = '#e2e1dc'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { const g = 200 + R() * 40; c.fillStyle = `rgba(${g | 0},${g | 0},${(g - 6) | 0},0.5)`; c.fillRect(R() * w, R() * h, 2 + R() * 6, 2 + R() * 6); }
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(90,92,85,${0.04 + R() * 0.06})`; c.fillRect(R() * w, R() * h, 2 + R() * 6, 20 + R() * 80); }
  }, [1, 1]);
  // 柱身盤龍浮雕: 斜向螺旋帶 + 鱗片 + 雲紋 (灰白，凹處較暗)
  const dragon = zxTex(256, 1024, (c, w, h) => {
    c.fillStyle = '#d6d5cf'; c.fillRect(0, 0, w, h);
    for (let k = -4; k < 12; k++) {   // 龍身: 斜帶 (纏繞柱子)
      const y0 = k * 160;
      c.save(); c.beginPath(); c.moveTo(0, y0); c.lineTo(w, y0 + 120); c.lineTo(w, y0 + 190); c.lineTo(0, y0 + 70); c.closePath(); c.clip();
      c.fillStyle = '#c4c3bc'; c.fillRect(0, y0 - 10, w, 220);
      for (let yy = y0 - 20; yy < y0 + 210; yy += 12) for (let xx = (yy / 12 % 2) * 7; xx < w; xx += 14) {   // 鱗片
        c.fillStyle = 'rgba(120,120,112,0.55)'; c.beginPath(); c.arc(xx, yy, 6.5, 0, Math.PI); c.fill();
        c.fillStyle = 'rgba(245,245,240,0.6)'; c.beginPath(); c.arc(xx, yy - 1.5, 5, Math.PI, 0); c.fill();
      }
      c.restore();
      c.strokeStyle = 'rgba(95,95,88,0.7)'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, y0); c.lineTo(w, y0 + 120); c.stroke(); c.beginPath(); c.moveTo(0, y0 + 70); c.lineTo(w, y0 + 190); c.stroke();
    }
    for (let i = 0; i < 70; i++) {   // 雲紋 (小漩渦)
      const x = R() * w, y = R() * h, r = 8 + R() * 10;
      c.strokeStyle = 'rgba(110,110,104,0.45)'; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 1.6); c.stroke();
      c.beginPath(); c.arc(x + r * 0.4, y, r * 0.5, Math.PI, Math.PI * 2.6); c.stroke();
    }
  }, [1, 3]);
  const std = (o) => new T.MeshStandardMaterial(Object.assign({ roughness: 0.75, metalness: 0 }, o));
  ZXM_MAT = {
    white: std({ map: stoneTex, color: new T.Color(1, 1, 1) }), carved: std({ map: dragon, roughness: 0.8 }),
    gold: std({ color: new T.Color(0.86, 0.66, 0.26), metalness: 0.85, roughness: 0.32 }),
  };
  return ZXM_MAT;
}
/** 紀念柱 (three 本地座標: x 橫向、y 上、z 朝來車)，放在資料座標 (x, y, z)，Xd = 本地 x 軸方向 */
function zxMonument(x, y, z, Xd) {
  const M = zxmMats(), g = new T.Group();
  const lathe = (pts, mat, seg = 48) => { const m = new T.Mesh(new T.LatheGeometry(pts.map(([r, h]) => new T.Vector2(r, h)), seg), mat); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  const box = (sx, sy, sz, px, py, pz, mat, ry = 0) => { const m = new T.Mesh(new T.BoxGeometry(sx, sy, sz), mat); m.position.set(px, py, pz); m.rotation.y = ry; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  // ---- 白色大圓台座 (上窄下寬) + 兩層台階 + 上層平台
  lathe([[0, -0.6], [5.5, -0.6], [5.5, 0.05], [5.25, 0.25], [4.75, 1.75], [4.55, 1.85], [0, 1.85]], M.white);
  lathe([[0, 1.85], [3.9, 1.85], [3.9, 2.15], [3.55, 2.15], [3.55, 2.45], [0, 2.45]], M.white);
  // ---- 平台外圈石欄杆: 望柱 + 欄板 + 扶手
  const RB = 3.35, NP = 20;
  for (let k = 0; k < NP; k++) {
    const a = k / NP * Math.PI * 2, px = Math.cos(a) * RB, pz = Math.sin(a) * RB;
    box(0.22, 1.05, 0.22, px, 2.45 + 0.52, pz, M.white, -a);
    lathe([[0, 3.5], [0.14, 3.5], [0.14, 3.62], [0.08, 3.72], [0, 3.76]], M.white, 10).position.set(px, 0, pz);   // 柱頭
    const a2 = (k + 0.5) / NP * Math.PI * 2, L = 2 * RB * Math.sin(Math.PI / NP) - 0.24;
    box(L, 0.55, 0.1, Math.cos(a2) * RB, 2.45 + 0.42, Math.sin(a2) * RB, M.white, Math.PI / 2 - a2);   // 欄板
  }
  { const t = new T.Mesh(new T.TorusGeometry(RB, 0.07, 6, 64), M.white); t.rotation.x = Math.PI / 2; t.position.y = 3.38; t.castShadow = true; g.add(t); }   // 扶手
  // ---- 柱座 (須彌座)
  lathe([[0, 2.45], [1.45, 2.45], [1.45, 2.85], [1.2, 3.0], [1.05, 3.05], [1.05, 3.5], [1.25, 3.62], [1.25, 3.8], [0.82, 3.95], [0, 3.95]], M.white);
  // ---- 柱身 (盤龍浮雕) + 上中下三道箍
  { const shaft = new T.Mesh(new T.CylinderGeometry(0.58, 0.66, 13.6, 32, 1, true), M.carved); shaft.position.y = 3.95 + 6.8; shaft.castShadow = shaft.receiveShadow = true; g.add(shaft); }
  for (const hy of [4.05, 10.6, 17.45]) { const t = new T.Mesh(new T.TorusGeometry(0.66, 0.09, 8, 32), M.white); t.rotation.x = Math.PI / 2; t.position.y = hy; t.castShadow = true; g.add(t); }
  // ---- 雲板: 柱子上段橫穿一片雲朵形石板 (兩端捲雲，微微上翹)
  {
    const sh = new T.Shape(), W2 = 2.7;
    sh.moveTo(-W2, 0.15);
    sh.quadraticCurveTo(-W2 * 0.75, 0.75, -W2 * 0.45, 0.42); sh.quadraticCurveTo(-W2 * 0.25, 0.85, 0, 0.5);
    sh.quadraticCurveTo(W2 * 0.25, 0.85, W2 * 0.45, 0.42); sh.quadraticCurveTo(W2 * 0.75, 0.75, W2, 0.15);
    sh.quadraticCurveTo(W2 * 1.08, -0.25, W2 * 0.8, -0.3); sh.quadraticCurveTo(W2 * 0.55, -0.05, W2 * 0.35, -0.35);
    sh.quadraticCurveTo(0, -0.1, -W2 * 0.35, -0.35); sh.quadraticCurveTo(-W2 * 0.55, -0.05, -W2 * 0.8, -0.3);
    sh.quadraticCurveTo(-W2 * 1.08, -0.25, -W2, 0.15);
    const geo = new T.ExtrudeGeometry(sh, { depth: 0.32, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 2, curveSegments: 8 });
    geo.translate(0, 0, -0.16);
    const m = new T.Mesh(geo, M.white); m.position.y = 15.2; m.rotation.z = 0.12; m.castShadow = m.receiveShadow = true; g.add(m);
  }
  // ---- 柱頂: 圓盤 (承露盤) + 小柱座 + 金色梅花 (國道標誌，面向兩方向來車)
  lathe([[0, 17.45], [0.7, 17.45], [1.05, 17.65], [1.05, 17.85], [0.85, 17.95], [0.45, 18.05], [0.45, 18.4], [0.6, 18.5], [0, 18.55]], M.white);
  {
    const sh = new T.Shape(), Rp = 0.9, N = 120;
    for (let k = 0; k <= N; k++) { const t = k / N * Math.PI * 2 + Math.PI / 2, r = Rp * (0.74 + 0.26 * Math.pow(Math.abs(Math.cos(2.5 * (t - Math.PI / 2))), 0.7)); const px = Math.cos(t) * r, py = Math.sin(t) * r; k ? sh.lineTo(px, py) : sh.moveTo(px, py); }
    const geo = new T.ExtrudeGeometry(sh, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 2, curveSegments: 4 });
    geo.translate(0, 0, -0.11);
    const m = new T.Mesh(geo, M.gold); m.position.y = 18.55 + Rp * 0.95; m.castShadow = true; g.add(m);
    // 梅花兩面: 金色梅花上刻一個「1」(凹刻: 深金色字 + 右下亮邊，照實景)
    const ct = zxTex(256, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.font = 'bold 150px Arial, Helvetica, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#f6dc8c'; c.fillText('1', w / 2 + 5, h / 2 + 13);   // 凹槽下緣反光
      c.fillStyle = '#7a5a1c'; c.fillText('1', w / 2, h / 2 + 8);        // 刻痕 (暗)
    });
    const dm = new T.MeshStandardMaterial({ map: ct, transparent: true, alphaTest: 0.3, roughness: 0.4, metalness: 0.6 });
    for (const sd of [1, -1]) {
      const dp = new T.Mesh(new T.PlaneGeometry(Rp * 2, Rp * 2), dm);
      dp.position.set(0, 18.55 + Rp * 0.95, sd * 0.18); if (sd < 0) dp.rotation.y = Math.PI; g.add(dp);
    }
  }
  g.position.set(x, z, -y);
  g.rotation.y = Math.atan2(Xd[1], Xd[0]);
  g.updateMatrixWorld(true);
  g.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  return g;
}

/** 隧道入口前的白色名牌 (照國道 3 號街景「安坑隧道 長 455 公尺」): 洞口前 40 m、右側路肩外、兩支柱子 */
function tunnelSign(w) {
  const { P, nx, ny, hw } = w;
  // 隧道全長: 接著往前走同一條國道的隧道路段
  let len = w.len, u = w;
  for (let hop = 0; hop < 12; hop++) {
    const nxo = nextOptions(u, u.n - 1).find((o) => o.o.tunnel && !o.o.link && o.dir > 0 && o.i === 0 && (!w.ref || o.o.ref === w.ref));
    if (!nxo || nxo.o === w) break;
    u = nxo.o; len += u.len;
  }
  const name = /隧道/.test(w.name || '') ? w.name.replace(/.*?([^\s／/]*隧道).*/, '$1') : '隧道';
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#ecece6'; c.fillRect(0, 0, 512, 256);
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 6; c.strokeRect(10, 10, 492, 236);
  c.fillStyle = '#1a1a1a'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `bold ${name.length > 5 ? 64 : 84}px "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif`;
  c.fillText(name.split('').join(name.length > 5 ? '' : ' '), 256, 92);
  c.font = 'bold 50px "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
  c.fillText(`長  ${Math.round(len)}  公尺`, 256, 188);
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
  const tx = w.ny[0], ty = -w.nx[0], back = 40, lat = hw + (w.eR ? w.eR[0] : 0) + 4;
  const x = P[0] - tx * back - nx[0] * lat, y = P[1] - ty * back - ny[0] * lat, z = P[2];
  const grp = new T.Group();
  const face = new GB('uv'), plate = new GB(), posts = new GB();
  const W = 1.3, z0 = z + 1.9, z1 = z + 3.2, fx = x - tx * 0.03, fy = y - ty * 0.03;
  const v = (sx, zz, uu, vv) => face.vv([fx + nx[0] * sx, fy + ny[0] * sx, zz, uu, vv]);
  face.q(v(W, z0, 0, 0), v(-W, z0, 1, 0), v(-W, z1, 1, 1), v(W, z1, 0, 1));
  box(plate, x, y, tx, ty, 0.025, W + 0.02, z0 - 0.02, z1 + 0.02);
  for (const sd of [-0.8, 0.8]) box(posts, x + nx[0] * sd + tx * 0.06, y + ny[0] * sd + ty * 0.06, tx, ty, 0.045, 0.045, z - 1.5, z0);
  const fm = withUv(face.mesh(new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0.2, 0.2, 0.2), roughness: 0.6, side: T.DoubleSide })));   // 跟廣告看板同一種著色器組合: 不會第一次出現才編譯 (卡頓)
  for (const m of [fm, plate.mesh(matBillboardBack, { cast: true }), posts.mesh(matLampPole, { cast: true })]) if (m) grp.add(m);
  grp.userData = { x, y };
  return grp;
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
// ======================================================================= 國 1 基隆端 (港邊) 道路高度修正 (照 Google 街景)
// 原始資料: 國 1 匝道縱斷面在港邊尾端只降到 17 m (地面約 9 m)，市區道路端點又會被拉到匝道高度 → 孝二路一帶疊成好幾層假高架。
// 實景: 台 2 線 / 孝二路都是地面道路，頭頂只有標誌門架，匝道高架在前方遠處。
// 修法 (只在港邊半徑 KZ.R 內，KZ.F 外完全不動，中間漸變):
//  - 市區道路 (橋除外) 回到地面 (地形 + 0.25 m)
//  - 國道匝道: 從接上市區道路的端點往回，最多以 KZ_GRADE 坡度往上爬 (尾端降到地面、遠處真正的高架照舊)
const KZ = { x: 19034, y: 10995, R: 380, F: 480 }, KZ_GRADE = 0.065;
function kzWeight(x, y) { const d = Math.hypot(x - KZ.x, y - KZ.y); return d < KZ.R ? 1 : d > KZ.F ? 0 : 1 - (d - KZ.R) / (KZ.F - KZ.R); }
function kzGround(x, y) { const t = terrainAt(x, y); return t ? t + 0.25 : null; }
/** 匝道接市區道路的端點 (港邊街道層) */
function kzEnds() {
  const out = [];
  for (const w of WAYS) {
    if (!w || w.city || !w.link) continue;
    for (const e of [0, w.n - 1]) {
      const x = w.P[e * 3], y = w.P[e * 3 + 1];
      if (kzWeight(x, y) <= 0) continue;
      // 真正的終點: 這個端點沒有接到其他國道 / 匝道 (只能接市區道路)；原始資料匝道接街道是「12 m 內就算」，不一定共用同一點
      const fwyNext = (PT_INDEX.get(ptKey(x, y)) || []).some(([k]) => k !== w.k && WAYS[k] && !WAYS[k].city);
      if (!fwyNext && cityNear(x, y, 15)) out.push([x, y]);
    }
  }
  return out;
}
function cityNear(x, y, R) {
  for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
    const a = GRID.get(cellKey(cx, cy)); if (!a) continue;
    for (let j = 0; j < a.length; j += 2) { const o = WAYS[a[j]], i = a[j + 1]; if (o && o.city && Math.hypot(o.P[i * 3] - x, o.P[i * 3 + 1] - y) < R) return true; }
  }
  return false;
}
function kzFixWay(w) {
  if (w.kzDone || w.tunnel || params.has('nokz')) return;
  const [x0, y0, x1, y1] = w.bb, cx = Math.min(Math.max(KZ.x, x0), x1), cy = Math.min(Math.max(KZ.y, y0), y1);
  if (Math.hypot(cx - KZ.x, cy - KZ.y) > KZ.F) { w.kzDone = true; return; }
  if (w.city && w.bridge) { w.kzDone = true; return; }
  const ends = w.city ? null : kzEnds();
  if (ends && !ends.length) return;   // 港邊街道還沒載入: 之後再試
  const P = w.P, nz = new Float32Array(w.n);
  for (let i = 0; i < w.n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], k = kzWeight(x, y);
    nz[i] = z;
    if (k <= 0) continue;
    const g = kzGround(x, y);
    if (g == null) return;             // 地形還沒載入: 之後再試
    if (w.city) nz[i] = z + (g - z) * k;
    else {
      let dm = 1e9; for (const [ex, ey] of ends) dm = Math.min(dm, Math.hypot(ex - x, ey - y));
      const cap = g + KZ_GRADE * dm;
      if (cap < z) nz[i] = z + (cap - z) * k;
    }
  }
  for (let i = 0; i < w.n; i++) P[i * 3 + 2] = nz[i];
  w.kzDone = true;
}

// ---- 基隆端匝道兩側 (照街景): 外側混凝土矮牆上加綠色半透明隔音板；兩條同向匝道之間是白色斜線槽化區 + 橘色導桿 (沒有護欄)
var MAT_KZWALL = null, MAT_KZHATCH = null;   // var + 用到才建: CATS 在檔案前面就會呼叫
function matKzWall() { return MAT_KZWALL || (MAT_KZWALL = new T.MeshStandardMaterial({ color: new T.Color(0.56, 0.74, 0.6), transparent: true, opacity: 0.62, roughness: 0.2, metalness: 0, side: T.DoubleSide, depthWrite: false })); }   // 淡綠半透明壓克力板
var MAT_KZPOST = null, MAT_KZGRASS = null;
function matKzPost() { return MAT_KZPOST || (MAT_KZPOST = new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.29, 0.27), metalness: 0.5, roughness: 0.6 })); }
function matKzGrass() { return MAT_KZGRASS || (MAT_KZGRASS = new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.47, 0.15), roughness: 1 })); }   // 照街景: 亮一點的草綠
var MAT_KZLINE = null;
function matKzLine(y) { if (!MAT_KZLINE) MAT_KZLINE = {}; return MAT_KZLINE[y] || (MAT_KZLINE[y] = new T.MeshStandardMaterial({ color: y ? new T.Color(0.82, 0.6, 0.05) : new T.Color(0.82, 0.82, 0.8), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); }
var MAT_KZLOUVER = null;
/** 亮綠色百葉隔音板 (照街景): 直條紋凹凸、外框淺綠、上中下三節的接縫 */
function matKzLouver() {
  if (MAT_KZLOUVER) return MAT_KZLOUVER;
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256; const c = cv.getContext('2d');
  c.fillStyle = '#76bb3f'; c.fillRect(0, 0, 256, 256);
  for (let x = 10; x < 246; x += 9) { c.fillStyle = '#5c9b2c'; c.fillRect(x, 8, 3, 240); c.fillStyle = '#93d25a'; c.fillRect(x + 3, 8, 2, 240); }   // 直條紋 (百葉)
  c.fillStyle = '#9fd668'; c.fillRect(0, 0, 256, 8); c.fillRect(0, 248, 256, 8); c.fillRect(0, 0, 8, 256); c.fillRect(248, 0, 8, 256);       // 外框
  c.fillStyle = '#4f8526'; for (const y of [85, 170]) c.fillRect(0, y, 256, 4);                                                              // 三節接縫
  for (let k = 0; k < 60; k++) { c.fillStyle = `rgba(60,70,40,${0.04 + Math.random() * 0.06})`; c.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 10, 10 + Math.random() * 60); }   // 污漬
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
  return (MAT_KZLOUVER = new T.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.15, side: T.DoubleSide }));
}
function matKzHatch(yellow) {
  if (!MAT_KZHATCH) MAT_KZHATCH = {};
  if (MAT_KZHATCH[yellow]) return MAT_KZHATCH[yellow];
  const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d');
  c.fillStyle = '#58585a'; c.fillRect(0, 0, 256, 256);   // 柏油 (跟路面同色)
  for (let k = 0; k < 220; k++) { const g = 70 + Math.random() * 30; c.fillStyle = `rgba(${g},${g},${g - 2},0.5)`; c.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8;
  return (MAT_KZHATCH[yellow] = new T.MeshStandardMaterial({ map: t, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
}
/** 每點: 這一側 (bit 1 左 / 2 右) 7 m 內有同高度、平行的匝道 (同向或對向) → 槽化區中心的左法向偏移，否則 NaN；out.opp = 對向 */
function kzSameSide(w, bit) {
  setupShoulders(w);
  const { P, nx, ny, n, hw } = w, sd = bit === 1 ? 1 : -1, out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], tx = ny[i], ty = -nx[i], e = hw + (sd > 0 ? (w.eL ? w.eL[i] : 0) : (w.eR ? w.eR[i] : 0));
    for (let d = 0.3; d <= 7; d += 0.35) {
      const r = roadAt(x + nx[i] * sd * (e + d), y + ny[i] * sd * (e + d), z + 1, 0, 1.5);
      if (!r || r.w === w) continue;
      const dot = r.tx * tx + r.ty * ty;
      if (!r.w.city && Math.abs(r.z - z) < 1.2 && Math.abs(dot) > 0.8) { out[i] = sd * (e + d / 2); if (dot < 0) out.opp = true; }   // 對向: 黃色斜線
      break;
    }
  }
  for (let i = 1; i < n - 1; i++) if (isNaN(out[i]) && !isNaN(out[i - 1]) && !isNaN(out[i + 1])) out[i] = (out[i - 1] + out[i + 1]) / 2;
  return out;
}
function kzSideDeco(B, w, bit, nb, oAt) {
  const { P, nx, ny, s, n, hw } = w, sd = bit === 1 ? 1 : -1;
  // 槽化區 (斜線) + 橘色導桿: 兩條匝道各鋪自己這一半，導桿只由 gid 小的那條放
  const hatch = new Strip(B, nb.opp ? 'kzhatchY' : 'kzhatch', [[0, 1]]);
  for (let i = 0; i < n; i++) {
    const c = nb[i], ok = i > 0 && !isNaN(c) && !isNaN(nb[i - 1]);
    if (isNaN(c)) { hatch.add([[0, 0, 0], [0, 0, 0]], false); continue; }
    const e = sd * (hw + (sd > 0 ? (w.eL ? w.eL[i] : 0) : (w.eR ? w.eR[i] : 0))), x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2] + 0.012;
    if (kzIsland(w, nb, i)) { hatch.add([[0, 0, 0], [0, 0, 0]], false); continue; }
    const cc = 2 * c - e + sd * 0.25, a = [x + nx[i] * e, y + ny[i] * e, z, e, s[i]], b = [x + nx[i] * cc, y + ny[i] * cc, z, cc, s[i]];   // 鋪滿整個分隔帶到對面路緣 (兩條各鋪一次，不會有縫看到底下的側牆)
    hatch.add(sd > 0 ? [b, a] : [a, b], ok);
  }
  // 導桿 (照街景): 分隔帶上兩排交錯，各靠自己這側 (離中心 0.22 m)，每排 2 m 一支；gid 小的那條從 1 m 起、另一條從 2 m 起 → 交錯
  const off = (w.gid % 2) ? 1 : 2;
  for (let d = off, k = 0; d < s[n - 1]; d += 2) {
    const p = along(w, d, k); k = p.k;
    if (isNaN(nb[k]) || isNaN(nb[Math.min(k + 1, n - 1)]) || kzIsland(w, nb, k)) continue;
    const c = nb[k] - sd * 0.22, x = p.x + nx[k] * c, y = p.y + ny[k] * c, tx = ny[k], ty = -nx[k];
    box(B.g('reflBlack', x, y), x, y, tx, ty, 0.09, 0.09, p.z, p.z + 0.05);                              // 底座
    tube(B.g('gpost', x, y), [[x, y, p.z + 0.04], [x, y, p.z + 0.86]], [0.045, 0.032], 8);              // 橘色桿 (往上漸細)
    for (const h of [0.6, 0.71]) tube(B.g('gband', x, y), [[x, y, p.z + h], [x, y, p.z + h + 0.06]], [0.04, 0.038], 8);   // 白色反光帶
    tube(B.g('reflBlack', x, y), [[x, y, p.z + 0.86], [x, y, p.z + 0.9]], [0.034, 0.02], 8);            // 頂蓋
  }
  kzIslandDeco(B, w, bit, nb);
  kzOuterWall(B, w, bit, nb);
}
/** 這一點的分隔帶夠寬 (>= 2.5 m) → 綠化島 (照街景: 混凝土路緣 + 草地 + 棕櫚樹 + 長方形綠籬) */
function kzIsland(w, nb, i) {
  const c = nb[i]; if (isNaN(c)) return false;
  // 照街景: 港邊門架往南約 30 m (y < 10540) 開始中間是綠化島 (OSM 兩條匝道這裡只隔約 2 m，實際約 4~5 m)
  if (w.P[i * 3 + 1] < 10540 && w.P[i * 3 + 1] > 10380) return true;
  const sd = c > 0 ? 1 : -1, e = sd * (w.hw + (sd > 0 ? (w.eL ? w.eL[i] : 0) : (w.eR ? w.eR[i] : 0)));
  return Math.abs(c - e) * 2 >= 2.5;
}
var MAT_PALM = null, MAT_PALMT = null;
function matPalmTrunk() { return MAT_PALMT || (MAT_PALMT = new T.MeshStandardMaterial({ color: new T.Color(0.42, 0.38, 0.31), roughness: 0.95 })); }   // 灰褐色樹幹
/** 棕櫚葉 (羽狀): 中肋 + 兩側細長小葉，透明底 */
function matPalm() {
  if (MAT_PALM) return MAT_PALM;
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 512; const c = cv.getContext('2d');
  c.clearRect(0, 0, 128, 512);
  c.strokeStyle = '#5b6b2a'; c.lineWidth = 5; c.beginPath(); c.moveTo(64, 512); c.quadraticCurveTo(66, 250, 64, 0); c.stroke();
  for (let y = 16; y < 504; y += 5) {
    const L = 60 * Math.sin(Math.PI * y / 512) + 8, g = 60 + Math.random() * 45;
    c.strokeStyle = `rgb(${g * 0.6 | 0},${g + 35 | 0},${g * 0.3 | 0})`; c.lineWidth = 6;
    for (const sd of [-1, 1]) { c.beginPath(); c.moveTo(64, y); c.quadraticCurveTo(64 + sd * L * 0.6, y - 6, 64 + sd * L, y + 16); c.stroke(); }
  }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return (MAT_PALM = new T.MeshStandardMaterial({ map: t, alphaTest: 0.4, side: T.DoubleSide, roughness: 0.8 }));
}
function kzIslandDeco(B, w, bit, nb) {
  const { P, nx, ny, s, n, hw } = w, sd = bit === 1 ? 1 : -1;
  const isl = (i) => kzIsland(w, nb, i);
  const edge = (i) => sd * (hw - w.ls + 0.3);   // 島邊緣: 黃色車道線外 0.3 m (佔用內側路肩，寬度接近實景)
  // 路緣 (高 0.22、寬 0.3) + 草地 (自己這半邊)
  const curb = new Strip(B, 'skirt', [[0, 1], [1, 2]]), grass = new Strip(B, 'kzgrass', [[0, 1]]);
  for (let i = 0; i < n; i++) {
    const ok = i > 0 && isl(i) && isl(i - 1), e = edge(i), c = nb[i], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (!isl(i)) { curb.add([[0, 0, 0], [0, 0, 0], [0, 0, 0]], false); grass.add([[0, 0, 0], [0, 0, 0]], false); continue; }
    const at = (o) => [x + nx[i] * o, y + ny[i] * o], [ax, ay] = at(e), [bx, by] = at(e + sd * 0.3), [cx, cy] = at(2 * c - e - sd * 0.3);   // 草地鋪到對面路緣 (兩邊重疊，中間不會露縫)
    curb.add(sd > 0 ? [[bx, by, z + 0.22], [ax, ay, z + 0.22], [ax, ay, z]] : [[ax, ay, z], [ax, ay, z + 0.22], [bx, by, z + 0.22]], ok);
    grass.add(sd > 0 ? [[cx, cy, z + 0.2], [bx, by, z + 0.2]] : [[bx, by, z + 0.2], [cx, cy, z + 0.2]], ok);
  }
  // 植栽只由 gid 小的那條放 (島中心線上)
  const o = (() => { for (let i = 0; i < n; i++) if (isl(i)) { const off = 2 * nb[i] - sd * (hw + 0.5); const r = roadAt(P[i * 3] + nx[i] * off, P[i * 3 + 1] + ny[i] * off, P[i * 3 + 2] + 1, 0, 1.5); return r && r.w; } return null; })();
  if (o && o.gid < w.gid) return;
  let seed = (w.gid * 977) >>> 0; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // 綠籬 (長方體，長約 4.4 m、寬 1.1 m、高 0.8 m)，每 6 m 一段；棕櫚每 12 m 一棵，種在綠籬之間的空隙
  for (let d = 3, k = 0; d + 2.5 < s[n - 1]; d += 6) {
    const q = along(w, d, k); k = q.k;
    if (!isl(q.k) || !isl(Math.min(q.k + 1, n - 1))) continue;
    const c2 = nb[q.k], hxc = q.x + nx[q.k] * c2, hyc = q.y + ny[q.k] * c2, hz0 = q.z + 0.2, ux = ny[q.k], uy = -nx[q.k], wx = -uy, wy = ux;
    box(B.g('kzhedgeC', hxc, hyc), hxc, hyc, ux, uy, 2.15, 0.48, hz0, hz0 + 0.72);
    const hg = B.g('hedge', hxc, hyc);
    for (let u = -1.9; u <= 1.91; u += 0.55) for (const v of [-0.27, 0.27]) shrub(hg, hxc + ux * u + wx * v, hyc + uy * u + wy * v, hz0, 0.36, 0.42, rnd);
  }
  for (let d = 6, k = 0; d < s[n - 1]; d += 12) {
    const p = along(w, d, k); k = p.k;
    if (!isl(k) || !isl(Math.min(k + 1, n - 1))) continue;
    const c = nb[k], x = p.x + nx[k] * c, y = p.y + ny[k] * c, z = p.z + 0.2;
    {   // 棕櫚樹: 粗幹 (底部最粗) + 16 片下垂的羽狀葉
      const H = 2.8 + rnd() * 0.9;
      tube(B.g('kzpalmT', x, y), [[x, y, z], [x, y, z + H * 0.25], [x, y, z + H]], [0.24, 0.17, 0.11], 10);
      const fg = B.g('kzpalm', x, y);
      for (let f = 0; f < 16; f++) {
        const a = f / 16 * Math.PI * 2 + rnd() * 0.3, L = 1.4 + rnd() * 0.5, dx = Math.cos(a), dy = Math.sin(a), droop = 0.2 + rnd() * 0.7;
        const hx = x + dx * L * 0.9, hy = y + dy * L * 0.9, hz = z + H + 0.3 - droop * L * 0.7, px = -dy * 0.24, py = dx * 0.24;
        const b0 = fg.n;
        fg.vv([x + px * 0.3, y + py * 0.3, z + H, 0, 1]); fg.vv([x - px * 0.3, y - py * 0.3, z + H, 1, 1]);
        fg.vv([hx - px, hy - py, hz, 1, 0]); fg.vv([hx + px, hy + py, hz, 0, 0]);
        fg.q(b0, b0 + 1, b0 + 2, b0 + 3);
      }
    }
  }
  // 島頭 (兩端) 黃黑斜紋警示牌 + 灰色短柱，面向來車
  for (const i0 of [0, n - 1]) {
    let i = -1;
    if (i0 === 0) { for (let t = 0; t < n; t++) if (isl(t)) { i = t; break; } }
    else { for (let t = n - 1; t >= 0; t--) if (isl(t)) { i = t; break; } }
    if (i < 0) continue;
    const c = nb[i], tx = ny[i], ty = -nx[i], dir = i0 === 0 ? 1 : -1, x = P[i * 3] + nx[i] * c + tx * dir * 0.6, y = P[i * 3 + 1] + ny[i] * c + ty * dir * 0.6, z = P[i * 3 + 2] + 0.2;
    box(B.g('wpost', x, y), x, y, tx, ty, 0.04, 0.04, z, z + 1.25);
    const g = B.g('kzmarker', x, y), b0 = g.n, wx = -ty * 0.16, wy = tx * 0.16, fx = -tx * dir * 0.05, fy = -ty * dir * 0.05;
    for (const [vx, vy, vz, u, v] of [[x - wx + fx, y - wy + fy, z + 0.35, 0, 0], [x + wx + fx, y + wy + fy, z + 0.35, 1, 0], [x + wx + fx, y + wy + fy, z + 1.3, 1, 1], [x - wx + fx, y - wy + fy, z + 1.3, 0, 1]]) g.vv([vx, vy, vz, u, v]);
    g.q(b0, b0 + 1, b0 + 2, b0 + 3);
  }
}
var MAT_KZMARKER = null, MAT_KZHEDGEC = null;
/** 黃黑斜紋警示牌 (雙面) */
function matKzMarker() {
  if (MAT_KZMARKER) return MAT_KZMARKER;
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 192; const c = cv.getContext('2d');
  c.fillStyle = '#f2c300'; c.fillRect(0, 0, 64, 192); c.fillStyle = '#111';
  for (let k = -4; k < 12; k++) { c.beginPath(); c.moveTo(0, k * 32); c.lineTo(64, k * 32 - 40); c.lineTo(64, k * 32 - 24); c.lineTo(0, k * 32 + 16); c.fill(); }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace;
  return (MAT_KZMARKER = new T.MeshStandardMaterial({ map: t, side: T.DoubleSide, roughness: 0.5 }));
}
function matKzHedgeC() { return MAT_KZHEDGEC || (MAT_KZHEDGEC = new T.MeshStandardMaterial({ color: new T.Color(0.09, 0.2, 0.06), roughness: 1 })); }
/** 東側 (往北匝道外側，照街景): W 形鋼板護欄 + 後面矮的亮綠百葉隔音牆 (高約 1.7 m) */
function kzEastWall(B, w, bit, nb, edge, outer) {
  const { P, nx, ny, s, n, M } = w, sd = bit === 1 ? 1 : -1;
  const rail = new Strip(B, 'wbeam', WB_PROF.slice(0, -1).map((_, j) => [j, j + 1]));
  for (let i = 0; i < n; i++) {
    const f = edge(i) + sd * 0.3, x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    rail.add(WB_PROF.map(([o, h]) => [x + nx[i] * (f - sd * o), y + ny[i] * (f - sd * o), z + h]), i > 0 && outer(i) && outer(i - 1));
  }
  for (let d = 1, k = 0; d < s[n - 1]; d += 2) {   // H 型鋼立柱 + 墊塊
    const p = along(w, d, k); k = p.k;
    if (!outer(k) || !outer(Math.min(k + 1, n - 1))) continue;
    const tx = ny[k], ty = -nx[k], at = (o) => [p.x + nx[k] * (edge(k) + sd * o), p.y + ny[k] * (edge(k) + sd * o)];
    const [bx, by] = at(0.38), [qx, qy] = at(0.54), g = B.g('wpost', qx, qy);
    box(g, bx, by, tx, ty, 0.075, 0.075, p.z + 0.58, p.z + 0.84);
    box(g, qx, qy, tx, ty, 0.075, 0.05, p.z - 0.4, p.z + 0.8);
  }
  let prev = null;
  for (let d = 0.5, k = 0; d <= s[n - 1]; d += 2.3) {   // 百葉牆
    const p = along(w, d, k); k = p.k;
    const ok = outer(k) && outer(Math.min(k + 1, n - 1)), e = edge(k) + sd * 1.1, x = p.x + nx[k] * e, y = p.y + ny[k] * e, z = p.z;
    if (!ok) { prev = null; continue; }
    box(B.g('wpost', x, y), x, y, ny[k], -nx[k], 0.08, 0.08, z - 0.3, z + 2.05);
    if (prev) {
      const [qx, qy, qz] = prev, g = B.g('kzlouver', (x + qx) / 2, (y + qy) / 2), b0 = g.n;
      for (const [vx, vy, vz, u, v] of [[qx, qy, qz + 0.3, 0, 0], [x, y, z + 0.3, 1, 0], [x, y, z + 2.0, 1, 0.66], [qx, qy, qz + 2.0, 0, 0.66]]) g.vv([vx, vy, vz, u, v]);
      g.q(b0, b0 + 1, b0 + 2, b0 + 3);
    }
    prev = [x, y, z];
  }
}
/** 外側 (照街景，由路面往外): ① 混凝土路緣 (高 0.4 m) 上一道兩根圓鋼管的護欄 (矮鋼柱 2 m 一支)
 *  ② 約 0.5 m 草帶  ③ 隔音牆: 混凝土基座 + H 型鋼柱 2.3 m 一支，柱間亮綠百葉板 / 淡綠半透明壓克力板交錯 (半透明板有橫向鋁框條) */
function kzOuterWall(B, w, bit, nb) {
  setupShoulders(w);
  const { P, nx, ny, s, n, hw, M } = w, sd = bit === 1 ? 1 : -1;
  const mi = n >> 1, south = -nx[mi] < 0;   // 行進方向往南 (tangent y = -nx < 0)：西側型式；往北：東側型式
  const edge = (i) => sd * (hw + (sd > 0 ? (w.eL ? w.eL[i] : 0) : (w.eR ? w.eR[i] : 0)));
  const outer = (i) => isNaN(nb[i]) && !(M[i] & bit);
  // ① 路緣 (斷面: 內側底、內側頂、外側頂、外側底；寬 0.35)
  const curb = new Strip(B, 'skirt', [[0, 1], [1, 2], [2, 3]]);
  for (let i = 0; i < n; i++) {
    const e = edge(i), x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], at = (o) => [x + nx[i] * (e + sd * o), y + ny[i] * (e + sd * o)];
    const [ax, ay] = at(-0.02), [bx, by] = at(0.33);
    curb.add(sd > 0 ? [[bx, by, z - 0.2], [bx, by, z + 0.4], [ax, ay, z + 0.4], [ax, ay, z]] : [[ax, ay, z], [ax, ay, z + 0.4], [bx, by, z + 0.4], [bx, by, z - 0.2]], i > 0 && outer(i) && outer(i - 1));
  }
  const grass = new Strip(B, 'kzgrass', [[0, 1]]);   // ② 路緣和隔音牆之間的草帶
  for (let i = 0; i < n; i++) {
    const e = edge(i), x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2] + 0.32, a = [x + nx[i] * (e + sd * 0.33), y + ny[i] * (e + sd * 0.33), z], b = [x + nx[i] * (e + sd * 0.9), y + ny[i] * (e + sd * 0.9), z];
    grass.add(sd > 0 ? [b, a] : [a, b], i > 0 && outer(i) && outer(i - 1));
  }
  // 圓鋼管 (兩根) 沿路緣，分段建 (遇到不是外側的點就斷開)
  let run = [];
  const flush = () => {
    if (run.length > 1) for (const h of [0.72, 1.02]) { const g = B.g('wpost', run[0][0], run[0][1]); tube(g, run.map(([x, y, z]) => [x, y, z + h]), run.map(() => 0.055), 8); }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (!outer(i)) { flush(); continue; }
    const e = edge(i) + sd * 0.12; run.push([P[i * 3] + nx[i] * e, P[i * 3 + 1] + ny[i] * e, P[i * 3 + 2]]);
  }
  flush();
  for (let d = 1, k = 0; d < s[n - 1]; d += 2) {   // 鋼管護欄矮柱 + 托架
    const p = along(w, d, k); k = p.k;
    if (!outer(k) || !outer(Math.min(k + 1, n - 1))) continue;
    const e = edge(k), tx = ny[k], ty = -nx[k], at = (o) => [p.x + nx[k] * (e + sd * o), p.y + ny[k] * (e + sd * o)];
    const [px, py] = at(0.2), [bx, by] = at(0.13), g = B.g('wpost', px, py);
    box(g, px, py, tx, ty, 0.06, 0.04, p.z + 0.4, p.z + 1.05);
    for (const h of [0.72, 1.02]) box(g, bx, by, tx, ty, 0.03, 0.06, p.z + h - 0.06, p.z + h + 0.03);
  }
  // ③ 隔音牆: 每 2.3 m 一格 (柱 → 柱)，百葉 4 格 / 半透明 3 格交錯
  const WO = 0.95, BASE = 0.4, TOPH = south ? 2.3 : 2.0;   // 照街景: 板子頂端約在相機 (視線) 高度；東側稍矮
  let prev = null, cell = 0, vseed = (w.gid * 7919) >>> 0; const vrnd = () => ((vseed = (vseed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let d = 0.5, k = 0; d <= s[n - 1]; d += 2.3) {
    const p = along(w, d, k); k = p.k;
    const ok = outer(k) && outer(Math.min(k + 1, n - 1));
    const e = edge(k) + sd * WO, x = p.x + nx[k] * e, y = p.y + ny[k] * e, z = p.z;
    if (ok) {
      box(B.g('kzpost', x, y), x, y, ny[k], -nx[k], 0.1, 0.1, z - 0.3, z + BASE + TOPH + 0.05);   // H 型鋼柱 (深灰帶鏽)
      if (prev) {
        const [qx, qy, qz] = prev, louver = !south || cell % 7 < 4 || (y + qy) / 2 < 10545, cat = louver ? 'kzlouver' : 'kzwall';   // 西側: 百葉 4 格 / 半透明 3 格交錯；東側: 全部百葉
        const g = B.g(cat, (x + qx) / 2, (y + qy) / 2), b0 = g.n;
        for (const [vx, vy, vz, u, v] of [[qx, qy, qz + BASE, 0, 0], [x, y, z + BASE, 1, 0], [x, y, z + BASE + TOPH, 1, 1], [qx, qy, qz + BASE + TOPH, 0, 1]]) g.vv([vx, vy, vz, u, v]);
        g.q(b0, b0 + 1, b0 + 2, b0 + 3);
        // 基座 (混凝土) + 半透明板的橫向鋁框條
        const mx = (x + qx) / 2, my = (y + qy) / 2, len = Math.hypot(x - qx, y - qy) / 2, ux = (x - qx) / (2 * len || 1), uy = (y - qy) / (2 * len || 1), mz = (z + qz) / 2;
        box(B.g('skirt', mx, my), mx, my, ux, uy, len, 0.15, mz - 0.3, mz + BASE);
        if (!louver) for (const h of [0.75, 1.5, 2.25]) box(B.g('wpost', mx, my), mx, my, ux, uy, len, 0.04, mz + BASE + h - 0.04, mz + BASE + h + 0.04);
        box(B.g('wpost', mx, my), mx, my, ux, uy, len, 0.06, mz + BASE + TOPH - 0.06, mz + BASE + TOPH + 0.04);   // 頂框
        {   // 牆頂垂下的藤蔓 (照街景: 爬滿牆頂，部分垂到牆面中段)
          const vg = B.g('hedge', mx, my), rx = -nx[k] * sd, ry = -ny[k] * sd;
          for (let u = -len + 0.3; u < len; u += 0.7) {
            const vx = mx + ux * u + rx * 0.12, vy = my + uy * u + ry * 0.12, hang = vrnd();
            shrub(vg, vx, vy, mz + BASE + TOPH - 0.35 - hang * 0.5, 0.42, 0.3 + hang * 0.25, vrnd);
          }
        }
        cell++;
      }
      prev = [x, y, z];
    } else prev = null;
  }
}

// ======================================================================= 基隆端港邊門架 (照 Google 街景 2024，25.12449N 121.73663E)
// 實景: 生鏽的鍍鋅鋼管箱型桁架 (上下弦桿 + 直桿 + 斜撐)，下方用托架吊一根槽鋼橫梁 (掛牌子)；兩端格構柱。
// 朝北 (給往北車輛) 掛: 藍「↑ 基隆車站 Keelung Station」+ 咖啡「↑ 基隆廟口夜市 Keelung Night Market」、限速 40、
// 綠「↑ 東岸高架橋 / ↑ ② 濱海公路 / 西岸高架橋 ↗」；東柱: 兩台監視器、直式綠牌「西岸高架橋靠右」；
// 西柱 (給往南車輛): 「南 SOUTH」+ 國道 1 號梅花牌 + 「↑」
const KZG = { gid: 1200, x: 18783.5, y: 10571.0, z: 24.67, nx: 0.883, ny: -0.468, u0: -7.6, u1: 21.9 };
function kzSignTex(w, h, draw) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h); const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8; return t; }
const KZ_HEI = '"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif', KZ_EN = 'Arial,"Helvetica Neue",sans-serif';
function kzArrow(c, x, y, s, ang = 0, col = '#fff') {   // 實心箭頭 (ang 0 = 往上)
  c.save(); c.translate(x, y); c.rotate(ang); c.fillStyle = col; c.beginPath();
  c.moveTo(0, -s * 0.5); c.lineTo(s * 0.36, -s * 0.08); c.lineTo(s * 0.12, -s * 0.08); c.lineTo(s * 0.12, s * 0.5); c.lineTo(-s * 0.12, s * 0.5); c.lineTo(-s * 0.12, -s * 0.08); c.lineTo(-s * 0.36, -s * 0.08); c.closePath(); c.fill(); c.restore();
}
function kzPanel(c, w, h, bg, r = 14) { c.fillStyle = bg; c.beginPath(); c.roundRect(0, 0, w, h, r); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 6; c.beginPath(); c.roundRect(8, 8, w - 16, h - 16, r - 4); c.stroke(); }
function kzGantry() {
  const grp = new T.Group();
  const { x: X0, y: Y0, z: Z0, nx, ny } = KZG, tx = ny, ty = -nx;   // n: 往東 (橫跨)，t: 往南 (1200 行進方向)
  const W = (u, v, h) => [X0 + nx * u + tx * v, Y0 + ny * u + ty * v, Z0 + h];
  const steel = new T.MeshStandardMaterial({ color: new T.Color(0.52, 0.47, 0.42), metalness: 0.55, roughness: 0.62 });
  const g = new GB();
  const pipe = (a, b, r) => tube(g, [W(...a), W(...b)], [r, r], 6);
  const H0 = 6.9, H1 = 8.1, BW = 0.45, u0 = KZG.u0, u1 = KZG.u1;
  // 箱型桁架: 四根弦桿 + 每 1.5 m 直桿 / 斜撐 (前後兩面 + 上下兩面)
  for (const v of [-BW, BW]) for (const h of [H0, H1]) pipe([u0, v, h], [u1, v, h], 0.07);
  let k = 0;
  for (let u = u0; u < u1 - 0.01; u += 1.5, k++) {
    const u2 = Math.min(u + 1.5, u1);
    for (const v of [-BW, BW]) { pipe([u, v, H0], [u, v, H1], 0.04); pipe(k % 2 ? [u, v, H0] : [u, v, H1], k % 2 ? [u2, v, H1] : [u2, v, H0], 0.035); }
    pipe([u, -BW, H1], [u, BW, H1], 0.035); pipe([u, -BW, H0], [u, BW, H0], 0.035); pipe([u, -BW, H1], [u2, BW, H1], 0.03);
  }
  pipe([u1, -BW, H0], [u1, -BW, H1], 0.04); pipe([u1, BW, H0], [u1, BW, H1], 0.04);
  // 下方槽鋼橫梁 (北側，掛牌子) + 吊架
  const CH = 6.25, CV = 0.75;   // 槽鋼橫梁在南側 (往北車輛看得到的那面，牌子掛在桁架前面)
  { const a = W(u0 + 1.5, CV, CH), b = W(u1 - 0.8, CV, CH), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    box(g, mx, my, nx, ny, len, 0.07, Z0 + CH - 0.09, Z0 + CH + 0.09); }
  for (let u = u0 + 2; u < u1 - 1; u += 3) pipe([u, CV, CH], [u, BW, H0], 0.03);
  // 格構柱 (兩端): 兩支方管腳 + 斜撐
  for (const uc of [u0, u1]) {
    for (const v of [-BW, BW]) { const [px, py] = W(uc, v, 0); box(g, px, py, nx, ny, 0.09, 0.09, Z0 - 0.6, Z0 + H1 + 0.1); }
    for (let h = 0.3; h < H1; h += 1.1) pipe([uc, -BW, h], [uc, BW, h + 1.1], 0.03);
    const [bx, by] = W(uc, 0, 0); box(g, bx, by, nx, ny, 0.35, 0.7, Z0 - 0.6, Z0 + 0.05);   // 基座
  }
  // 東柱監視器 (兩台)
  for (const [dv, dh] of [[0.2, 7.35], [-0.3, 7.05]]) { const [cx, cy] = W(u1 + 0.35, dv, 0); box(g, cx, cy, tx, ty, 0.22, 0.09, Z0 + dh - 0.09, Z0 + dh + 0.09); }
  const sm = g.mesh(steel, { cast: true }); grp.add(sm);
  // ---- 牌子 (平面 + 背板)
  const back = new T.MeshStandardMaterial({ color: new T.Color(0.45, 0.46, 0.47), metalness: 0.5, roughness: 0.5 });
  const sign = (tex, uc, hc, w, h, face, vOff = CV + 0.12, noBack = false) => {   // face: +1 朝南 (給往北車)、-1 朝北
    const mat = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0.2, 0.2, 0.2), roughness: 0.55, transparent: true, alphaTest: 0.3 });
    const gg = new GB('uv'), fv = vOff + face * 0.0;
    const p = (du, dh, uu, vv) => { const q = W(uc + du * face, fv + face * 0.03, hc + dh); return gg.vv([q[0], q[1], q[2], uu, vv]); };
    const a = p(-w / 2, -h / 2, 0, 0), b = p(w / 2, -h / 2, 1, 0), c = p(w / 2, h / 2, 1, 1), d = p(-w / 2, h / 2, 0, 1);
    gg.q(a, b, c, d); grp.add(withUv(gg.mesh(mat, { cast: false })));
    if (!noBack) { const bb = new GB(), [bx, by] = W(uc, fv - face * 0.02, 0); box(bb, bx, by, nx, ny, w / 2, 0.02, Z0 + hc - h / 2, Z0 + hc + h / 2); grp.add(bb.mesh(back, { cast: true })); }
  };
  // 藍 + 咖啡 (上下)
  sign(kzSignTex(512, 230, (c, w, h) => { kzPanel(c, w, h, '#1b5fb5'); kzArrow(c, 58, h / 2, 120); c.fillStyle = '#fff'; c.beginPath(); c.roundRect(118, 52, 74, 92, 10); c.fill(); c.fillStyle = '#1b5fb5'; c.font = 'bold 54px ' + KZ_HEI; c.textAlign = 'center'; c.fillText('🚉', 155, 118);
    c.fillStyle = '#fff'; c.textAlign = 'left'; c.font = 'bold 66px ' + KZ_HEI; c.fillText('基隆車站', 208, 112); c.font = 'bold 36px ' + KZ_EN; c.fillText('Keelung Station', 210, 190); }), 11.8, H0 + 0.05 - 0.695, 3.1, 1.39, 1);   // 頂部對齊下弦桿
  sign(kzSignTex(512, 230, (c, w, h) => { kzPanel(c, w, h, '#6b3a1f'); kzArrow(c, 58, h / 2, 120); c.fillStyle = '#fff'; c.font = 'bold 60px ' + KZ_HEI; c.fillText('基隆廟口夜市', 112, 106); c.font = 'bold 34px ' + KZ_EN; c.fillText('Keelung Night Market', 116, 186); }), 11.8, H0 + 0.05 - 1.39 - 0.02 - 0.695, 3.1, 1.39, 1);   // 緊接在藍牌下面
  // 限速 40
  sign(kzSignTex(256, 256, (c, w, h) => { c.clearRect(0, 0, w, h); c.fillStyle = '#fff'; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill(); c.fillStyle = '#d0202a'; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.arc(128, 128, 96, 0, 7, true); c.fill('evenodd'); c.fillStyle = '#111'; c.font = 'bold 110px ' + KZ_EN; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('40', 128, 134); }), 14.6, H0 - 0.55, 1.2, 1.2, 1, CV + 0.08, true);   // 圓牌直接鎖在橫梁上，沒有背板
  // 綠色三行
  sign(kzSignTex(512, 560, (c, w, h) => {
    kzPanel(c, w, h, '#0b6e3c'); c.strokeStyle = '#fff'; c.lineWidth = 5; for (const y of [186, 372]) { c.beginPath(); c.moveTo(14, y); c.lineTo(w - 14, y); c.stroke(); }
    c.fillStyle = '#fff'; c.textAlign = 'left';
    kzArrow(c, 52, 92, 110); c.font = 'bold 74px ' + KZ_HEI; c.fillText('東岸高架橋', 110, 98); c.font = 'bold 34px ' + KZ_EN; c.fillText('Dong-an Viaduct', 150, 160);
    kzArrow(c, 52, 278, 110); c.beginPath(); c.arc(140, 268, 40, 0, 7); c.fill(); c.fillStyle = '#1d4f9c'; c.beginPath(); c.arc(140, 268, 32, 0, 7); c.fill(); c.fillStyle = '#fff'; c.font = 'bold 44px ' + KZ_EN; c.textAlign = 'center'; c.fillText('2', 140, 284);
    c.textAlign = 'left'; c.font = 'bold 74px ' + KZ_HEI; c.fillText('濱海公路', 196, 290); c.font = 'bold 34px ' + KZ_EN; c.fillText('Coast Freeway', 200, 350);
    c.font = 'bold 74px ' + KZ_HEI; c.fillText('西岸高架橋', 30, 462); c.font = 'bold 34px ' + KZ_EN; c.fillText('Shi-an Viaduct', 40, 528); kzArrow(c, 450, 480, 110, Math.PI / 4);
  }), 17.6, H0 + 0.05 - 1.5, 2.75, 3.0, 1);   // 頂部對齊下弦桿
  // 東柱直式綠牌「西岸高架橋靠右」
  sign(kzSignTex(140, 640, (c, w, h) => { kzPanel(c, w, h, '#0b6e3c', 10); c.fillStyle = '#fff'; c.font = 'bold 84px ' + KZ_HEI; c.textAlign = 'center'; [...'西岸高架橋靠右'].forEach((ch, i) => c.fillText(ch, w / 2, 92 + i * 84)); }), u1, 3.9, 0.62, 2.85, 1, BW + 0.13);   // 貼在東柱南面
  // 西柱 (給往南車): 南 SOUTH / 國道 1 號梅花 / ↑
  sign(kzSignTex(256, 170, (c, w, h) => { c.fillStyle = '#fff'; c.beginPath(); c.roundRect(0, 0, w, h, 10); c.fill(); c.strokeStyle = '#222'; c.lineWidth = 5; c.beginPath(); c.roundRect(7, 7, w - 14, h - 14, 8); c.stroke(); c.fillStyle = '#111'; c.textAlign = 'center'; c.font = 'bold 78px ' + KZ_HEI; c.fillText('南', w / 2, 88); c.font = 'bold 40px ' + KZ_EN; c.fillText('SOUTH', w / 2, 146); }), u0 - 0.05, 5.0, 0.82, 0.55, -1, -BW - 0.3);
  sign(kzSignTex(256, 256, (c, w, h) => { c.clearRect(0, 0, w, h); const pl = (k, col) => { c.fillStyle = col; c.beginPath(); for (let i = 0; i <= 120; i++) { const t = i / 120 * Math.PI * 2 + Math.PI / 2, r = w * 0.5 * k * (0.74 + 0.26 * Math.pow(Math.abs(Math.cos(2.5 * (t - Math.PI / 2))), 0.7)); const px = w / 2 + Math.cos(t) * r, py = h / 2 - Math.sin(t) * r; i ? c.lineTo(px, py) : c.moveTo(px, py); } c.closePath(); c.fill(); }; pl(0.98, '#0b6e3c'); pl(0.84, '#ffffff'); c.fillStyle = '#111'; c.font = 'bold 130px ' + KZ_EN; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('1', w / 2, h / 2 + 6); }), u0 - 0.05, 4.25, 0.82, 0.82, -1, -BW - 0.3);
  sign(kzSignTex(200, 140, (c, w, h) => { c.fillStyle = '#fff'; c.beginPath(); c.roundRect(0, 0, w, h, 10); c.fill(); c.strokeStyle = '#222'; c.lineWidth = 5; c.beginPath(); c.roundRect(7, 7, w - 14, h - 14, 8); c.stroke(); kzArrow(c, w / 2, h / 2, 100, 0, '#111'); }), u0 - 0.05, 3.62, 0.6, 0.42, -1, -BW - 0.3);
  const c0 = W(0, 0, 0); grp.userData = { x: c0[0], y: c0[1] };
  return grp;
}

function* buildTile(rec) {
  const B = new Build();
  // 建模前先修高度 (路面、護欄、物理都用同一份)；港邊街道 / 地形資料還沒到齊就等一下 (最多約 10 秒)，不然會用舊高度建出浮空的路面
  for (let tries = 0; tries < 600; tries++) {
    for (const k of rec.ways) kzFixWay(WAYS[k]);
    if (rec.ways.every((k) => WAYS[k].kzDone || WAYS[k].tunnel || params.has('nokz'))) break;
    yield;
  }
  for (const k of rec.ways) {
    const w = WAYS[k];
    if (w.city) { if (!params.has('nocr')) addCityRoad(B, w); }
    else { addRoad(B, w); if (w.ramps && !params.has('nogore')) for (const r of w.ramps) addGore(B, w, r); }
    yield;
  }
  for (let k = 0; k < rec.piers.length / 9; k++) addPier(B, rec.piers, k);
  if (!params.has('nokzg') && rec.ways.some((k) => WAYS[k].gid === KZG.gid)) { const m = kzGantry(); B.chunk(m.userData.x, m.userData.y).extra.push(m); }   // 基隆端港邊門架 (照街景)
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
      if (cat === 'bboard' || cat === 'kmface' || cat === 'exitface' || cat === 'hedge' || cat === 'kzhatch' || cat === 'kzhatchY' || cat === 'kzlouver' || cat === 'kzwall' || cat === 'kzpalm' || cat === 'kzmarker') withUv(m);
      g.add(m); ch.meshes.push(m); ch.kinds.push(kind); ch.casts.push(!!cast);
      yield;   // 每個網格 (算法向量、建緩衝) 分開做，不要一個小塊全部擠在同一幀 (卡頓)
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
