# Lorcana Meta

Disney Lorcana tournament meta from every match played: ink pairing share,
match and game win rates with 95% ranges, matchups, conversion through day 1,
day 2 and the top cut, round-by-round trends, and a comparison with the online
meta on Duels.ink over the two weeks before each event. Updated about every
15 minutes while an event runs.

Ink pairings became public on the Ravensburger Play network with DLC London
(13 November 2026), so earlier events cannot be covered.

## How it works

- `pipeline/` (Python, standard library only) pulls tracked events from the
  public Ravensburger Play API, fetching only rounds that are new or not yet
  complete, and stores them compactly in `data/rph/<event id>/`. Files are
  rewritten only when results move, so a quiet check commits nothing. When a
  day's rounds are done (the next phase is a day-2 Swiss, or it is past 20:00
  at the venue) the event sleeps until an hour before the next day's start.
- Day 2 is projected before it is paired. With the cut in match points
  (`day2_points`: default 18, i.e. 6-2, for events with two Swiss phases;
  override per event in `data/events.json`), a player on the cut is locked in,
  one who can no longer reach it is out, and the rest are still alive.
- Once an event's week begins, it takes one Duels snapshot of the two full
  weeks (Sunday to Saturday) before it: Core or Infinity, best of three and
  best of one, all ranks and Legendary+. That is about nine requests, and the
  snapshot is shared by every event with the same window
  (`data/duels/<format>-<first sunday>.json`) and never refreshed.
- Once a day it scans the next ten days of events. Any Lorcana event of 256+
  players that shows pairings is tracked automatically; smaller ones are listed
  in `data/discovered.json`.
- `site/` is a static page. All analysis runs in the browser from
  `site/data/events/<slug>.json`, which `python -m pipeline build` writes.
- `.github/workflows/refresh.yml` runs the refresh every 15 minutes, commits
  changed data, and deploys to GitHub Pages only when something changed.

## Commands

```
python -m pipeline add <event id or URL>   track an event by hand
python -m pipeline refresh                 what the workflow runs
python -m pipeline build                   write site/data/
python -m pipeline discover                list big events coming up and whether pairings show
python -m unittest discover -s tests -t .  tests
python -m http.server 8765 --directory site
```

## Credits

Event data: the Ravensburger Play network. Online data: Duels.ink. Lorcana
Meta is an unofficial fan project, not affiliated with or endorsed by Disney
or Ravensburger.
