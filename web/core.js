/* 台灣 1:1 — 核心: 資料載入、路網、地形查詢
 * 座標: 資料 (x 東, y 北, z 上) 公尺 -> three.js (x, z, -y)
 * 所有模組共用 window.TW；這個檔案只放「沒有畫面」的東西 (Worker 以外也能單獨測)
 */
(function () {
'use strict';
const T = window.THREE;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const setStatus = (s) => { const el = $('loading-msg'); if (el) el.textContent = s; };
const HOOKS = { tile: [], key: [], minimap: [], frame: [], update: [], init: [], navBias: null, wayColor: null, leader: null, laneFree: null };

// ======================================================================= 分區資料
// tiles/index.json: 全域資訊；tiles/t/*.bin: 地形；tiles/d/*.bin: 路段 + 橋墩 + 建築 (scripts/tile_web.py)
// 單檔 台灣.html 把分區內嵌成 <script id="tile-d-x_y">；GitHub Pages 版 (index.html) 用到才下載
function b64buf(str) {
  const bin = atob(str.trim()), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
const INDEX = JSON.parse($('tile-index').textContent);
const TS = INDEX.ts, TC = INDEX.tc, TSTEP = INDEX.step, TN = TC + 3;   // 地形分區含 1 格外框
const TGI = INDEX.terrain;                                               // 全域地形格點範圍 (J = x / step, I = y / step)
const TILE_BASE = (params.get('tiles') || (location.protocol === 'file:' ? 'https://liug1217.github.io/TAIWAN/tiles/' : 'tiles/')).replace(/\/?$/, '/');
const tkey = (tx, ty) => tx + '_' + ty;
/** 內嵌的分區直接解碼 (同步回傳 ArrayBuffer)，否則下載 (回傳 Promise) */
function tileBuf(kind, key) {
  const el = document.getElementById('tile-' + kind + '-' + key);
  if (el) { const b = b64buf(el.textContent); el.remove(); return b; }
  return limitedFetch(TILE_BASE + kind + '/' + key + '.bin');
}
// 同時最多 8 個下載
let fetching = 0;
const fetchQueue = [];
function limitedFetch(url) {
  return new Promise((resolve, reject) => {
    const run = () => {
      fetching++;
      fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(resolve, reject).finally(() => { fetching--; if (fetchQueue.length) fetchQueue.shift()(); });
    };
    if (fetching < 8) run(); else fetchQueue.push(run);
  });
}

// ======================================================================= 路段
const LANE_W = 3.75;
const WAYS = [];            // 依載入順序；w.k = 索引，w.gid = 全域編號 (live.json、傳送地點用)
const GID = new Map();
const wayByGid = (g) => { const k = GID.get(g); return k == null ? null : WAYS[k]; };
const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
const PT_INDEX = new Map(); // 座標 -> [[way, idx], ...]
const RAMP_PENDING = [];
// 空間索引: 40 m 格子 -> [wayIdx, segIdx, ...]
const CELL = 40;
const GRID = new Map();
const cellKey = (cx, cy) => cx * 100003 + cy;
function indexWay(w) {
  for (let i = 0; i < w.n; i++) {
    const key = ptKey(w.P[i * 3], w.P[i * 3 + 1]);
    let a = PT_INDEX.get(key); if (!a) PT_INDEX.set(key, a = []); a.push([w.k, i]);
  }
  const r = w.hw + 2;
  for (let i = 0; i < w.n - 1; i++) {
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], bx = w.P[i * 3 + 3], by = w.P[i * 3 + 4];
    const cx0 = Math.floor((Math.min(ax, bx) - r) / CELL), cx1 = Math.floor((Math.max(ax, bx) + r) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - r) / CELL), cy1 = Math.floor((Math.max(ay, by) + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = cellKey(cx, cy);
      let a = GRID.get(key); if (!a) GRID.set(key, a = []); a.push(w.k, i);
    }
  }
}
function makeWay(w) {
  const n = w.n = w.P.length / 3;
  w.k = WAYS.length; w.hw = w.width / 2;
  if (!w.U) w.U = new Float32Array(n);
  if (!w.M) w.M = new Uint8Array(n);
  // 左法向與累積距離
  w.nx = new Float32Array(n); w.ny = new Float32Array(n); w.s = new Float32Array(n);
  wayGeom(w);
  WAYS.push(w); GID.set(w.gid, w.k); indexWay(w);
  return w;
}
/** 左法向、累積距離、外框、長度 (路形改過要重算) */
function wayGeom(w) {
  const n = w.n;
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
    const dx = w.P[b * 3] - w.P[a * 3], dy = w.P[b * 3 + 1] - w.P[a * 3 + 1], L = Math.hypot(dx, dy) || 1;
    w.nx[i] = -dy / L; w.ny[i] = dx / L;
    if (i > 0) w.s[i] = w.s[i - 1] + Math.hypot(w.P[i * 3] - w.P[i * 3 - 3], w.P[i * 3 + 1] - w.P[i * 3 - 2], w.P[i * 3 + 2] - w.P[i * 3 - 1]);
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = w.P[i * 3], y = w.P[i * 3 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  w.bb = [x0 - w.hw, y0 - w.hw, x1 + w.hw, y1 + w.hw];
  w.len = w.s[n - 1];
}
// 路形修正: 國 1 基隆端 0K 到中興 / 大業隧道洞口只有約 100 m，OSM 兩方向從間距 16 m 直線拉開到 31 m (V 字形、不平行)。
// 照實景改成: 靠近洞口順著隧道方向平行延伸，再用 S 形慢慢收窄接回 0K 端點 (兩端接點不動)。
// { gid 引道, tun 隧道, toPortal: 引道的終點接洞口 (南下) / 起點接洞口 (北上) }
const GEOM_FIX = [{ gid: 1158, tun: 1140, toPortal: true }, { gid: 1141, tun: 1157, toPortal: false }];
function applyGeomFixes() {
  for (const f of GEOM_FIX) {
    if (f.done || params.has('nogeomfix')) continue;
    const w = wayByGid(f.gid), t = wayByGid(f.tun);
    if (!w || !t) continue;
    f.done = true;
    // 洞口點與隧道方向 (南下: 隧道起點；北上: 隧道終點)
    const e = f.toPortal ? 0 : t.n - 1, px = t.P[e * 3], py = t.P[e * 3 + 1], tx = t.ny[e], ty = -t.nx[e];
    const L = w.len;
    for (let i = 0; i < w.n; i++) {
      const d = f.toPortal ? L - w.s[i] : w.s[i];               // 離洞口距離
      const u = Math.min(1, d / L), k = 1 - u * u * (3 - 2 * u);   // 洞口 1 → 0K 端 0
      const lx = f.toPortal ? px - tx * d : px + tx * d, ly = f.toPortal ? py - ty * d : py + ty * d;
      w.P[i * 3] += (lx - w.P[i * 3]) * k; w.P[i * 3 + 1] += (ly - w.P[i * 3 + 1]) * k;
    }
    wayGeom(w); indexWay(w);   // 格子索引重加 (舊格子裡多出來的項目 roadAt 會自己用幾何判斷掉)
  }
}
/** 高度 Int16 (0.1 m): 3276.8 m 以上存的時候會繞回負數，小於 -500 m 的值加 65536 換回來 */
const Z16 = (v) => (v < -5000 ? v + 65536 : v) * 0.1;
/** 細節分區 -> 路段 (加入 WAYS)、橋墩、建築。格式見 scripts/tile_web.py pack_detail */
function ingestDetail(buf) {
  const jl = new DataView(buf).getUint32(0, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  let o = 4 + jl;
  const f32 = (n) => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const i16 = (n) => { const a = new Int16Array(buf, o, n); o += n * 2; return a; };
  const ncw = hd.cw.length;
  const fP = f32(hd.np * 3), fU = f32(hd.np), piers = f32(hd.npier * 9), rxy0 = f32(ncw * 2);
  const bxy0 = f32(hd.nb * 2), bbase = f32(hd.nb), bh = f32(hd.nb);
  const roff = i16(hd.cnp * 2), rz = i16(hd.cnp), boff = i16(hd.nbv * 2);
  const bcnt = new Uint16Array(buf, o, hd.nb); o += hd.nb * 2;
  const emask = new Uint8Array(buf, o, hd.np); o += hd.np;   // bit0 左路緣、bit1 右路緣落在別條路面上、bit2 匝道整段在主線內
  const bcol = new Uint8Array(buf, o, hd.nb);
  const ways = [];
  let p = 0;
  for (let q = 0; q < hd.fw.length; q++) {   // 國道 / 快速道路
    const m = hd.fw[q], n = hd.fc[q];
    ways.push(makeWay({
      gid: m[0], ref: m[1], name: m[2], lanes: m[3], ls: m[4], rs: m[5], width: m[6],
      bridge: !!(m[7] & 1), tunnel: !!(m[7] & 2), link: !!(m[7] & 4), oneway: !!(m[7] & 8),
      maxspeed: m[8], trunk: !!m[9], cls: m[9] ? 1 : 0,
      P: fP.subarray(p * 3, (p + n) * 3), U: fU.subarray(p, p + n), M: emask.subarray(p, p + n),
    }).k);
    p += n;
  }
  // 一般道路: 第一點 + 0.1 m 相對座標
  const cp = new Float32Array(hd.cnp * 3);
  for (let k = 0, v = 0; k < ncw; k++) for (let i = 0; i < hd.cc[k]; i++, v++) {
    cp[v * 3] = rxy0[k * 2] + roff[v * 2] * 0.1; cp[v * 3 + 1] = rxy0[k * 2 + 1] + roff[v * 2 + 1] * 0.1; cp[v * 3 + 2] = Z16(rz[v]);
  }
  p = 0;
  for (let q = 0; q < ncw; q++) {
    const m = hd.cw[q], n = hd.cc[q];
    // 雙向一般道路 (非巷道) 被標成 1 線道: 至少當 2 線道 (每向 1 線)、寬 7.1 m，不然對向車會擦撞
    let lanes = m[2], width = m[4];
    if (!m[3] && m[1] <= 4 && lanes < 2) { lanes = 2; width = Math.max(width, 7.1); }
    ways.push(makeWay({ gid: m[0], ref: '', name: m[6], cls: m[1], lanes, oneway: !!m[3], width, bridge: !!m[5], tunnel: false,
      link: m[1] === 6, ls: 0.3, rs: 0.3, maxspeed: 0, city: true, P: cp.subarray(p * 3, (p + n) * 3) }).k);
    p += n;
  }
  const bxy = new Float32Array(hd.nbv * 2);
  for (let b = 0, v = 0; b < hd.nb; b++) for (let i = 0; i < bcnt[b]; i++, v++) {
    bxy[v * 2] = bxy0[b * 2] + boff[v * 2] * 0.1; bxy[v * 2 + 1] = bxy0[b * 2 + 1] + boff[v * 2 + 1] * 0.1;
  }
  if (hd.ramp) { for (const r of hd.ramp) RAMP_PENDING.push(r); resolveRamps(); }
  applyGeomFixes();
  return { ways, piers, bld: hd.nb ? { bxy, bbase, bh, bcnt, bcol, nb: hd.nb } : null };
}
// 匝道接主線 (scripts/fix_clip.mjs): 匝道端點已移到主線外側，記錄 [匝道 gid, 端點, 在主線哪一側, 主線 gid, 原本重合的主線點]。
// 兩條路都載入後在路網上接起來，並讓匝道知道要畫槽化區
/** 主線 gid -> [{ mi 分岔點, gid 匝道 }] (出口預告牌用) */
const DIVERGE = new Map();
function resolveRamps() {
  for (let j = RAMP_PENDING.length - 1; j >= 0; j--) {
    const [gid, e, side, mgid, mi] = RAMP_PENDING[j];
    const w = wayByGid(gid), m = wayByGid(mgid);
    if (!w || !m) continue;
    (w.ramps ||= []).push({ e, side, mgid, mi });
    if (e === 0 && mi >= 0) { let a = DIVERGE.get(mgid); if (!a) DIVERGE.set(mgid, a = []); a.push({ mi, gid }); }   // 出口: 主線 mgid 第 mi 點分出匝道
    if (mi >= 0 && mi < m.n) {
      const add = (key, k, i) => { let a = PT_INDEX.get(key); if (!a) PT_INDEX.set(key, a = []); if (!a.some(([kk, ii]) => kk === k && ii === i)) a.push([k, i]); };
      add(ptKey(w.P[e * 3], w.P[e * 3 + 1]), m.k, mi);
      add(ptKey(m.P[mi * 3], m.P[mi * 3 + 1]), w.k, e);
    }
    RAMP_PENDING.splice(j, 1);
  }
}

/** 找 (x,y) 處、高度不高於 zRef+climb 的最高路面。margin: 距路緣保留寬度。
 *  國道主線兩側有多鋪的路肩 (w.eL / w.eR，見 setupShoulders)，左右邊界逐點不同 */
/** wedge: 玩家物理用。國道路段在分岔處結束時，路面往前多延伸 WEDGE m、寬度漸縮到 0 (漏斗)：
 *  OSM 車道數在分岔點常對不起來 (3 線分成 1 + 1)，外側車道前面是洞，沒有漏斗會撞上一面看不見的平牆 */
const WEDGE = 20;
function roadAt(x, y, zRef, margin, climb = 1.3, prefer = null, wedge = false) {
  const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!a) return null;
  let best = null, bp = null;
  for (let q = 0; q < a.length; q += 2) {
    const w = WAYS[a[q]], i = a[q + 1], P = w.P;
    const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
    const dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L = Math.hypot(dx, dy);
    if (L < 1e-3) continue;
    const t = ((x - ax) * dx + (y - ay) * dy) / (L * L), ext = 1.5 / L;
    const wx = wedge && !w.city && i === w.n - 2 ? WEDGE / L : 0;
    if (t < -ext || t > 1 + Math.max(ext, wx)) continue;
    const lat = ((x - ax) * -dy + (y - ay) * dx) / L, tc = Math.min(Math.max(t, 0), 1);
    if (wx && t > 1 + ext) {   // 漏斗段
      const k = 1 - (t - 1) * L / WEDGE;
      if (Math.abs(lat) > (w.hw + (lat > 0 ? (w.eL ? w.eL[i + 1] : 0) : (w.eR ? w.eR[i + 1] : 0))) * k - margin) continue;
    } else if (w.eL) {
      if (lat > w.hw + w.eL[i] + (w.eL[i + 1] - w.eL[i]) * tc - margin || -lat > w.hw + w.eR[i] + (w.eR[i + 1] - w.eR[i]) * tc - margin) continue;
    } else if (Math.abs(lat) > w.hw - margin) continue;
    const z = az + (P[i * 3 + 5] - az) * tc;
    if (z > zRef + climb) continue;
    const c = { z, w, i, t: tc, lat, tx: dx / L, ty: dy / L };
    if (!best || z > best.z) best = c;
    if (w === prefer && (!bp || z > bp.z)) bp = c;
  }
  // 分合流處兩條路面同高重疊: 留在原本那條路 (不然「目前道路」來回跳，車道置中會亂拉)
  if (bp && best.z - bp.z < 0.6) return bp;
  return best;
}
/** (x, y) 這個 40 m 格子裡有沒有一般道路 (判斷國道旁邊是不是市區用) */
function cityAt(x, y) {
  const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (a) for (let j = 0; j < a.length; j += 2) { const w = WAYS[a[j]]; if (w && w.city) return true; }
  return false;
}

// ======================================================================= 地形
const TERR = new Map();       // 地形分區 key -> Int16Array (TN x TN, 0.1 m)
const LCLS = new Map();       // 地形分區 key -> Uint8Array 地表分類 (0 未知 1 水 2 沙 3 砂石 4 濕地 5 都市 6 農田 7 森林 8 草地)
function landcoverAt(x, y) {
  const J = Math.round(x / TSTEP), I = Math.round(y / TSTEP), tx = Math.floor(J / TC), ty = Math.floor(I / TC);
  const a = LCLS.get(tkey(tx, ty));
  return a ? a[(I - ty * TC + 1) * TN + (J - tx * TC + 1)] : 0;
}
function terrainAt(x, y) {
  const J = Math.min(Math.max(x / TSTEP, TGI.J0), TGI.J0 + TGI.w - 1.001), I = Math.min(Math.max(y / TSTEP, TGI.I0), TGI.I0 + TGI.h - 1.001);
  const j = Math.floor(J), i = Math.floor(I), u = J - j, v = I - i;
  const tx = Math.floor(j / TC), ty = Math.floor(i / TC);
  const a = TERR.get(tkey(tx, ty));
  if (!a) return 0;
  const lj = j - tx * TC + 1, li = i - ty * TC + 1, h = (ii, jj) => Z16(a[ii * TN + jj]);
  return (1 - v) * ((1 - u) * h(li, lj) + u * h(li, lj + 1)) + v * ((1 - u) * h(li + 1, lj) + u * h(li + 1, lj + 1));
}

// ======================================================================= 國道主線路肩
// 照實際尺寸: 內側黃線到中央護欄面約 2 m、外側白線到外側護欄面 3 m、中央只有一道護欄。
// 原始資料: 黃線到路面左緣 1.0 m、兩方向路面間距中位數 1.4 m。
// 路線中心線與 hw 都不動 (接點、匝道、隧道、AI 全部照舊)；車道整體往右移 0.6 m (ls 1.0 → 1.6)，
// 路面逐點往左 (eL) / 往右 (eR) 多鋪: 右邊補到外側路肩 3 m (旁邊有匝道就縮)；
// 左邊有對向路面 → 鋪到兩條路面正中間、在那裡放一道共用的護欄；沒有對向 → 多鋪讓內側路肩 2 m、護欄放在新路緣
const BARRIER_INSET = 0.35, BAR_HALF = 0.32, LS_FWY = 1.6, PAIR_MAX = 3.0;
const INNER_SH = 2.0, OUTER_SH = 3.0;
const isFwyMain = (w) => !w.city && !w.trunk && !w.link && w.oneway && w.lanes >= 2;
/** 第 i 點左右兩側最近的其他路面: 路緣到路緣的間距 gL / gR，左側最近的是不是對向國道主線 */
function sideProbe(w, i) {
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2], nx = w.nx[i], ny = w.ny[i], tx = ny, ty = -nx, R = w.hw + 8;
  let gL = null, gR = null, oL = null;
  const seen = new Set();
  for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
    const a = GRID.get(cellKey(cx, cy)); if (!a) continue;
    for (let j = 0; j < a.length; j += 2) {
      const o = WAYS[a[j]], si = a[j + 1];
      if (!o || o === w || o.city) continue;
      const id = a[j] * 100000 + si; if (seen.has(id)) continue; seen.add(id);
      const ax = o.P[si * 3], ay = o.P[si * 3 + 1], L = Math.hypot(o.P[si * 3 + 3] - ax, o.P[si * 3 + 4] - ay);
      if (L < 1e-3) continue;
      const ux = (o.P[si * 3 + 3] - ax) / L, uy = (o.P[si * 3 + 4] - ay) / L, dot = ux * tx + uy * ty;
      if (Math.abs(dot) < 0.7) continue;   // 交叉的路不算
      const t = (x - ax) * ux + (y - ay) * uy; if (t < -0.5 || t > L + 0.5) continue;
      const tc = Math.min(L, Math.max(0, t)), qx = ax + ux * tc, qy = ay + uy * tc;
      const qz = o.P[si * 3 + 2] + (o.P[si * 3 + 5] - o.P[si * 3 + 2]) * (tc / L);
      if (Math.abs(qz - z) > 2) continue;   // 上下層不算
      const lat = (qx - x) * nx + (qy - y) * ny, g = Math.abs(lat) - w.hw - o.hw;
      if (g > 8 || Math.abs(lat) < 0.5) continue;
      if (lat > 0) { if (gL == null || g < gL) { gL = g; oL = { o, opp: dot < -0.85 && isFwyMain(o) && !o.tunnel }; } }
      else if (gR == null || g < gR) gR = g;
    }
  }
  return { gL, gR, oL };
}
/** 分區連接完成 (鄰區資料都在) 時呼叫；只用原始 hw 量，跟其他路段設定的先後無關 */
function setupShoulders(w) {
  if (w.shoulder !== undefined) return;
  w.shoulder = false;
  if (!isFwyMain(w) || params.has('oldshoulder')) return;
  w.ls = LS_FWY;   // 隧道也一樣 (車道跟洞外對齊)
  if (w.tunnel) return;
  const n = w.n, L = w.lanes * LANE_W;
  // 外側: 白線到護欄面 OUTER_SH；內側 (沒有對向): 黃線到護欄面 INNER_SH
  const ER_MAX = Math.max(0, OUTER_SH + BARRIER_INSET + BAR_HALF - (w.width - L - LS_FWY));
  const EL_MAX = Math.max(0, INNER_SH + BARRIER_INSET + BAR_HALF - LS_FWY);
  const gL = new Array(n), gR = new Array(n), pair = new Uint8Array(n), opp = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const p = sideProbe(w, i); gL[i] = p.gL; gR[i] = p.gR;
    if (p.oL && p.oL.opp && p.gL < PAIR_MAX) { pair[i] = 1; opp[i] = p.oL.o; }
  }
  for (let i = 1; i < n - 1; i++) if (!pair[i] && pair[i - 1] && pair[i + 1]) { pair[i] = 1; opp[i] = opp[i - 1]; gL[i] = (gL[i - 1] + gL[i + 1]) / 2; }
  for (let i = 0; i < n; i++) if (pair[i] && !(i > 0 && pair[i - 1]) && !(i < n - 1 && pair[i + 1])) pair[i] = 0;
  // 平滑視窗在兩端縮小 (端點用原值): 前後兩條路段在接點量到的是同一個位置，才接得上
  const avg = (arr, i, ok) => { const h = Math.min(3, i, n - 1 - i); let sum = 0, k = 0; for (let j = i - h; j <= i + h; j++) if (ok(j)) { sum += arr[j]; k++; } return k ? sum / k : arr[i]; };
  const capL = new Float32Array(n), capR = new Float32Array(n), mid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (pair[i]) mid[i] = avg(gL, i, (j) => pair[j]) / 2;   // 中央護欄中心 = 路緣外 g/2
    capL[i] = pair[i] ? Math.max(0, mid[i]) : (gL[i] == null ? EL_MAX : Math.min(EL_MAX, Math.max(0, gL[i] / 2 - 0.05)));
    capR[i] = gR[i] == null ? ER_MAX : Math.min(ER_MAX, Math.max(0, gR[i] - 0.05));
  }
  const eL = new Float32Array(n), eR = new Float32Array(n), bc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    eL[i] = pair[i] ? capL[i] : Math.min(capL[i], avg(capL, i, (j) => !pair[j]));
    eR[i] = Math.min(capR[i], avg(capR, i, () => true));
    bc[i] = pair[i] ? w.hw + mid[i] : w.hw + eL[i] - BARRIER_INSET;
  }
  Object.assign(w, { shoulder: true, eL, eR, bc, pair, oppL: opp });
}
const clampI = (w, i) => Math.min(Math.max(i | 0, 0), w.n - 1);
/** 門架 / 看板左側立柱位置 (左法向偏移): 國道主線立在中央護欄上 */
function leftPost(w, i) { setupShoulders(w); return w.bc ? w.bc[clampI(w, i)] : w.hw + 0.6; }
/** 右側路緣 (含加寬的路肩) */
function rightEdge(w, i) { setupShoulders(w); return w.hw + (w.eR ? w.eR[clampI(w, i)] : 0); }
/** 左側路緣 */
function leftEdge(w, i) { setupShoulders(w); return w.hw + (w.eL ? w.eL[clampI(w, i)] : 0); }

