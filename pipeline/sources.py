"""Data sources: the Ravensburger Play network (events, rounds, matches) and
Duels.ink (online meta, fetched once per event and kept).

Ravensburger Play, public and unauthenticated (verified 2026-11-13):
  GET /api/v2/events/{id}/                                       phases, rounds, statuses
  GET /api/v2/events/?game_id=1&start_date_after=&start_date_before=&page=&page_size=
  GET /api/v2/tournament-rounds/{round_id}/matches/paginated/?page=&page_size=

Duels.ink:
  GET /api/stats/meta?queue=&period=week:<sunday>&era=<key>&ranks=<csv>
  Grouped by week (Sunday to Saturday). Duels asks crawlers to stay off its API,
  so this module only ever fetches an event's comparison window once, stores it,
  and never refreshes a finished week.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

RPH = "https://api.ravensburgerplay.com/api/v2"
DUELS = "https://duels.ink/api/stats/meta"
UA = {"User-Agent": "lorcana-meta/1.0", "Accept": "application/json"}

LEGENDARY_PLUS = ["Legendary", "Epic", "Enchanted", "Iconic"]
DUELS_QUEUES = {"core": ["core-bo3", "core-bo1"], "infinity": ["infinity-bo3", "infinity-bo1"]}


def http_json(url: str, tries: int = 4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404) or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == tries - 1:
                raise
        time.sleep(3 * (attempt + 1))


def paged(get, url: str, page_size: int = 500) -> list:
    page, out = 1, []
    sep = "&" if "?" in url else "?"
    while page:
        d = get(f"{url}{sep}page={page}&page_size={page_size}")
        out += d["results"]
        page = d.get("next_page_number")
    return out


# ---------------------------------------------------------------- Ravensburger

def parse_event_id(text: str) -> int:
    """Accepts an id or any event URL."""
    digits = "".join(ch if ch.isdigit() else " " for ch in str(text)).split()
    if not digits:
        raise ValueError(f"no event id in {text!r}")
    return int(max(digits, key=len))


def format_family(event: dict) -> str:
    name = ((event.get("gameplay_format") or {}).get("name") or "").lower()
    return "infinity" if "infinity" in name else "core"


def pairings_visible(event: dict) -> bool:
    return any(p.get("effective_show_deck_descriptor_to_opponents") for p in event.get("tournament_phases", []))


def trim_event(ev: dict) -> dict:
    store = ev.get("store") or {}
    return dict(
        id=ev["id"], name=ev.get("name"), start=ev.get("start_datetime"), end=ev.get("end_datetime"),
        timezone=ev.get("timezone"), display_status=ev.get("display_status"),
        players=ev.get("starting_player_count") or ev.get("registered_user_count"),
        format=(ev.get("gameplay_format") or {}).get("name"), family=format_family(ev),
        venue=store.get("name") if isinstance(store, dict) else None,
        address=ev.get("full_address"), top_cut_size=ev.get("top_cut_size"),
        url=f"https://tcg.ravensburgerplay.com/events/{ev['id']}",
        pairings_visible=pairings_visible(ev),
        phases=[dict(order=p["order_in_phases"], type=p.get("round_type"), status=p.get("status"),
                     rounds_planned=p.get("number_of_rounds"),
                     best_of=(p.get("effective_maximum_number_of_game_wins_per_match") or 2) * 2 - 1,
                     rounds=[dict(id=r["id"], round=r["round_number"], status=r["status"],
                                  paired=r.get("pairings_status") == "GENERATED")
                             for r in sorted(p.get("rounds", []), key=lambda r: r["round_number"])])
                for p in sorted(ev.get("tournament_phases", []), key=lambda p: p["order_in_phases"])],
    )


def deck_label(rel: dict) -> str | None:
    lab = ((rel.get("user_event_status") or {}).get("deck_descriptor_label") or {})
    return lab.get("label") or None


def compact_round(matches: list) -> tuple[list, dict]:
    """-> (rows, players). Row: [table, p1, p2|None, result, games_w, games_l]
    result: 1 = p1 won, 2 = p2 won, 0 = draw, -1 = not reported, 3 = bye."""
    rows, players = [], {}
    for m in matches:
        rels = sorted(m.get("player_match_relationships", []), key=lambda x: x["player_order"])
        ids = []
        for x in rels:
            pid = x["player"]["id"]
            ids.append(pid)
            ues = x.get("user_event_status") or {}
            players[str(pid)] = [ues.get("best_identifier") or x["player"].get("best_identifier"), deck_label(x)]
        p1 = ids[0] if ids else None
        p2 = ids[1] if len(ids) > 1 else None
        if m.get("match_is_bye") or p2 is None:
            res = 3 if m.get("status") == "COMPLETE" else -1
        elif m.get("status") != "COMPLETE":
            res = -1
        elif m.get("match_is_intentional_draw") or m.get("match_is_unintentional_draw") or m.get("winning_player") is None:
            res = 0
        else:
            res = 1 if m["winning_player"] == p1 else 2
        rows.append([m.get("table_number"), p1, p2, res, m.get("games_won_by_winner") or 0, m.get("games_won_by_loser") or 0])
    return rows, players


def discover(get=http_json, days_back: int = 2, days_ahead: int = 10, min_players: int = 128, today: date | None = None) -> list[dict]:
    """Lorcana events in a date window big enough to matter, with their pairings flag."""
    today = today or datetime.now(timezone.utc).date()
    a, b = today - timedelta(days=days_back), today + timedelta(days=days_ahead)
    url = f"{RPH}/events/?game_id=1&start_date_after={a.isoformat()}&start_date_before={b.isoformat()}"
    found, seen = [], set()
    for e in paged(get, url, page_size=200):
        n = max(e.get("registered_user_count") or 0, e.get("starting_player_count") or 0)
        if n < min_players or e["id"] in seen:
            continue
        seen.add(e["id"])
        full = get(f"{RPH}/events/{e['id']}/")
        found.append(dict(id=e["id"], name=e.get("name"), start=e.get("start_datetime"), players=n,
                          format=(e.get("gameplay_format") or {}).get("name"), pairings_visible=pairings_visible(full)))
    return found


# ---------------------------------------------------------------- Duels

def sunday_of(d: date) -> date:
    return d - timedelta(days=(d.weekday() + 1) % 7)


def duels_window(event_start: str, weeks: int = 2) -> list[date]:
    """The `weeks` complete Duels weeks (Sun-Sat) before the week the event starts in."""
    start = datetime.fromisoformat(event_start.replace("Z", "+00:00")).date()
    first = sunday_of(start)
    return [first - timedelta(days=7 * k) for k in range(weeks, 0, -1)]


def _era_for(week: date, eras: dict) -> str:
    cur = eras.get("currentEra") or {}
    for e in [cur] + list(eras.get("pastEras") or []):
        s = datetime.fromisoformat(e["startedAt"].replace("Z", "+00:00")).date()
        end = e.get("endedAt")
        en = datetime.fromisoformat(end.replace("Z", "+00:00")).date() if end else date.max
        if s <= week + timedelta(days=6) and week <= en:
            return "current" if e is cur else e["key"]
    return "current"


def pair_key(colors) -> str:
    return "-".join(sorted(c.lower() for c in colors))


def label_key(label: str) -> str:
    return pair_key(x.strip() for x in label.split(","))


def duels_snapshot(event: dict, get=http_json, weeks: int = 2) -> dict:
    """Fetch the comparison window for one event. About 9 requests, once per event."""
    window = duels_window(event["start"], weeks)
    queues = DUELS_QUEUES[event.get("family", "core")]
    head = get(f"{DUELS}?{urllib.parse.urlencode({'queue': queues[0], 'era': 'current'})}")
    eras = head["meta"]["eras"]
    out = dict(fetched_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               weeks=[w.isoformat() for w in window],
               first_day=window[0].isoformat(), last_day=(window[-1] + timedelta(days=6)).isoformat(),
               queues={})
    for q in queues:
        out["queues"][q] = {}
        for tier, ranks in (("all", None), ("legendary", LEGENDARY_PLUS)):
            pairs, mus, total, weeks_ok = {}, {}, 0, []
            for w in window:
                params = {"queue": q, "period": f"week:{w.isoformat()}", "era": _era_for(w, eras)}
                if ranks:
                    params["ranks"] = ",".join(ranks)
                d = get(f"{DUELS}?{urllib.parse.urlencode(params)}")
                if not d.get("colorPairs"):
                    continue
                weeks_ok.append(w.isoformat())
                total += (d.get("activity") or {}).get("totalGames") or 0
                for c in d["colorPairs"]:
                    k = pair_key(c["colors"])
                    p = pairs.setdefault(k, dict(games=0, wins=0))
                    p["games"] += c.get("games") or 0
                    p["wins"] += c.get("wins") or 0
                for m in d.get("matchups") or []:
                    k = pair_key(m["colorsA"]) + "|" + pair_key(m["colorsB"])
                    x = mus.setdefault(k, dict(games=0, winsA=0))
                    x["games"] += m.get("games") or 0
                    x["winsA"] += m.get("winsA") or 0
                time.sleep(1.5)
            deck_games = sum(p["games"] for p in pairs.values()) or 1
            for p in pairs.values():
                p["win_rate"] = round(100 * p["wins"] / p["games"], 2) if p["games"] else None
                p["play_rate"] = round(100 * p["games"] / deck_games, 2)
            out["queues"][q][tier] = dict(games=total, weeks=weeks_ok, pairs=pairs, matchups=mus)
    return out
