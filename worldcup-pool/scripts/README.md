# WC2026 Scoresheet Auto-Updater

Fills in `WC2026_scoresheet_unified.xlsx` daily prop results (column I) and
group standings (Field1-4, columns C-F) using free-tier API-Football data.

## Setup

1. Get a free API key at https://www.api-sports.io/ (Football API, free plan
   = 100 requests/day).
2. `pip install -r requirements.txt`
3. `export API_FOOTBALL_KEY=your_key_here`

## Usage

Run the morning after a match day:

```bash
python3 update_scoresheet.py --file /path/to/WC2026_scoresheet_unified.xlsx
```

Preview without writing:

```bash
python3 update_scoresheet.py --dry-run
```

## What it does

- For each `prop1` row (rows 2-35) with an empty `Result` (column I), looks
  up the relevant fixture(s) for that prop's date and resolves YES/NO based
  on score, goal events, cards, or specific players (clean sheets, win/loss,
  total goals, margins, first-half goals, late goals, red/yellow cards,
  goal/assist by named player).
- For multi-match props (red card on Day 3, penalty in either of two Jun 16
  matches, late goal anywhere on Jun 20/26), waits until **all** matches that
  day are final before resolving.
- For group rows (36-47), once a group's standings show all teams have played
  3 matches, fills Field1-4 (columns C-F) with the final ranked team order.
- Adds a short "Auto: ..." note in column L explaining the result source.
- Skips any row that already has a value (so manual entries / admin overrides
  in the app are never clobbered).
- Saves a timestamped `.bak` copy before writing.

## API call budget

Each unique match date = 1 fixtures call + 1 events call per relevant match.
Standings = 1 call total. A normal day (2 props, 1-2 matches involved) uses
roughly 3-5 calls, well within the 100/day free limit.

## Notes / limitations

- Team name differences (e.g. "Czechia" vs "Czech Republic", "Curacao" vs
  "Curaçao") are normalized via `TEAM_NAME_MAP` at the top of the script;
  add entries there if API-Football uses a different name for a team.
- Player matching is substring-based on last name (e.g. "Ronaldo", "Messi",
  "Haaland") and should be reliable, but double-check column L notes.
- Penalty detection (prop #11) checks for `Goal` events with detail
  `Penalty`/`Missed Penalty`. If a saved penalty isn't flagged this way,
  that edge case may need manual review.
- Anything left blank (unresolvable, match not finished, ambiguous) stays
  blank for manual entry / admin override in the app as before.
