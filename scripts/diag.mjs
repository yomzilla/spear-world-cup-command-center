// One-off diagnostic: what does football-data.org actually return for match detail?
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMP = process.env.WC_COMP || "WC";

async function api(path) {
  const r = await fetch(`https://api.football-data.org/v4/${path}`, { headers: { "X-Auth-Token": TOKEN } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

if (!TOKEN) { console.log("NO TOKEN"); process.exit(0); }

const comp = await api(`competitions/${COMP}/matches`);
console.log("matches endpoint status:", comp.status);
const matches = comp.json?.matches || [];
console.log("total matches:", matches.length);

const finished = matches.filter((m) => m.status === "FINISHED");
console.log("finished matches:", finished.length);

// Inspect detail for up to 3 finished matches.
for (const m of finished.slice(0, 3)) {
  await new Promise((r) => setTimeout(r, 6500));
  const d = await api(`matches/${m.id}`);
  const j = d.json?.match || d.json || {};
  console.log("----------------------------------------");
  console.log(`match ${m.id}: ${m.homeTeam?.name} vs ${m.awayTeam?.name}  status=${d.status}`);
  console.log("score.fullTime:", JSON.stringify(j.score?.fullTime), "winner:", j.score?.winner);
  console.log("top-level keys:", Object.keys(j).join(", "));
  console.log("goals length:", Array.isArray(j.goals) ? j.goals.length : "n/a");
  console.log("bookings length:", Array.isArray(j.bookings) ? j.bookings.length : "n/a");
  console.log("substitutions length:", Array.isArray(j.substitutions) ? j.substitutions.length : "n/a");
  if (Array.isArray(j.goals) && j.goals.length) console.log("first goal:", JSON.stringify(j.goals[0]));
  if (Array.isArray(j.bookings) && j.bookings.length) console.log("first booking:", JSON.stringify(j.bookings[0]));
}

// Also check what plan/tier the token reports, if available.
const me = await api(`competitions`);
console.log("========================================");
console.log("competitions endpoint status:", me.status);
if (me.json?.count != null) console.log("competitions count visible:", me.json.count);
