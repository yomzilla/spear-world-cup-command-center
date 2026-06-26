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
const matchMeta = []; // { id, home, away, status, hs, as }
let fifaFastest = null, fifaFurthest = null;

// Reuse previously cached FIFA match events so finished matches aren't refetched.
let fifaCache = {}; // fifaMatchId -> { cards: {teamName:{y,r}}, goals: [{team,min,mm,dist}] }
try { fifaCache = JSON.parse(fs.readFileSync("data/state.json", "utf8")).fifaCache || {}; } catch (e) {}

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
  } catch (e) {
    console.error("API unavailable, writing scaffold:", e.message);
  }
} else {
  console.log("No FOOTBALL_DATA_TOKEN set — writing scaffold (all zeros).");
}

// --- Official match events from FIFA (goals + cards, with minute & position) ---
// football-data's free tier exposes no bookings or goal detail, so the official
// FIFA match-event API (no key required) powers per-team cards (Dirtiest Team),
// the Fastest Goal (earliest minute) and the Furthest Goal (longest shot
// distance) prizes. Finished matches are cached so only new/in-play matches are
// refetched each run. Source: fifa.com FIFA World Cup 2026 (season 285023).
async function fifaJson(u) {
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!r.ok) throw new Error(`FIFA ${r.status}`);
  return r.json();
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { console.error("fifa:", e.message); } }
  }));
}
const fifaName = (t) => canon(t?.TeamName?.[0]?.Description || t?.ShortClubName || "");
const parseMin = (s) => { const m = /(\d+)'(?:\+(\d+))?/.exec(s || ""); return m ? (+m[1] + (m[2] ? +m[2] / 100 : 0)) : 9999; };
// FIFA uses absolute pitch coords (0-100); the attacking goal is the near line,
// so distance-to-goal = min(X, 100-X) laterally combined with offset from centre.
const goalDist = (x, y) => { const dx = Math.min(x, 100 - x) / 100 * 105, dy = (y - 50) / 100 * 68; return Math.sqrt(dx * dx + dy * dy); };

try {
  const FIFA_SEASON = process.env.FIFA_SEASON || "285023";
  const FIFA_COMP = process.env.FIFA_COMP || "17";
  const cal = await fifaJson(`https://api.fifa.com/api/v3/calendar/matches?idSeason=${FIFA_SEASON}&count=500`);
  const fmatches = cal.Results || [];
  const id2name = {};
  for (const m of fmatches) {
    if (m.Home?.IdTeam) id2name[m.Home.IdTeam] = fifaName(m.Home);
    if (m.Away?.IdTeam) id2name[m.Away.IdTeam] = fifaName(m.Away);
  }
  // MatchStatus: 0 = finished, 1 = upcoming, anything else = in-play.
  const finished = fmatches.filter((m) => m.MatchStatus === 0);
  const inPlay = fmatches.filter((m) => m.MatchStatus !== 0 && m.MatchStatus !== 1);
  const extract = (tl) => {
    const cards = {}, goals = [];
    for (const e of (tl.Event || tl.Events || [])) {
      const team = id2name[e.IdTeam];
      if (!team) continue;
      if (e.Type === 2) { (cards[team] ??= { y: 0, r: 0 }).y++; }
      else if (e.Type === 3) { (cards[team] ??= { y: 0, r: 0 }).r++; }
      else if (e.Type === 0) {
        const g = { team, min: parseMin(e.MatchMinute), mm: e.MatchMinute };
        if (e.PositionX != null && e.PositionY != null) g.dist = +goalDist(e.PositionX, e.PositionY).toFixed(1);
        goals.push(g);
      }
    }
    return { cards, goals };
  };
  const tlUrl = (m) => `https://api.fifa.com/api/v3/timelines/${FIFA_COMP}/${FIFA_SEASON}/${m.IdStage}/${m.IdMatch}?language=en`;
  // Cache finished matches permanently; always refetch in-play matches.
  const todo = finished.filter((m) => !fifaCache[m.IdMatch]);
  await pool(todo, 6, async (m) => { fifaCache[m.IdMatch] = extract(await fifaJson(tlUrl(m))); });
  const liveEvents = {};
  await pool(inPlay, 6, async (m) => { liveEvents[m.IdMatch] = extract(await fifaJson(tlUrl(m))); });

  // Aggregate cards (cached finished + live) into team totals.
  for (const n of NAMES) { results[n].yc = 0; results[n].rc = 0; }
  const allEvents = [...Object.values(fifaCache), ...Object.values(liveEvents)];
  for (const ev of allEvents) {
    for (const [team, c] of Object.entries(ev.cards || {})) {
      if (results[team]) { results[team].yc += c.y; results[team].rc += c.r; }
    }
  }
  // Fastest goal (lowest minute) and furthest goal (greatest shot distance).
  for (const ev of allEvents) {
    for (const g of ev.goals || []) {
      if (!fifaFastest || g.min < fifaFastest.min) fifaFastest = g;
      if (g.dist != null && (!fifaFurthest || g.dist > fifaFurthest.dist)) fifaFurthest = g;
    }
  }
  console.log(`FIFA events: ${Object.keys(fifaCache).length} finished cached, ${inPlay.length} in-play; ` +
    `fastest=${fifaFastest?.team} ${fifaFastest?.mm}, furthest=${fifaFurthest?.team} ${fifaFurthest?.dist}m`);
} catch (e) {
  console.error("FIFA events unavailable:", e.message);
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

// Auto-fill Fastest Goal (earliest goal of the tournament) from FIFA events.
if (manual.fastestGoal == null && fifaFastest) {
  const idx = NAMES.indexOf(fifaFastest.team);
  if (idx >= 0) manual.fastestGoal = idx;
}

// Auto-fill Furthest Goal (longest-distance goal) from FIFA events.
if (manual.furthestGoal == null && fifaFurthest) {
  const idx = NAMES.indexOf(fifaFurthest.team);
  if (idx >= 0) manual.furthestGoal = idx;
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

// Extra prize detail for the UI (goal minute / shot distance), when known.
const prizeInfo = {
  fastestGoal: fifaFastest ? { team: fifaFastest.team, mm: fifaFastest.mm } : null,
  furthestGoal: fifaFurthest ? { team: fifaFurthest.team, dist: fifaFurthest.dist } : null,
};

const payload = { live, source, results, manual, fixtures, groups, topScorer, prizeInfo, fifaCache };
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
