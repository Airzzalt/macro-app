// End-to-end test against a running Macro server. Usage: node test/integration.mjs http://localhost:3210 [--ai]
const BASE = process.argv[2] || "http://localhost:3210";
const AI = process.argv.includes("--ai");
let cookie = "";
let pass = 0, fail = 0;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const user = `zz_test_${Date.now().toString(36)}`;
console.log(`\nMacro integration test → ${BASE} (user ${user})`);

// auth
let r = await call("GET", "/api/auth/config"); check("auth config", r.status === 200 && "inviteRequired" in r.data);
r = await call("POST", "/api/auth/register", { username: user, password: "test1234", invite: "" }); check("register", r.status === 200 && r.data.user?.username === user, JSON.stringify(r.data));
r = await call("POST", "/api/auth/register", { username: user, password: "test1234" }); check("duplicate username rejected", r.status === 409);
r = await call("GET", "/api/auth/state"); check("state shows user", r.data.user?.username === user && r.data.user.onboarded === false);

// onboarding
r = await call("POST", "/api/profile/calculate", { sex: "male", birth_date: "1998-05-05", height_cm: 178, weight_kg: 80, activity_level: "moderate", goal_type: "cut", goal_rate_kg_per_week: 0.5 });
check("calculate goals", r.status === 200 && r.data.calorie_goal > 1500 && r.data.calorie_goal < 2600 && r.data.protein_goal_g === 160, JSON.stringify(r.data));
const calc = r.data;
r = await call("PUT", "/api/profile", { sex: "male", birth_date: "1998-05-05", height_cm: 178, weight_kg: 80, activity_level: "moderate", goal_type: "cut", goal_rate_kg_per_week: 0.5, ...calc, onboarded: true, log_weight_date: today, display_name: "Tester", goal_weight_kg: 75 });
check("save profile", r.status === 200 && r.data.profile.onboarded === true && r.data.profile.display_name === "Tester", JSON.stringify(r.data).slice(0, 200));

// search
r = await call("GET", "/api/search?q=chicken%20breast"); check("search returns results", r.status === 200 && r.data.results.length >= 1, JSON.stringify(r.data).slice(0, 200));
const sources = new Set(r.data.results.map((x) => x.source)); console.log(`    sources: ${[...sources].join(", ")}${r.data.errors.length ? " | errors: " + r.data.errors.join("; ") : ""}`);
r = await call("GET", "/api/barcode/3017620422003"); check("barcode lookup (Nutella)", r.status === 200 && /nutella/i.test(r.data.product?.name || ""), JSON.stringify(r.data).slice(0, 150));

// entries
r = await call("POST", "/api/entries", { entry_date: today, meal_type: "breakfast", items: [{ name: "Oats", calories: 171, protein_g: 6, carbs_g: 30.6, fat_g: 3.1, serving_desc: "45g" }, { name: "Banana", calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 }] });
check("add 2 entries", r.status === 200 && r.data.entries.length === 2, JSON.stringify(r.data).slice(0, 200));
const entryId = r.data.entries?.[0]?.id;
r = await call("PUT", `/api/entries/${entryId}`, { calories: 200, meal_type: "lunch" }); check("edit entry", r.status === 200 && +r.data.entry.calories === 200 && r.data.entry.meal_type === "lunch");
r = await call("GET", `/api/summary?date=${today}`);
check("summary totals", r.status === 200 && Math.round(r.data.totals.calories) === 305 && r.data.goals.calorie_goal === calc.calorie_goal, JSON.stringify(r.data).slice(0, 200));
check("streak = 1", r.data.streak === 1, `streak=${r.data.streak}`);
check("water starts 0", r.data.water_ml === 0 && r.data.goals.water_goal_ml === 2500);

// water
r = await call("POST", "/api/water", { date: today, delta_ml: 250 }); check("water +250", r.data.ml === 250);
r = await call("POST", "/api/water", { date: today, delta_ml: 500 }); check("water +500", r.data.ml === 750);
r = await call("POST", "/api/water", { date: today, delta_ml: -1000 }); check("water floors at 0", r.data.ml === 0);

