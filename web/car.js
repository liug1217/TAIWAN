/* 台灣 1:1 — 玩家精細車輛模型 (車牌、方向燈、車身 loft) */
(function () {
'use strict';
const { T } = TW;
// ======================================================================= 精細車輛
function plateTexture(text) {
  const cv = document.createElement('canvas'); cv.width = 380; cv.height = 160;
  const x = cv.getContext('2d');
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 380, 160);
  x.strokeStyle = '#111'; x.lineWidth = 8; x.strokeRect(6, 6, 368, 148);
  x.fillStyle = '#111'; x.font = 'bold 104px "Arial Narrow", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 190, 88);
  x.font = 'bold 20px sans-serif'; x.fillText('臺灣省', 190, 24);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// 方向燈: 琥珀色，每秒閃 1.5 次
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
const blinkPhase = () => (performance.now() % 666) < 333;

function cosInterp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x <= x1) { const t = (x - x0) / (x1 - x0), u = (1 - Math.cos(Math.PI * t)) / 2; return y0 + (y1 - y0) * u; }
  }
  return table[table.length - 1][1];
}

/** 沿 x 放樣：ring(x) 回傳 [[z(側), y(上)], ...] (閉合)；faceGroup(i,j) 回傳材質群組 */
function loft(xs, ring, faceGroup, caps = true) {
  const pos = [], groups = {};
  const N = ring(xs[0]).length;
  for (const x of xs) for (const [z, y] of ring(x)) pos.push(x, y, z);
  const add = (gid, a, b, c) => (groups[gid] = groups[gid] || []).push(a, b, c);
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = i * N + (j + 1) % N, c = (i + 1) * N + (j + 1) % N, d = (i + 1) * N + j;
    const gid = faceGroup ? faceGroup(i, j) : 0;
    add(gid, a, d, c); add(gid, a, c, b);
  }
  if (caps) for (const [i, flip] of [[0, true], [xs.length - 1, false]]) {
    const ci = pos.length / 3; let cy = 0, cz = 0;
    for (let j = 0; j < N; j++) { cz += pos[(i * N + j) * 3 + 2]; cy += pos[(i * N + j) * 3 + 1]; }
    pos.push(xs[i], cy / N, cz / N);
    for (let j = 0; j < N; j++) { const a = i * N + j, b = i * N + (j + 1) % N; flip ? add(0, ci, b, a) : add(0, ci, a, b); }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  const idx = []; let start = 0;
  for (const gid of Object.keys(groups).sort()) { const arr = groups[gid]; idx.push(...arr); g.addGroup(start, arr.length, +gid); start += arr.length; }
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function superRing(hw, yb, yt, nexp, N, taperTop = 1) {
  const pts = [], yc = (yb + yt) / 2, hy = (yt - yb) / 2;
  for (let j = 0; j < N; j++) {
    const th = 2 * Math.PI * j / N, c = Math.cos(th), s = Math.sin(th);
    const zz = Math.sign(c) * Math.pow(Math.abs(c), 2 / nexp), yy = Math.sign(s) * Math.pow(Math.abs(s), 2 / nexp);
    const h = (yy + 1) / 2;
    pts.push([zz * hw * (1 + (taperTop - 1) * h), yc + yy * hy]);
  }
  return pts;
}

function buildCar() {
  const car = new T.Group();
  const paint = new T.MeshPhysicalMaterial({ color: new T.Color(0.55, 0.012, 0.018), metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const glass = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.012, 0.015), metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.6 });
  const black = new T.MeshStandardMaterial({ color: new T.Color(0.012, 0.012, 0.013), roughness: 0.55 });
  const gloss = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.01, 0.01), roughness: 0.15, clearcoat: 1 });
  const chrome = new T.MeshStandardMaterial({ color: new T.Color(0.9, 0.9, 0.92), metalness: 1, roughness: 0.12 });
  const rimMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.56, 0.58), metalness: 1, roughness: 0.25 });
  const tireMat = new T.MeshStandardMaterial({ color: new T.Color(0.02, 0.02, 0.02), roughness: 0.92 });
  const discMat = new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.3, 0.3), metalness: 0.9, roughness: 0.45 });
  const caliper = new T.MeshStandardMaterial({ color: new T.Color(0.7, 0.04, 0.02), roughness: 0.4 });
  const headMat = new T.MeshStandardMaterial({ color: 0xffffff, emissive: new T.Color(1, 0.97, 0.9), emissiveIntensity: 1.6, roughness: 0.1 });
  const tailMat = new T.MeshBasicMaterial({ color: new T.Color(0.5, 0.005, 0.005), toneMapped: false }); // 不經色調映射，保持純紅
  const sigLMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 左方向燈
  const sigRMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 右方向燈
  const add = (geo, mat, x = 0, y = 0, z = 0, cast = true) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; car.add(m); return m; };

  const L2 = 2.35, AX = 1.4, WR = 0.33;
  // ---- 車身下半部 (含輪拱)
  const top = [[-L2, 0.60], [-2.30, 0.78], [-2.18, 0.93], [-1.9, 0.965], [-1.3, 0.975], [0.9, 0.955], [1.25, 0.93], [1.7, 0.86], [2.15, 0.76], [2.3, 0.66], [L2, 0.52]];
  const bot = [[-L2, 0.30], [-2.2, 0.22], [-1.9, 0.20], [1.9, 0.20], [2.25, 0.24], [L2, 0.30]];
  const half = [[-L2, 0.74], [-2.25, 0.86], [-2.0, 0.905], [-1.4, 0.915], [1.5, 0.915], [2.05, 0.885], [2.28, 0.80], [L2, 0.70]];
  const xs = []; for (let i = 0; i <= 90; i++) { const t = i / 90; xs.push(-L2 + 2 * L2 * (0.5 - 0.5 * Math.cos(Math.PI * t))); }
  const arch = (x) => { let yb = cosInterp(bot, x); for (const ax of [AX, -AX]) { const d = x - ax, r = 0.43; if (Math.abs(d) < r) yb = Math.max(yb, WR + Math.sqrt(r * r - d * d)); } return yb; };
  const bodyGeo = loft(xs, (x) => superRing(cosInterp(half, x), arch(x), cosInterp(top, x), 5.5, 40), null);
  add(bodyGeo, paint);
  // 輪拱內襯 (避免看穿車身)
  for (const ax of [AX, -AX]) add(new T.BoxGeometry(0.95, 0.62, 1.2), black, ax, 0.5, 0);
  // ---- 車艙 (玻璃 + 車頂)
  const roof = [[-1.36, 0.95], [-1.05, 1.27], [-0.65, 1.42], [0.15, 1.45], [0.55, 1.37], [1.06, 0.95]];
  const gHalf = [[-1.36, 0.70], [-1.0, 0.75], [0.6, 0.76], [1.06, 0.72]];
  const gx = []; for (let i = 0; i <= 50; i++) gx.push(-1.36 + 2.42 * i / 50);
  const NR = 32;
  const cabinGeo = loft(gx, (x) => superRing(cosInterp(gHalf, x), 0.9, cosInterp(roof, x), 4, NR, 0.8), (i, j) => {
    const x = gx[i], th = 2 * Math.PI * (j + 0.5) / NR;
    const roofF = x > -0.98 && x < 0.52 && Math.abs(th - Math.PI / 2) < 0.95;
    const side = Math.abs(Math.cos(th)) > 0.5;
    const pillar = side && (x < -0.98 || Math.abs(x + 0.18) < 0.06 || x > 0.66); // C / B / A 柱與車身同色
    return (roofF || pillar) ? 0 : 1;
  });
  const cabin = new T.Mesh(cabinGeo, [paint, glass]); cabin.castShadow = true; car.add(cabin);
  // 柱子
  const tube = (a, b, r, mat) => {
    const va = new T.Vector3(...a), vb = new T.Vector3(...b), len = va.distanceTo(vb);
    const m = add(new T.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    return m;
  };
  for (const s of [1, -1]) {
    tube([-1.3, 0.958, s * 0.735], [1.0, 0.958, s * 0.74], 0.012, chrome); // 窗框飾條
    for (const dx of [0.98, -0.18, -1.28]) tube([dx, 0.3, s * 0.912], [dx, 0.93, s * 0.905], 0.005, black); // 車門縫
    for (const dx of [0.2, -0.82]) add(new T.BoxGeometry(0.14, 0.025, 0.03), chrome, dx, 0.86, s * 0.925);  // 門把
    // 後照鏡
    const mir = add(new T.BoxGeometry(0.16, 0.11, 0.2), paint, 0.92, 1.0, s * 0.97);
    add(new T.BoxGeometry(0.01, 0.085, 0.16), chrome, 0.835, 1.0, s * 0.975);
    tube([0.96, 0.96, s * 0.80], [0.94, 0.98, s * 0.88], 0.02, black);
    // 側裙
    add(new T.BoxGeometry(2.0, 0.07, 0.05), black, 0, 0.25, s * 0.9);
  }
  // ---- 車頭
  for (const s of [1, -1]) {
    const hl = add(new T.BoxGeometry(0.34, 0.085, 0.3), headMat, 2.13, 0.775, s * 0.6, false);
    hl.rotation.y = s * 0.28; hl.rotation.z = -0.25;
    add(new T.BoxGeometry(0.3, 0.02, 0.26), chrome, 2.12, 0.735, s * 0.6).rotation.set(0, s * 0.28, -0.25);
    add(new T.BoxGeometry(0.03, 0.03, 0.22), headMat, 2.31, 0.47, s * 0.55, false); // 日行燈
  }
  add(new T.BoxGeometry(0.06, 0.15, 0.78), gloss, 2.29, 0.6, 0);            // 水箱罩
  for (let k = 0; k < 4; k++) add(new T.BoxGeometry(0.065, 0.008, 0.76), chrome, 2.295, 0.54 + k * 0.04, 0);
  add(new T.BoxGeometry(0.08, 0.13, 1.15), black, 2.31, 0.33, 0);           // 下進氣口
  const pf = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), 2.358, 0.44, 0);
  pf.rotation.y = Math.PI / 2;
  // ---- 車尾 (紅色尾燈組 + 白色倒車燈 + 後擋風玻璃上方第三煞車燈)
  add(new T.BoxGeometry(0.05, 0.06, 1.2), tailMat, -2.31, 0.86, 0, false);
  for (const s of [1, -1]) {
    add(new T.BoxGeometry(0.14, 0.17, 0.34), tailMat, -2.25, 0.84, s * 0.64, false).rotation.y = -s * 0.25;
    add(new T.BoxGeometry(0.03, 0.05, 0.12), headMat, -2.335, 0.74, s * 0.5, false);
  }
  add(new T.BoxGeometry(0.04, 0.03, 0.4), tailMat, -1.2, 1.25, 0, false);
  add(new T.BoxGeometry(0.12, 0.03, 1.3), paint, -2.2, 0.975, 0).rotation.z = 0.12;   // 尾翼唇
  add(new T.BoxGeometry(0.06, 0.12, 1.3), black, -2.32, 0.32, 0);           // 後下擾流
  const pr = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), -2.335, 0.6, 0);
  pr.rotation.y = -Math.PI / 2;
  for (const s of [1, -1]) {
    const ex = add(new T.CylinderGeometry(0.045, 0.045, 0.16, 16), chrome, -2.3, 0.25, s * 0.45);
    ex.rotation.z = Math.PI / 2;
  }
  add(new T.BoxGeometry(0.22, 0.06, 0.07), paint, -0.85, 1.43, 0).rotation.z = 0.25; // 鯊魚鰭天線
  add(new T.BoxGeometry(4.0, 0.05, 1.5), black, 0, 0.2, 0, false);          // 底盤
  // ---- 方向燈 (+z 為右側): 前角、後角、後照鏡側燈
  for (const [s, mat] of [[-1, sigLMat], [1, sigRMat]]) {
    add(new T.BoxGeometry(0.1, 0.05, 0.16), mat, 2.2, 0.69, s * 0.74, false).rotation.y = -s * 0.5;
    add(new T.BoxGeometry(0.06, 0.07, 0.15), mat, -2.29, 0.7, s * 0.7, false);
    add(new T.BoxGeometry(0.1, 0.022, 0.05), mat, 0.9, 0.955, s * 1.07, false);
  }

  // ---- 輪胎 / 輪框 / 卡鉗
  const tireProfile = [[0.215, -0.112], [0.30, -0.112], [0.322, -0.098], [0.33, -0.065], [0.33, 0.065], [0.322, 0.098], [0.30, 0.112], [0.215, 0.112]]
    .map(([r, y]) => new T.Vector2(r, y));
  const tireGeo = new T.LatheGeometry(tireProfile, 56); tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new T.CylinderGeometry(0.218, 0.218, 0.19, 48); rimGeo.rotateX(Math.PI / 2);
  const barrelGeo = new T.CylinderGeometry(0.2, 0.2, 0.2, 32, 1, true); barrelGeo.rotateX(Math.PI / 2);
  const discGeo = new T.CylinderGeometry(0.17, 0.17, 0.025, 40); discGeo.rotateX(Math.PI / 2);
  const hubGeo = new T.CylinderGeometry(0.045, 0.05, 0.04, 20); hubGeo.rotateX(Math.PI / 2);
  const wheels = [];
  for (const ax of [AX, -AX]) for (const s of [1, -1]) {
    const pivot = new T.Group(); pivot.position.set(ax, WR, s * 0.79); car.add(pivot);
    const spin = new T.Group(); pivot.add(spin);
    const out = s; // 外側方向 (+z 右側)
    const tire = new T.Mesh(tireGeo, tireMat); tire.castShadow = true; spin.add(tire);
    const barrel = new T.Mesh(barrelGeo, black); spin.add(barrel);
    const face = new T.Mesh(new T.CylinderGeometry(0.205, 0.205, 0.012, 48).rotateX(Math.PI / 2), rimMat);
    face.position.z = out * 0.075; spin.add(face);
    for (let k = 0; k < 5; k++) {
      const sp = new T.Mesh(new T.BoxGeometry(0.17, 0.045, 0.03), rimMat);
      const a = k * 2 * Math.PI / 5;
      sp.position.set(Math.cos(a) * 0.105, Math.sin(a) * 0.105, out * 0.09); sp.rotation.z = a; spin.add(sp);
      const hole = new T.Mesh(new T.BoxGeometry(0.06, 0.05, 0.02), black);
      hole.position.set(Math.cos(a + Math.PI / 5) * 0.15, Math.sin(a + Math.PI / 5) * 0.15, out * 0.083); hole.rotation.z = a + Math.PI / 5; spin.add(hole);
    }
    const hub = new T.Mesh(hubGeo, chrome); hub.position.z = out * 0.1; spin.add(hub);
    const disc = new T.Mesh(discGeo, discMat); disc.position.z = -out * 0.01; pivot.add(disc);
    const cal = new T.Mesh(new T.BoxGeometry(0.12, 0.08, 0.06), caliper); cal.position.set(-0.05, 0.13, out * 0.02); pivot.add(cal);
    wheels.push({ pivot, spin, front: ax > 0 });
  }
  car.userData = { wheels, tailMat, headMat, paint, sigLMat, sigRMat };
  return car;
}

Object.assign(TW, { SIG_ON, SIG_OFF, blinkPhase, buildCar });
})();
