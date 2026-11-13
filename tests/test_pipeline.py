"""Pipeline tests, no network. Run: python -m unittest discover -s tests"""
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from pipeline import __main__ as P
from pipeline import sources as S


def rel(pid, label, order, name=None):
    return {"player_order": order, "player": {"id": pid, "best_identifier": f"p{pid}"},
            "user_event_status": {"best_identifier": name or f"p{pid}",
                                  "deck_descriptor_label": {"label": label} if label else None}}


def match(p1, d1, p2=None, d2=None, winner=None, status="COMPLETE", bye=False, draw=False, gw=2, gl=1, table=1):
    rels = [rel(p1, d1, 1)] + ([rel(p2, d2, 2)] if p2 else [])
    return {"player_match_relationships": rels, "status": status, "match_is_bye": bye, "match_is_intentional_draw": draw,
            "match_is_unintentional_draw": False, "winning_player": winner, "games_won_by_winner": gw,
            "games_won_by_loser": gl, "table_number": table}


AE, ES = "Amber, Emerald", "Emerald, Steel"


class Compact(unittest.TestCase):
    def test_results(self):
        rows, players = S.compact_round([
            match(1, AE, 2, ES, winner=1),
            match(3, AE, 4, ES, winner=4),
            match(5, AE, 6, None, draw=True),
            match(7, ES, bye=True),
            match(8, AE, 9, ES, status="IN_PROGRESS"),
        ])
        self.assertEqual([r[3] for r in rows], [1, 2, 0, 3, -1])
        self.assertEqual(players["6"], ["p6", None])
        self.assertEqual(players["1"], ["p1", AE])


class Helpers(unittest.TestCase):
    def test_parse_event_id(self):
        self.assertEqual(S.parse_event_id("https://tcg.ravensburgerplay.com/events/1254364"), 1254364)
        self.assertEqual(S.parse_event_id("1254365"), 1254365)

    def test_duels_window_london(self):
        # London starts Fri 13 Nov 2026: the two full weeks before its week are 25 Oct and 1 Nov
        self.assertEqual(S.duels_window("2026-11-13T09:00:00+00:00"), [date(2026, 10, 25), date(2026, 11, 1)])
        # an event on a Sunday starts its own week
        self.assertEqual(S.duels_window("2026-11-15T09:00:00+00:00"), [date(2026, 11, 1), date(2026, 11, 8)])

    def test_keys(self):
        self.assertEqual(S.label_key("Emerald, Amber"), "amber-emerald")
        self.assertEqual(S.pair_key(["steel", "emerald"]), "emerald-steel")

    def test_duels_due(self):
        ev = {"start": "2026-11-13T09:00:00+00:00"}
        self.assertFalse(P.duels_due(ev, date(2026, 11, 7)))
        self.assertTrue(P.duels_due(ev, date(2026, 11, 8)))


def fake_api(event, rounds):
    calls = []

    def get(url):
        calls.append(url)
        if "/tournament-rounds/" in url:
            rid = int(url.split("/tournament-rounds/")[1].split("/")[0])
            return {"results": rounds[rid], "next_page_number": None}
        if "/events/?" in url:
            return {"results": [dict(event, registered_user_count=900)], "next_page_number": None}
        return event
    return get, calls


EVENT = {"id": 77, "name": "Test Challenge", "start_datetime": "2020-01-04T09:00:00+00:00", "end_datetime": None,
         "display_status": "inProgress", "starting_player_count": 4, "gameplay_format": {"name": "Core Constructed"},
         "tournament_phases": [{"order_in_phases": 1, "round_type": "SWISS", "status": "IN_PROGRESS", "number_of_rounds": 2,
                                "effective_show_deck_descriptor_to_opponents": True, "effective_maximum_number_of_game_wins_per_match": 2,
                                "rounds": [{"id": 1, "round_number": 1, "status": "COMPLETE", "pairings_status": "GENERATED"},
                                           {"id": 2, "round_number": 2, "status": "IN_PROGRESS", "pairings_status": "GENERATED"}]}]}
ROUNDS = {1: [match(1, AE, 2, ES, winner=1), match(3, AE, 4, ES, winner=4)], 2: [match(1, AE, 4, ES, status="IN_PROGRESS")]}


class Refresh(unittest.TestCase):
    def test_cache_build_and_final(self):
        with tempfile.TemporaryDirectory() as t:
            data, out = Path(t) / "data", Path(t) / "site"
            get, calls = fake_api(EVENT, ROUNDS)
            P.add_event("77", get, data)
            P.refresh(get, data, log=lambda *a: None, discover_ok=False, duels_ok=False)
            self.assertTrue(any("/tournament-rounds/1/" in c for c in calls))
            calls.clear()
            P.refresh(get, data, log=lambda *a: None, discover_ok=False, duels_ok=False)
            self.assertFalse(any("/tournament-rounds/1/" in c for c in calls), "complete round re-fetched")
            self.assertTrue(any("/tournament-rounds/2/" in c for c in calls))
            idx = P.build(data, out)
            self.assertEqual(len(idx), 1)
            ev = json.loads((out / "events" / f"{idx[0]['slug']}.json").read_text(encoding="utf-8"))
            self.assertEqual(ev["decks"][:2], [AE, ES])
            self.assertEqual(ev["decks_key"][0], "amber-emerald")
            self.assertEqual(len(ev["matches"]), 3)
            self.assertEqual(ev["matches"][0][:2], [1, 1])
            # the event finishes: one more pull, then frozen
            done = json.loads(json.dumps(EVENT))
            done["display_status"] = "complete"
            done["tournament_phases"][0]["status"] = "COMPLETE"
            done["tournament_phases"][0]["rounds"][1]["status"] = "COMPLETE"
            r2 = {1: ROUNDS[1], 2: [match(1, AE, 4, ES, winner=4)]}
            get2, calls2 = fake_api(done, r2)
            P.refresh(get2, data, log=lambda *a: None, discover_ok=False, duels_ok=False)
            self.assertTrue(P.registry(data)["events"][0]["final"])
            calls2.clear()
            P.refresh(get2, data, log=lambda *a: None, discover_ok=False, duels_ok=False)
            self.assertEqual(calls2, [], "a final event was pulled again")

    def test_discovery_auto_adds_big_events_with_pairings(self):
        with tempfile.TemporaryDirectory() as t:
            data = Path(t) / "data"
            get, _ = fake_api(EVENT, ROUNDS)
            s = P.refresh(get, data, log=lambda *a: None, duels_ok=False)
            self.assertEqual(s["added"], [77])
            self.assertEqual(P.registry(data)["events"][0]["added"], "auto")

    def test_duels_file_shared_by_window(self):
        a = P.duels_file({"start": "2026-11-13T09:00:00+00:00", "family": "core"})
        b = P.duels_file({"start": "2026-11-14T09:00:00+00:00", "family": "core"})
        self.assertEqual(a, b)
        self.assertEqual(a.name, "core-2026-10-25.json")


if __name__ == "__main__":
    unittest.main()