// history & week
r = await call("GET", "/api/history?days=30"); check("history lists today", r.status === 200 && r.data.days[0]?.date === today && Math.round(r.data.days[0].calories) === 305, JSON.stringify(r.data).slice(0, 200));
r = await call("GET", `/api/history?days=7&end=${today}`); check("history 7d with end", r.status === 200 && r.data.days.length === 1);

// saved meals & recents
r = await call("POST", "/api/meals", { name: "Test brekkie", items: [{ name: "Oats", calories: 171, protein_g: 6, carbs_g: 30.6, fat_g: 3.1 }, { name: "Banana", calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 }] });
check("save meal", r.status === 200 && Math.round(r.data.meal.calories) === 276, JSON.stringify(r.data).slice(0, 150));
const mealId = r.data.meal?.id;
r = await call("POST", `/api/meals/${mealId}/log`, { entry_date: today, meal_type: "dinner" }); check("log saved meal", r.status === 200 && r.data.entries.length === 2);
r = await call("GET", "/api/meals"); check("list meals (use_count 1)", r.data.meals[0]?.use_count === 1);
r = await call("GET", "/api/recent"); check("recent foods", r.data.recent.length === 2, JSON.stringify(r.data).slice(0, 150));
r = await call("GET", `/api/summary?date=${today}`); check("summary after meal log = 581", Math.round(r.data.totals.calories) === 581, `got ${r.data.totals.calories}`);

// weight
r = await call("GET", "/api/weight?days=30"); check("weight seeded from onboarding", r.data.weights.length === 1 && r.data.weights[0].weight_kg === 80);
r = await call("POST", "/api/weight", { date: today, weight_kg: 79.4 }); check("log weight (upsert)", r.data.weight.weight_kg === 79.4);
r = await call("GET", "/api/profile"); check("profile weight synced + goal weight", +r.data.profile.weight_kg === 79.4 && +r.data.profile.goal_weight_kg === 75);

// export
r = await call("GET", "/api/export.csv"); check("csv export", r.status === 200 && typeof r.data === "string" && r.data.split("\n").length === 5, String(r.data).slice(0, 100));

// entry delete
r = await call("DELETE", `/api/entries/${entryId}`); check("delete entry", r.status === 200);

// AI
r = await call("GET", "/api/ai/status"); check("ai status", r.status === 200 && r.data.configured, JSON.stringify(r.data)); console.log(`    model: ${r.data.model}`);
if (AI) {
  console.log("  … calling AI (describe)");
  r = await call("POST", "/api/ai/describe", { description: "2 slices of wholemeal toast with peanut butter and a flat white" });
  check("ai describe returns items", r.status === 200 && r.data.items.length >= 2, JSON.stringify(r.data).slice(0, 300));
  if (r.status === 200) {
    const tot = r.data.items.reduce((a, i) => a + i.calories, 0);
    console.log(`    items: ${r.data.items.map((i) => `${i.name} ${i.calories}kcal P${i.protein_g} C${i.carbs_g} F${i.fat_g}${i.warning ? " ⚠" : ""}`).join(" | ")}`);
    check("ai total plausible (350–800 kcal)", tot >= 350 && tot <= 800, `total ${tot}`);
    check("ai macros consistent (no warnings)", r.data.items.every((i) => !i.warning));
    console.log("  … calling AI (refine)");
    const r2 = await call("POST", "/api/ai/refine", { items: r.data.items, instruction: "make it 3 slices of toast and a large flat white" });
    check("ai refine works", r2.status === 200 && r2.data.items.length >= 2, JSON.stringify(r2.data).slice(0, 200));
    if (r2.status === 200) { const t2 = r2.data.items.reduce((a, i) => a + i.calories, 0); check("refined total went up", t2 > tot, `${tot} → ${t2}`); console.log(`    notes: ${r2.data.notes}`); }
  }
}

// account delete (cleans up everything)
r = await call("DELETE", "/api/auth/account", { password: "wrong" }); check("delete needs right password", r.status === 401);
r = await call("DELETE", "/api/auth/account", { password: "test1234" }); check("delete account", r.status === 200);
r = await call("POST", "/api/auth/login", { username: user, password: "test1234" }); check("deleted user cannot log in", r.status === 401);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
