"""Lorcana Meta pipeline.

  python -m pipeline add <event id or URL>   track an event
  python -m pipeline refresh                 pull running events, Duels snapshots, daily discovery
  python -m pipeline build                   write site/data/ from data/
  python -m pipeline discover                list big events in the next days and whether pairings show

`refresh` is what the scheduled workflow runs every 15 minutes. It costs one
call per tracked unfinished event when nothing is running, and fetches only
rounds that are new or not yet complete. A finished event is never pulled again.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import sources as S

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"
AUTO_ADD_MIN_PLAYERS = 256
DISCOVER_EVERY_HOURS = 20


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(dt: datetime | None = None) -> str:
    return (dt or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_dt(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def read(p: Path, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def write(p: Path, obj, indent=None) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=indent, ensure_ascii=False, separators=None if indent else (",", ":")) + "\n", encoding="utf-8")


def slugify(name: str, start: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "event").lower()).strip("-")
    return f"{s}-{(start or '')[:10]}".strip("-")


# ---------------------------------------------------------------- registry

def registry(data: Path = DATA) -> dict:
    return read(data / "events.json", {"events": [], "last_discover": None})


def save_registry(reg: dict, data: Path = DATA) -> None:
    write(data / "events.json", reg, indent=1)


def add_event(ref: str, get=S.http_json, data: Path = DATA, how: str = "manual") -> dict:
    eid = S.parse_event_id(ref)
    reg = registry(data)
    for e in reg["events"]:
        if e["id"] == eid:
            return e
    ev = S.trim_event(get(f"{S.RPH}/events/{eid}/"))
    entry = dict(id=eid, slug=slugify(ev["name"], ev["start"]), name=ev["name"], start=ev["start"],
                 added=how, added_at=stamp(), final=False)
    reg["events"].append(entry)
    reg["events"].sort(key=lambda e: e["start"] or "")
    save_registry(reg, data)
    write(data / "rph" / str(eid) / "event.json", ev, indent=1)
    return entry


# ---------------------------------------------------------------- refresh

def pull_event(entry: dict, get=S.http_json, data: Path = DATA, log=print) -> dict:
    """Pull what changed for one tracked event. Returns a summary."""
    eid = entry["id"]
    d = data / "rph" / str(eid)
    ev = S.trim_event(get(f"{S.RPH}/events/{eid}/"))
    start = parse_dt(ev["start"])
    fetched = []
    if start and start > now() + timedelta(hours=1):
        write(d / "event.json", ev, indent=1)
        return dict(id=eid, state="upcoming", fetched=[])
    players = read(d / "players.json", {})
    all_complete = True
    for ph in ev["phases"]:
        for r in ph["rounds"]:
            if not r["paired"]:
                continue
            f = d / "rounds" / f"p{ph['order']}r{r['round']}.json"
            cached = read(f, None)
            if cached and cached.get("status") == "COMPLETE":
                continue
            ms = S.paged(get, f"{S.RPH}/tournament-rounds/{r['id']}/matches/paginated/")
            rows, ps = S.compact_round(ms)
            for pid, (name, deck) in ps.items():
                old = players.get(pid)
                players[pid] = [name or (old or [None])[0], deck or (old[1] if old else None)]
            write(f, dict(phase=ph["order"], round=r["round"], status=r["status"], fetched_at=stamp(), rows=rows))
            fetched.append(f.name)
            if r["status"] != "COMPLETE":
                all_complete = False
            log(f"  {entry['slug']}: phase {ph['order']} round {r['round']} {r['status']} ({len(rows)} matches)")
    ev["fetched_at"] = stamp()
    write(d / "players.json", players)
    write(d / "event.json", ev, indent=1)
    finished = ev["display_status"] == "complete" and all_complete and all(
        p["status"] == "COMPLETE" for p in ev["phases"] if p["rounds"])
    return dict(id=eid, state="final" if finished else "live", fetched=fetched)


def duels_file(ev: dict, data: Path = DATA) -> Path | None:
    """One snapshot per format family and window, shared by every event that uses it."""
    if not ev.get("start"):
        return None
    first = S.duels_window(ev["start"])[0]
    return data / "duels" / f"{ev.get('family', 'core')}-{first.isoformat()}.json"


def duels_due(ev: dict, today=None) -> bool:
    """The window is the two complete weeks before the event's week, so it is final once that week starts."""
    if not ev.get("start"):
        return False
    today = today or now().date()
    return today >= S.sunday_of(parse_dt(ev["start"]).date())


