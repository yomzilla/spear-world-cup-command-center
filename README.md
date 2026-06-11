# SPEAR World Cup Sweepstakes — Command Center

A self-contained World Cup mission-control dashboard for our office sweepstakes.
**Live site:** https://yomzilla.github.io/spear-world-cup-command-center/

- 48 teams, 32 players, live standings, prizes, group stage, knockout bracket, match center & host-city map.
- Scoring: **Win = 2 · Draw = 1 · Loss = 0**, goal difference breaks ties.
- Personal favourites / notes / alerts are stored per-browser (localStorage).

## How the data stays fresh (no servers)

A scheduled **GitHub Action** (`.github/workflows/update-data.yml`) runs every 15 minutes:

1. `scripts/update-data.mjs` calls the [football-data.org](https://www.football-data.org/) API.
2. It computes every team's W/D/L/GF/GA from finished matches and maps them to owners.
3. It writes `data/state.json`, which the site fetches on load (and every few minutes).
4. If the file changed, the workflow commits it — GitHub Pages redeploys automatically.

If no API token is configured it still writes a valid all-zeros file, so the site never breaks.

## One-time setup to turn on live data

1. Get a free API token at https://www.football-data.org/client/register
2. Add it as a repo secret:
   ```
   gh secret set FOOTBALL_DATA_TOKEN --repo yomzilla/spear-world-cup-command-center
   ```
3. (Optional) set the competition code if needed:
   ```
   gh variable set WC_COMP --body WC --repo yomzilla/spear-world-cup-command-center
   ```
4. Trigger a run now:
   ```
   gh workflow run "Update World Cup Data" --repo yomzilla/spear-world-cup-command-center
   ```

## Admin: manual prize picks

Three prizes can't be derived from scores. Edit `config/manual.json` (values are team
indices 0–47, matching the team list order) and commit — the next run folds them in.
Golden Boot auto-fills from the live top scorer unless you pin it here.

```json
{ "biggestLoss": null, "goldenBoot": null, "fastestGoal": null, "furthestGoal": null }
```

## Updating the app itself

`index.html` is a pre-built, self-contained React app. Replace it and push; Pages redeploys.
