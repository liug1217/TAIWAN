"""交流道出口指示牌 (綠色門架) -> web/extra/signs.json

每個「匝道從主線分岔」的地方放一座門架 (分岔點前約 230 m)，照實景版面:
  左邊: 直行方向 (下兩個交流道的地名 + ↑)
  右邊: 出口 (OSM 匝道 destination / destination:en / destination:ref -> 地名、英文、路線編號盾牌 + ↗)
  出口牌右上: 黃底出口編號 (OSM motorway_junction ref；沒有就用里程公里數) + 交流道名

資料: data/freeway_prep.json (路段，索引 = gid)、data/taipei_fwy.json + taipei_trunk.json (OSM 標籤)、
      data/junctions_osm.json (出口編號，可有可無)、web/extra/live.json (路段里程)
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, HERE)

BACK = 230.0          # 門架在分岔點前幾公尺


def key(x, y):
    return (round(x * 10), round(y * 10))


def clean_name(s):
    s = re.sub(r"(系統)?(交流道|出口匝道|入口匝道|出口引道|出口|匝道|引道)$", "", s or "").strip()
    return s


def main():
    prep = json.load(open(os.path.join(DATA, "freeway_prep.json"), encoding="utf-8"))
    ways = prep["ways"]
    tags = {}
    for f in ("taipei_fwy.json", "taipei_trunk.json"):
        p = os.path.join(DATA, f)
        if os.path.exists(p):
            for e in json.load(open(p, encoding="utf-8"))["elements"]:
                tags[e["id"]] = e.get("tags", {})
    live = json.load(open(os.path.join(ROOT, "web", "extra", "live.json"), encoding="utf-8"))
    waymap = live.get("wayMap", [])

    # 出口編號 (motorway_junction 節點)
    junctions = []
    jp = os.path.join(DATA, "junctions_osm.json")
    if os.path.exists(jp):
        from prep_freeway import local_xy
        import numpy as np
        js = [e for e in json.load(open(jp, encoding="utf-8"))["elements"] if e["type"] == "node"]
        if js:
            xs, ys = local_xy(np.array([e["lat"] for e in js]), np.array([e["lon"] for e in js]))
            junctions = [(float(x), float(y), e.get("tags", {})) for x, y, e in zip(xs, ys, js)]

    EN = {}
    strip_en = lambda t: re.sub(r"\s*(System Interchange|Interchange|Intermediate Transfer Connection|Exit|Rest Area|Service Area|Junction)$", "", t or "").strip()
    for _, _, jt in junctions:
        if jt.get("name") and jt.get("name:en"):
            EN.setdefault(clean_name(jt["name"]), strip_en(jt["name:en"]))
        a, b = str(jt.get("destination", "")).split(";"), str(jt.get("destination:en", "")).split(";")
        if len(a) == len(b):
            for x, y in zip(a, b):
                if x.strip() and y.strip():
                    EN.setdefault(x.strip(), y.strip())
    for t in tags.values():
        a, b = str(t.get("destination", "")).split(";"), str(t.get("destination:en", "")).split(";")
        if t.get("destination:en") and len(a) == len(b):
            for x, y in zip(a, b):
                if x.strip() and y.strip():
                    EN.setdefault(x.strip(), y.strip())
        if t.get("name") and t.get("name:en"):
            EN.setdefault(clean_name(t["name"]), strip_en(t["name:en"]))
    # OSM 沒有英文的常見地名 (標誌上的官方拼音)
    for k, v in {"深坑": "Shenkeng", "宜蘭": "Yilan", "新莊": "Xinzhuang", "松山": "Songshan", "蘆洲": "Luzhou", "桃園": "Taoyuan",
                 "林口": "Linkou", "中央研究院": "Academia Sinica", "建國北路": "Jianguo N. Rd.", "木柵路": "Muzha Rd.",
                 "提頂大道": "Tiding Blvd.", "堤頂大道": "Tiding Blvd.", "台北": "Taipei", "板橋": "Banqiao", "三重": "Sanchong",
                 "台北市區": "Taipei City", "基隆": "Keelung", "汐止": "Xizhi", "南港": "Nangang", "內湖": "Neihu", "萬里": "Wanli",
                 "瑞芳": "Ruifang", "暖暖": "Nuannuan", "新店": "Xindian", "中和": "Zhonghe", "土城": "Tucheng", "五股": "Wugu",
                 "泰山": "Taishan", "八里": "Bali", "淡水": "Tamsui", "景美": "Jingmei", "石碇": "Shiding", "坪林": "Pinglin"}.items():
        EN.setdefault(k, v)
    def en_of(zh):
        base = re.sub(r"\s*\(.*?\)", "", zh).strip()
        e = EN.get(zh) or EN.get(base) or ""
        return re.sub(r"\s+IC$", "", e)

    starts, ends = {}, {}
    for g, w in enumerate(ways):
        P = w["pts"]
        starts.setdefault(key(*P[0][:2]), []).append(g)
        ends.setdefault(key(*P[-1][:2]), []).append(g)
    is_link = lambda g: str(ways[g]["highway"]).endswith("_link")

    def seg_len(P, i):
        return math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])

    def dest_of(g, hops=4):
        """匝道 (含下游連續匝道) 的 destination 標籤"""
        seen = set()
        frontier = [g]
        for _ in range(hops):
            nxt = []
            for h in frontier:
                if h in seen:
                    continue
                seen.add(h)
                t = tags.get(ways[h]["id"], {})
                if t.get("destination"):
                    return t, ways[h]
                nxt += [k for k in starts.get(key(*ways[h]["pts"][-1][:2]), []) if is_link(k)]
            frontier = nxt
        return tags.get(ways[g]["id"], {}), ways[g]

    def upstream(g, dist):
        """從路段 g 的終點往上游走 dist 公尺 -> (gid, idx)；隧道裡不放"""
        cur, i = g, len(ways[g]["pts"]) - 1
        while dist > 0:
            P = ways[cur]["pts"]
            if i == 0:
                prev = [k for k in ends.get(key(*P[0][:2]), []) if not is_link(k)]
                if not prev:
                    break
                same = [k for k in prev if ways[k]["ref"] == ways[cur]["ref"]] or prev
                cur = same[0]; i = len(ways[cur]["pts"]) - 1
                continue
            dist -= seg_len(P, i - 1)
            i -= 1
        while ways[cur]["tunnel"] and i < len(ways[cur]["pts"]) - 2:   # 隧道口外再放
            i += 1
        return cur, max(0, min(i, len(ways[cur]["pts"]) - 2))

    def mileage(g):
        for _ in range(6):
            if g < len(waymap) and waymap[g]:
                return waymap[g]
            prev = [k for k in ends.get(key(*ways[g]["pts"][0][:2]), []) if not is_link(k)]
            if not prev:
                return None
            g = prev[0]
        return None

    exits = {}
    for L, w in enumerate(ways):
        if not is_link(L):
            continue
        S = key(*w["pts"][0][:2])
        mains_in = [k for k in ends.get(S, []) if not is_link(k)]
        mains_out = [k for k in starts.get(S, []) if not is_link(k)]
        if not mains_in or not mains_out or S in exits:
            continue
        M = mains_in[0]
        if ways[M]["tunnel"]:
            continue
        t, tw = dest_of(L)
        dz = [x.strip() for x in re.split(r"[;,、]", str(t.get("destination", ""))) if x.strip()]
        den = [x.strip() for x in str(t.get("destination:en", "")).split(";") if x.strip()]
        dref = [x.strip() for x in re.split(r"[;,]", str(t.get("destination:ref", ""))) if x.strip()]
        name = clean_name(tags.get(w["id"], {}).get("name") or tw.get("name") or "")
        if not dz:
            dz = [name] if name else []
        if not dz:
            continue
        # 出口在左還是右 (主線終點方向 x 匝道方向)
        PM, PL = ways[M]["pts"], w["pts"]
        mx, my = PM[-1][0] - PM[-2][0], PM[-1][1] - PM[-2][1]
        j, acc = 1, 0.0                       # 匝道上約 40 m 處的方向 (太近會被樣條雜訊干擾)
        while j < len(PL) - 1 and acc < 40:
            acc += seg_len(PL, j - 1); j += 1
        lx, ly = PL[j][0] - PL[0][0], PL[j][1] - PL[0][1]
        L0 = math.hypot(lx, ly) or 1; M0 = math.hypot(mx, my) or 1
        lat = (mx * ly - my * lx) / M0          # 匝道 40 m 處離主線延長線的側向距離 (+ = 左)
        side = "L" if lat > 0 else "R"
        gid, idx = upstream(M, BACK)
        mp = mileage(M)
        x0, y0 = PL[0][0], PL[0][1]
        jref, jname, jt0 = "", "", {}
        best = 90.0
        for jx, jy, jt in junctions:
            d = math.hypot(jx - x0, jy - y0)
            if d < best:
                best, jref, jname, jt0 = d, str(jt.get("ref", "")), clean_name(jt.get("name", "")), jt
        if not re.fullmatch(r"\d{1,3}[A-Z]?", jref):
            jref = ""
        if not t.get("destination") and (jt0.get("destination") or jt0.get("exit_to")):
            dz = [x.strip() for x in re.split(r"[;、,]", str(jt0.get("destination") or jt0.get("exit_to"))) if x.strip()]
        den = [en_of(z) for z in dz[:3]]
        if not jref and mp and str(mp[0]).startswith("國道"):
            jref = str(round(mp[2] / 1000))
        exits[S] = dict(gid=gid, idx=idx, side=side, main=M, out=mains_out, x=x0, y=y0,
                        name=jname or name or dz[0], ref=jref, dz=dz[:3], den=den[:3], shields=dref[:3],
                        road=ways[M]["ref"], mp=mp)

    # 直行方向: 下游接下來三個交流道的名稱
    by_start = {}
    for S, e in exits.items():
        by_start.setdefault(e["main"], []).append(e)
    for S, e in exits.items():
        thru, seen_names = [], set(e["dz"]) | {e["name"]}
        cur = [k for k in e["out"] if ways[k]["ref"] == e["road"]] or e["out"]
        g, dist = cur[0], 0.0
        for _ in range(400):
            P = ways[g]["pts"]
            dist += sum(seg_len(P, i) for i in range(len(P) - 1))
            if dist > 40000:
                break
            nxt_exit = exits.get(key(*P[-1][:2]))
            if nxt_exit:
                n = nxt_exit["name"]
                if n and n not in seen_names:
                    seen_names.add(n)
                    thru.append([n, en_of(n)])
                    if len(thru) == 3:   # 網頁: 路寬 (4 線以上) 放 3 面直行牌，否則取最近 2 個
                        break
            nxt = [k for k in starts.get(key(*P[-1][:2]), []) if not is_link(k)]
            if not nxt:
                break
            same = [k for k in nxt if ways[k]["ref"] == ways[g]["ref"]] or nxt
            g = same[0]
        e["thru"] = thru[::-1]   # 遠的在左

    kept, pos = [], []
    for e in sorted(exits.values(), key=lambda e: (e["ref"] == "", -len(e["shields"]))):
        P = ways[e["gid"]]["pts"]
        gx, gy = P[e["idx"]][0], P[e["idx"]][1]
        if any(math.hypot(gx - qx, gy - qy) < 100 and ways[e["gid"]]["ref"] == r for qx, qy, r in pos):
            continue
        pos.append((gx, gy, ways[e["gid"]]["ref"]))
        kept.append(e)
    out = [dict(gid=e["gid"], idx=e["idx"], side=e["side"], name=e["name"], ref=e["ref"], dz=e["dz"], den=e["den"],
                shields=e["shields"], name_en=en_of(e["name"]), thru=e["thru"]) for e in kept]
    json.dump(out, open(os.path.join(ROOT, "web", "extra", "signs.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"signs {len(out)} (exit numbers from OSM junctions: {sum(1 for e in exits.values() if e['ref'] and junctions)}, "
          f"with shields {sum(1 for e in out if e['shields'])}, with English {sum(1 for e in out if e['den'])}, left exits {sum(1 for e in out if e['side'] == 'L')})")


if __name__ == "__main__":
    main()
