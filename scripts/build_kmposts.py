"""國道里程牌 (中央分隔帶每 100 m 一支綠底白字「26.1」) 用的里程錨點 -> web/extra/kmposts.json

錨點跟 build_live.py 一樣: CMS 看板 (data/live/CMS.xml 快取) + ETC 門架 (smart-nav-map/etc_gantry_data.js)，
都有經緯度與里程。網頁 (world.js addRoad) 沿主線把每個點投影到同一條國道的錨點折線上求里程，
每跨過一個 100 m 整數就立一支里程牌。

    python scripts/build_kmposts.py           (用快取的 CMS.xml；沒有快取就下載)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_live import GANTRY_ROAD, ROOT, blocks, fetch, mile_m, tag  # noqa: E402
from prep_freeway import local_xy  # noqa: E402

OUT = os.path.join(ROOT, "web", "extra", "kmposts.json")


def main():
    anchors = {}
    for b in blocks(fetch("CMS", False), "CMS"):
        road, m = tag(b, "RoadName"), mile_m(tag(b, "LocationMile"))
        lat, lon = float(tag(b, "PositionLat") or 0), float(tag(b, "PositionLon") or 0)
        if road in GANTRY_ROAD.values() and m is not None and lat:
            anchors.setdefault(road, []).append((m, lat, lon))
    src = open(os.path.join(ROOT, "smart-nav-map", "etc_gantry_data.js"), encoding="utf-8").read()
    src = src[src.index("window.ETC_GANTRY"):]
    for lon, lat, d, gid, brg in json.loads(src[src.index("["):src.rindex("]") + 1]):
        road = GANTRY_ROAD.get(gid[:3]) if gid[3:7].isdigit() else None
        if road:
            anchors.setdefault(road, []).append((int(gid[3:7]) * 100, lat, lon))
    out = {}
    for road, a in anchors.items():
        # 同一里程 (南北向兩座門架) 取平均位置，依里程排序
        by = {}
        for m, lat, lon in a:
            by.setdefault(m, []).append((lat, lon))
        rows = []
        for m in sorted(by):
            lat = sum(p[0] for p in by[m]) / len(by[m])
            lon = sum(p[1] for p in by[m]) / len(by[m])
            x, y = local_xy(lat, lon)
            rows.append([m, round(float(x), 1), round(float(y), 1)])
        out[road] = rows
    if "國道1號汐止五股高架道路" not in out and "國道1號" in out:
        out["國道1號汐止五股高架道路"] = out["國道1號"]
    json.dump({"anchors": out}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("kmposts:", {k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
