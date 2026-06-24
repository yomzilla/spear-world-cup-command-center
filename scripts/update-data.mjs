// Fetches live FIFA World Cup data from football-data.org, auto-computes each
// sweepstakes owner's team results, and writes data/state.json for the site.
// Runs with zero dependencies on Node 20+ (global fetch). Safe with no token:
// it then emits a valid "scaffold" state (all zeros) so the site never breaks.
import fs from "fs";

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMP = process.env.WC_COMP || "WC";

// Team -> owner map (index order MUST match the app's TEAMS array).
const OWNERS = [
  ["Algeria", "Meghan Tauke"], ["Argentina", "Ross Swartz"], ["Australia", "Jill Olsen"],
  ["Austria", "Carter Codell"], ["Belgium", "Phoebe Rogers"], ["Bosnia and Herzegovina", "Jovana Paripovic"],
  ["Brazil", "Troy Davis"], ["Cabo Verde", "Samuel Kim"], ["Canada", "Ryan McKeown"],
  ["Colombia", "John Askew"], ["Congo DR", "Gregg O'Brien"], ["Côte d'Ivoire", "Yomi Afolabi"],
  ["Croatia", "Chris Lawler"], ["Curaçao", "Chris Lawler"], ["Czechia", "Caitlin Hopkins"],
  ["Ecuador", "Christina Missirian"], ["Egypt", "Thiago Marques"], ["England", "Abbey Maxwell"],
  ["France", "Elise Eldridge"], ["Germany", "Chester Wells"], ["Ghana", "Ross Swartz"],
  ["Haiti", "Michael Epping"], ["IR Iran", "Abbey Maxwell"], ["Iraq", "Alex Hymson"],
  ["Japan", "Andy Burkhardt"], ["Jordan", "Holly Burmaster"], ["Korea Republic", "Carter Codell"],
  ["Mexico", "Jovana Paripovic"], ["Morocco", "Joe Hannon"], ["Netherlands", "Joe Hannon"],
  ["New Zealand", "Andy Burkhardt"], ["Norway", "Mycah Russel"], ["Panama", "Anthony Martinez"],
  ["Paraguay", "Elise Eldridge"], ["Portugal", "Itay Weinreb"], ["Qatar", "Thiago Marques"],
  ["Saudi Arabia", "Anthony Martinez"], ["Scotland", "Hazael Magino"], ["Senegal", "Troy Davis"],
  ["South Africa", "Ola Olabode"], ["Spain", "Yomi Afolabi"], ["Sweden", "Helen Burkhardt"],
  ["Switzerland", "Holly Burmaster"], ["Tunisia", "Jill Olsen"], ["Türkiye", "Helen Burkhardt"],
  ["United States", "Matt Bulmer"], ["Uruguay", "Addison Farley"], ["Uzbekistan", "Itay Weinreb"],
];
const NAMES = OWNERS.map((o) => o[0]);

// Normalise football-data.org names to ours.
const ALIASES = {
  "South Korea": "Korea Republic", "Republic of Korea": "Korea Republic",
  "Iran": "IR Iran", "USA": "United States", "United States of America": "United States",
  "Czech Republic": "Czechia", "Turkey": "Türkiye", "Ivory Coast": "Côte d'Ivoire",
  "DR Congo": "Congo DR", "Democratic Republic of Congo": "Congo DR",
  "Cape Verde": "Cabo Verde", "Bosnia-Herzegovina": "Bosnia and Herzegovina",
  "Bosnia & Herzegovina": "Bosnia and Herzegovina", "Curacao": "Curaçao",
};
const canon = (n) => (n ? (ALIASES[n] || n) : n);

const blank = () => ({ w: 0, d: 0, l: 0, gf: 0, ga: 0, yc: 0, rc: 0 });
const results = Object.fromEntries(NAMES.map((n) => [n, blank()]));

let live = false, source = "scaffold";
let fixtures = [], groups = [], topScorer = null;
let cardCache = {};   // matchId -> { h:{y,r}, a:{y,r}, home, away }
let goalCache = {};   // matchId -> [{ team, minute }]
const matchMeta = []; // { id, home, away, status, hs, as }