// ======================================================================= 車道 / 路網 (國道、快速道路、一般道路共用)
/** 行進方向的車道數 (雙向一般道路只算一半) */
const laneCount = (w) => (w.city && !w.oneway) ? Math.max(1, Math.floor(w.lanes / 2)) : w.lanes;
/** 車道中心相對路線左法向的偏移。lane 0 = 最內側；雙向一般道路靠行進方向右側 */
function laneOffDir(w, lane, dir = 1) {
  const lc = laneCount(w);
  lane = Math.min(Math.max(lane, 0), lc - 1);
  if (w.city) {
    if (!w.oneway) { const off = (lane + 0.5) * (w.width / 2 - 0.3) / lc; return dir > 0 ? -off : off; }
    return (w.width / 2 - 0.3) - (lane + 0.5) * (w.width - 0.6) / w.lanes;
  }
  if (w.link && w.lanes === 1) return 0;
  return w.hw - w.ls - LANE_W * (lane + 0.5);
}
/** 速限: OSM maxspeed，沒有就依道路等級 */
const speedLimit = (w) => w.maxspeed || (w.city ? (w.cls === 5 ? 30 : 50) : w.trunk ? (w.link ? 50 : 80) : (w.link ? 60 : 100));
/** 路口 (路段端點) 可以接續的路段。一般道路的點有幾公分誤差: 隔壁格子 20 公分內的點也算 (兩邊至少一條是一般道路) */
function nodeLinks(w, node) {
  const x = w.P[node * 3], y = w.P[node * 3 + 1];
  const own = PT_INDEX.get(ptKey(x, y)) || [];
  const gx = Math.round(x * 10), gy = Math.round(y * 10);
  let res = own;
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
    if (!ox && !oy) continue;
    for (const e of PT_INDEX.get((gx + ox) + ',' + (gy + oy)) || []) {
      const o = WAYS[e[0]];
      if (e[0] !== w.k && (o.city || w.city) && Math.hypot(o.P[e[1] * 3] - x, o.P[e[1] * 3 + 1] - y) < 0.2 && !res.some(([k, i]) => k === e[0] && i === e[1])) {
        if (res === own) res = own.slice();
        res.push(e);
      }
    }
  }
  return res;
}
function nextOptions(w, node) {
  const res = [];
  for (const [k, i] of nodeLinks(w, node)) {
    if (k === w.k) continue;
    const o = WAYS[k];
    if (Math.abs(o.P[i * 3 + 2] - w.P[node * 3 + 2]) > 2.5) continue;   // 不同樓層剛好重疊，不相連
    if (i < o.n - 1) res.push({ o, i, dir: 1, hx: o.ny[i], hy: -o.nx[i] });
    if (o.city && !o.oneway && i > 0) res.push({ o, i, dir: -1, hx: -o.ny[i], hy: o.nx[i] });
  }
  return res.sort((a, b) => a.o.gid - b.o.gid);   // 依全域編號排序: 選路結果不受分區載入順序影響
}
/** 接續選項走到底以後還有沒有路 (一般道路才看，只往前看一層) */
function deadEndAhead(o) {
  if (!o.o.city) return false;
  return nextOptions(o.o, o.dir > 0 ? o.o.n - 1 : 0).length === 0;
}
/** 玩家自動駕駛選路: 國道優先同一條主線；一般道路直行，打方向燈就在路口轉彎 */
function chooseNext(w, node, dir, signal) {
  const hx = dir > 0 ? w.ny[node] : -w.ny[node], hy = dir > 0 ? -w.nx[node] : w.nx[node];
  let best = null, bs = -1e9;
  for (const o of nextOptions(w, node)) {
    const dot = hx * o.hx + hy * o.hy, cross = hx * o.hy - hy * o.hx;
    if (dot < (w.city || o.o.city ? -0.2 : 0.3)) continue;
    let sc = dot * 2 + (o.o.ref && o.o.ref === w.ref ? 3 : 0) + (o.o.link && !w.link ? -2 : 0) + (w.link && !o.o.link ? 2 : 0)
      + (!!o.o.city !== !!w.city ? -1 : 0) + (o.o.city && o.o.cls === 5 ? -1 : 0);
    if (deadEndAhead(o)) sc -= 6;
    if (HOOKS.navBias) sc += HOOKS.navBias(w, o);
    if (signal < 0 && cross > 0.3) sc += 6;
    if (signal > 0 && cross < -0.3) sc += 6;
    if (sc > bs) { bs = sc; best = o; }
  }
  if (!best && w.city) {   // 市區只剩急轉出得去: 挑最順的那條
    let bd = -1e9;
    for (const o of nextOptions(w, node)) if (o.o.city) { const dot = hx * o.hx + hy * o.hy; if (dot > bd) { bd = dot; best = o; } }
  }
  return best;
}
const nextWay = (w) => { const o = chooseNext(w, w.n - 1, 1, 0); return o ? [o.o, o.i] : null; };

window.TW = Object.assign(window.TW || {}, {
  T, params, $, setStatus, HOOKS, INDEX, TS, TC, TSTEP, TN, TGI, tkey, tileBuf, Z16,
  LANE_W, WAYS, GID, wayByGid, ptKey, PT_INDEX, CELL, GRID, cellKey, ingestDetail, resolveRamps, DIVERGE,
  roadAt, cityAt, TERR, LCLS, landcoverAt, terrainAt,
  BARRIER_INSET, BAR_HALF, isFwyMain, setupShoulders, leftPost, rightEdge, leftEdge,
  laneCount, laneOffDir, speedLimit, nodeLinks, nextOptions, deadEndAhead, chooseNext, nextWay,
});
})();