def refresh(get=S.http_json, data: Path = DATA, log=print, discover_ok=True, duels_ok=True, duels_get=None) -> dict:
    reg = registry(data)
    summary = dict(pulled=[], duels=[], added=[])
    for entry in reg["events"]:
        d = data / "rph" / str(entry["id"])
        if not entry.get("final"):
            try:
                res = pull_event(entry, get, data, log)
            except Exception as e:  # one event failing must not stop the rest
                log(f"  {entry['slug']}: pull failed: {e}")
                continue
            summary["pulled"].append(res)
            if res["state"] == "final":
                entry["final"] = True
                entry["finalized_at"] = stamp()
        ev = read(d / "event.json", None)
        dfile = duels_file(ev, data) if ev else None
        if duels_ok and dfile and not dfile.exists() and duels_due(ev):
            try:
                write(dfile, S.duels_snapshot(ev, duels_get or get), indent=None)
                summary["duels"].append(entry["id"])
                log(f"  {entry['slug']}: Duels snapshot taken ({dfile.name})")
            except Exception as e:
                log(f"  {entry['slug']}: Duels snapshot failed: {e}")
    last = parse_dt(reg.get("last_discover"))
    if discover_ok and (not last or now() - last > timedelta(hours=DISCOVER_EVERY_HOURS)):
        try:
            found = S.discover(get)
            reg["last_discover"] = stamp()
            write(data / "discovered.json", dict(at=stamp(), events=found), indent=1)
            save_registry(reg, data)
            known = {e["id"] for e in reg["events"]}
            for f in found:
                if f["pairings_visible"] and f["players"] >= AUTO_ADD_MIN_PLAYERS and f["id"] not in known:
                    add_event(str(f["id"]), get, data, how="auto")
                    summary["added"].append(f["id"])
                    log(f"  discovered {f['name']} ({f['players']} players) with pairings shown: added")
            reg = registry(data)
        except Exception as e:
            log(f"  discovery failed: {e}")
    save_registry(reg, data)
    return summary


# ---------------------------------------------------------------- build

def build_event(entry: dict, data: Path = DATA) -> dict | None:
    d = data / "rph" / str(entry["id"])
    ev = read(d / "event.json", None)
    if not ev:
        return None
    players = read(d / "players.json", {})
    rounds = []
    for f in sorted((d / "rounds").glob("p*r*.json"), key=lambda p: tuple(int(x) for x in re.findall(r"\d+", p.stem))):
        rounds.append(read(f, None))
    # deck order: by field count in the first round of phase 1
    first = next((r for r in rounds if r["phase"] == 1), None)
    count = {}
    seated = set()
    for r in ([first] if first else []):
        for row in r["rows"]:
            for pid in (row[1], row[2]):
                if pid is not None and pid not in seated:
                    seated.add(pid)
                    deck = (players.get(str(pid)) or [None, None])[1] or "Unknown"
                    count[deck] = count.get(deck, 0) + 1
    for pid, (_, deck) in players.items():
        count.setdefault(deck or "Unknown", 0)
    decks = sorted(count, key=lambda k: (k == "Unknown", -count[k], k))
    di = {k: i for i, k in enumerate(decks)}
    pids = sorted(players, key=lambda p: int(p))
    pi = {int(p): i for i, p in enumerate(pids)}
    plist = [[players[p][0], di[players[p][1] or "Unknown"]] for p in pids]
    matches = []
    for r in rounds:
        for t, p1, p2, res, gw, gl in r["rows"]:
            matches.append([r["phase"], r["round"], pi.get(p1, -1), pi.get(p2, -1) if p2 is not None else -1, res, gw, gl])
    dfile = duels_file(ev, data)
    duels = read(dfile, None) if dfile else None
    live = not entry.get("final") and ev["display_status"] in ("inProgress",)
    return dict(
        meta=dict(ev, slug=entry["slug"], live=live, final=bool(entry.get("final")), built_at=stamp(),
                  rounds=[dict(phase=r["phase"], round=r["round"], status=r["status"], fetched_at=r.get("fetched_at"),
                               total=len(r["rows"]), reported=sum(1 for x in r["rows"] if x[3] != -1)) for r in rounds]),
        decks=decks, decks_key=[S.label_key(k) if k != "Unknown" else None for k in decks],
        players=plist, matches=matches, duels=duels,
    )


def build(data: Path = DATA, out: Path = SITE_DATA) -> list:
    reg = registry(data)
    index = []
    for entry in reg["events"]:
        e = build_event(entry, data)
        if not e:
            continue
        write(out / "events" / f"{entry['slug']}.json", e)
        m = e["meta"]
        field = {}
        for p in e["players"]:
            field[p[1]] = field.get(p[1], 0) + 1
        top = max((k for k in field if e["decks"][k] != "Unknown"), key=lambda k: field[k], default=None)
        index.append(dict(slug=entry["slug"], id=m["id"], name=m["name"], start=m["start"], end=m["end"],
                          venue=m["venue"], address=m["address"], players=m["players"], format=m["format"],
                          live=m["live"], final=m["final"], display_status=m["display_status"],
                          rounds_done=sum(1 for r in m["rounds"] if r["status"] == "COMPLETE"),
                          top_deck=e["decks"][top] if top is not None else None, has_duels=bool(e["duels"]),
                          pairings_visible=m["pairings_visible"], updated=m.get("fetched_at")))
    index.sort(key=lambda x: x["start"] or "", reverse=True)
    write(out / "index.json", dict(built_at=stamp(), events=index), indent=1)
    return index


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("ref")
    r = sub.add_parser("refresh"); r.add_argument("--no-discover", action="store_true"); r.add_argument("--no-duels", action="store_true")
    sub.add_parser("build")
    sub.add_parser("discover")
    args = ap.parse_args(argv)
    if args.cmd == "add":
        e = add_event(args.ref)
        print(f"tracking {e['name']} as {e['slug']}")
    elif args.cmd == "refresh":
        s = refresh(discover_ok=not args.no_discover, duels_ok=not args.no_duels)
        print(json.dumps(s))
    elif args.cmd == "build":
        idx = build()
        print(f"built {len(idx)} events")
    elif args.cmd == "discover":
        for f in S.discover():
            print(f"{f['id']:>9} {f['start'][:10]} {f['players']:>5} {'PAIRINGS' if f['pairings_visible'] else '        '} {f['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