// load previous caches so finished matches aren't re-fetched every run
try {
  const prev = JSON.parse(fs.readFileSync("data/state.json", "utf8"));
  cardCache = prev.cardCache || {};
  goalCache = prev.goalCache || {};
} catch (e) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const r = await fetch(`https://api.football-data.org/v4/${path}`, {
    headers: { "X-Auth-Token": TOKEN },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

if (TOKEN) {
  try {
    const data = await api(`competitions/${COMP}/matches`);
    for (const m of data.matches || []) {
      const home = canon(m.homeTeam?.name), away = canon(m.awayTeam?.name);
      const hs = m.score?.fullTime?.home, as = m.score?.fullTime?.away;
      matchMeta.push({ id: m.id, home, away, status: m.status, hs, as });
      fixtures.push({
        utcDate: m.utcDate, home, away, status: m.status,
        hs: hs ?? null, as: as ?? null, stage: m.stage || null, group: m.group || null,
        venue: m.venue || null, winner: m.score?.winner || null,
      });
      if (m.status === "FINISHED" && results[home] && results[away] && hs != null && as != null) {
        results[home].gf += hs; results[home].ga += as;
        results[away].gf += as; results[away].ga += hs;
        if (hs > as) { results[home].w++; results[away].l++; }
        else if (hs < as) { results[away].w++; results[home].l++; }
        else { results[home].d++; results[away].d++; }
      }
    }
    live = true; source = "football-data.org";
    try {
      const st = await api(`competitions/${COMP}/standings`);
      groups = (st.standings || []).filter((s) => s.type === "TOTAL").map((s) => ({
        name: s.group ? s.group.replace("_", " ") : "Group",
        rows: (s.table || []).map((r) => ({
          team: canon(r.team?.name), p: r.playedGames, gd: r.goalDifference, pts: r.points,
        })),
      }));
    } catch (e) { console.error("standings:", e.message); }
    try {
      const sc = await api(`competitions/${COMP}/scorers`);
      const top = (sc.scorers || [])[0];
      if (top) topScorer = { name: top.player?.name, team: canon(top.team?.name), goals: top.goals };
    } catch (e) { console.error("scorers:", e.message); }

    // --- Cards (yellow/red) via per-match detail, cached + throttled ---
    // Fetch details only for in-play matches and finished matches we haven't
    // cached yet, capped per run to respect the free-tier rate limit (10/min).
    const MAX_DETAIL = 8;
    const needsFetch = matchMeta.filter(
      (m) => m.status === "IN_PLAY" || m.status === "PAUSED" || (m.status === "FINISHED" && (!cardCache[m.id] || !goalCache[m.id]))
    ).slice(0, MAX_DETAIL);
    for (const m of needsFetch) {
      try {
        const d = await api(`matches/${m.id}`);
        const agg = { h: { y: 0, r: 0 }, a: { y: 0, r: 0 }, home: m.home, away: m.away };
        for (const bk of d.bookings || []) {
          const side = canon(bk.team?.name) === m.home ? agg.h : canon(bk.team?.name) === m.away ? agg.a : null;
          if (!side) continue;
          if (bk.card === "YELLOW") side.y++;
          else if (bk.card === "RED" || bk.card === "YELLOW_RED") side.r++;
        }
        cardCache[m.id] = agg;
        
        // Extract goal events with timing
        const goals = [];
        for (const goal of d.goals || []) {
          const team = canon(goal.team?.name);
          const minute = goal.minute;
          if (team && minute != null && NAMES.includes(team)) {
            goals.push({ team, minute });
          }
        }
        goalCache[m.id] = goals;
      } catch (e) { console.error("match", m.id, e.message); }
      await sleep(6500);
    }
    // Apply cached cards to team totals.
    for (const c of Object.values(cardCache)) {
      if (results[c.home]) { results[c.home].yc += c.h.y; results[c.home].rc += c.h.r; }
      if (results[c.away]) { results[c.away].yc += c.a.y; results[c.away].rc += c.a.r; }
    }
  } catch (e) {
    console.error("API unavailable, writing scaffold:", e.message);
  }
} else {
  console.log("No FOOTBALL_DATA_TOKEN set — writing scaffold (all zeros).");
}

// Admin-controlled manual prize picks (team indices or null).
let manual = { biggestLoss: null, goldenBoot: null, fastestGoal: null, furthestGoal: null, dirtiestTeam: null };
try { manual = { ...manual, ...JSON.parse(fs.readFileSync("config/manual.json", "utf8")) }; } catch (e) {}

// Auto-fill Golden Boot from the live top scorer if the admin hasn't pinned one.
if (topScorer && manual.goldenBoot == null) {
  const idx = NAMES.indexOf(topScorer.team);
  if (idx >= 0) manual.goldenBoot = idx;
}

// Auto-fill Biggest Loss: losing team in the finished match with the largest
// goal gap (tie broken by most goals conceded), unless the admin pinned it.
if (manual.biggestLoss == null) {
  let loser = null, bestGap = 0, bestConceded = -1;
  for (const m of matchMeta) {
    if (m.status !== "FINISHED" || m.hs == null || m.as == null || m.hs === m.as) continue;
    const gap = Math.abs(m.hs - m.as);
    const conceded = Math.max(m.hs, m.as);
    if (gap > bestGap || (gap === bestGap && conceded > bestConceded)) {
      bestGap = gap; bestConceded = conceded;
      loser = m.hs < m.as ? m.home : m.away;
    }
  }
  if (loser) { const idx = NAMES.indexOf(loser); if (idx >= 0) manual.biggestLoss = idx; }
}

// Auto-fill Fastest Goal: team that scored earliest (lowest minute) unless admin pinned it.
if (manual.fastestGoal == null) {
  const allGoals = Object.values(goalCache).flat();
  if (allGoals.length > 0) {
    const sorted = [...allGoals].sort((a, b) => a.minute - b.minute);
    const fastest = sorted[0];
    const idx = NAMES.indexOf(fastest.team);
    if (idx >= 0) manual.fastestGoal = idx;
  }
}

// Auto-fill Furthest Goal: team that scored latest (highest minute) unless admin pinned it.
if (manual.furthestGoal == null) {
  const allGoals = Object.values(goalCache).flat();
  if (allGoals.length > 0) {
    const sorted = [...allGoals].sort((a, b) => b.minute - a.minute);
    const furthest = sorted[0];
    const idx = NAMES.indexOf(furthest.team);
    if (idx >= 0) manual.furthestGoal = idx;
  }
}

// Auto-fill Dirtiest Team: team with most card points (Y=1, R=3), tie-broken by most reds.
if (manual.dirtiestTeam == null) {
  let dirtiest = null, bestCardPts = 0, bestReds = -1;
  for (const teamName of NAMES) {
    const r = results[teamName];
    const cardPts = r.yc + r.rc * 3;
    if (cardPts > bestCardPts || (cardPts === bestCardPts && r.rc > bestReds)) {
      bestCardPts = cardPts; bestReds = r.rc;
      dirtiest = teamName;
    }
  }
  if (dirtiest && bestCardPts > 0) {
    const idx = NAMES.indexOf(dirtiest);
    if (idx >= 0) manual.dirtiestTeam = idx;
  }
}

const payload = { live, source, results, manual, fixtures, groups, topScorer, cardCache, goalCache };
// Only bump generatedAt when the substantive data actually changed — avoids a
// commit (and Pages rebuild) every 15 minutes when nothing has happened.
let generatedAt = new Date().toISOString();
try {
  const prev = JSON.parse(fs.readFileSync("data/state.json", "utf8"));
  const { generatedAt: _g, ...prevRest } = prev;
  if (JSON.stringify(prevRest) === JSON.stringify(payload)) generatedAt = prev.generatedAt;
} catch (e) { /* no previous file */ }

const state = { generatedAt, ...payload };
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/state.json", JSON.stringify(state, null, 2) + "\n");
console.log(`Wrote data/state.json — live=${live}, source=${source}, fixtures=${fixtures.length}, groups=${groups.length}`);
