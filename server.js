import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, migrate } from "./db.js";
import { detectModel, aiStatus, analyzeLabel, analyzeMeal, analyzeText } from "./ai.js";
import { searchFoods, lookupBarcode } from "./food.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16mb" })); // photos arrive as base64 data URLs
app.use(cookieParser());

const PROD = process.env.NODE_ENV !== "development";
const SESSION_DAYS = 180;
const COOKIE = "macro_session";

// ---------- auth helpers ----------
function cookieOpts() {
  return { httpOnly: true, secure: PROD, sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" };
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expires.toISOString()})`;
  res.cookie(COOKIE, token, cookieOpts());
}

async function auth(req, res, next) {
  try {
    const token = req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const rows = await sql`SELECT user_id FROM sessions WHERE token = ${token} AND expires_at > now()`;
    if (!rows.length) return res.status(401).json({ error: "Session expired" });
    req.userId = rows[0].user_id;
    next();
  } catch (e) { next(e); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function reqDate(req, res) {
  const d = req.query.date || req.body?.entry_date;
  if (!d || !DATE_RE.test(d)) { res.status(400).json({ error: "date required (YYYY-MM-DD)" }); return null; }
  return d;
}

// ---------- auth routes ----------
app.get("/api/auth/state", async (req, res, next) => {
  try {
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
    let user = null;
    const token = req.cookies[COOKIE];
    if (token) {
      const rows = await sql`SELECT u.id, u.username, p.onboarded FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN profiles p ON p.user_id = u.id WHERE s.token = ${token} AND s.expires_at > now()`;
      if (rows.length) user = { id: rows[0].id, username: rows[0].username, onboarded: !!rows[0].onboarded };
    }
    res.json({ hasAccount: count > 0, user });
  } catch (e) { next(e); }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
    if (count > 0) return res.status(403).json({ error: "This app already has its owner — sign in instead" });
    const { username, password } = req.body || {};
    if (!username || !/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return res.status(400).json({ error: "Username: 2–32 letters, numbers, . _ -" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await bcrypt.hash(password, 12);
    const [user] = await sql`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash}) RETURNING id, username`;
    await sql`INSERT INTO profiles (user_id) VALUES (${user.id})`;
    await createSession(res, user.id);
    res.json({ user: { id: user.id, username: user.username, onboarded: false } });
  } catch (e) { next(e); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const rows = await sql`SELECT u.*, p.onboarded FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.username = ${username || ""}`;
    if (!rows.length || !(await bcrypt.compare(password || "", rows[0].password_hash)))
      return res.status(401).json({ error: "Wrong username or password" });
    await createSession(res, rows[0].id);
    res.json({ user: { id: rows[0].id, username: rows[0].username, onboarded: !!rows[0].onboarded } });
  } catch (e) { next(e); }
});

app.post("/api/auth/logout", auth, async (req, res, next) => {
  try {
    await sql`DELETE FROM sessions WHERE token = ${req.cookies[COOKIE]}`;
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post("/api/auth/password", auth, async (req, res, next) => {
  try {
    const { current, next: newPw } = req.body || {};
    const [u] = await sql`SELECT password_hash FROM users WHERE id = ${req.userId}`;
    if (!(await bcrypt.compare(current || "", u.password_hash))) return res.status(401).json({ error: "Current password is wrong" });
    if (!newPw || newPw.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(newPw, 12)} WHERE id = ${req.userId}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- profile & goals ----------
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };

function calcGoals(p) {
  const age = Math.floor((Date.now() - new Date(p.birth_date).getTime()) / (365.25 * 864e5));
  const bmr = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * age + (p.sex === "male" ? 5 : -161);
  const tdee = bmr * (ACTIVITY[p.activity_level] || 1.55);
  const rate = Number(p.goal_rate_kg_per_week) || 0; // kg/week; + gain, - loss
  const delta = (rate * 7700) / 7;
  const calories = Math.round(tdee + (p.goal_type === "cut" ? -Math.abs(delta) : p.goal_type === "bulk" ? Math.abs(delta) : 0));
  const proteinPerKg = p.goal_type === "cut" ? 2.0 : 1.8;
  const protein = Math.round(proteinPerKg * p.weight_kg);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  return { tdee: Math.round(tdee), bmr: Math.round(bmr), calorie_goal: calories, protein_goal_g: protein, fat_goal_g: fat, carbs_goal_g: Math.max(carbs, 0), age };
}

app.get("/api/profile", auth, async (req, res, next) => {
  try {
    const [p] = await sql`SELECT * FROM profiles WHERE user_id = ${req.userId}`;
    res.json({ profile: p || null });
  } catch (e) { next(e); }
});

app.post("/api/profile/calculate", auth, (req, res) => {
  const { sex, birth_date, height_cm, weight_kg, activity_level, goal_type, goal_rate_kg_per_week } = req.body || {};
  if (!sex || !birth_date || !height_cm || !weight_kg || !activity_level || !goal_type)
    return res.status(400).json({ error: "Missing fields" });
  res.json(calcGoals({ sex, birth_date, height_cm: +height_cm, weight_kg: +weight_kg, activity_level, goal_type, goal_rate_kg_per_week }));
});

app.put("/api/profile", auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const [p] = await sql`
      UPDATE profiles SET
        sex = COALESCE(${b.sex ?? null}, sex),
        birth_date = COALESCE(${b.birth_date ?? null}, birth_date),
        height_cm = COALESCE(${b.height_cm ?? null}, height_cm),
        weight_kg = COALESCE(${b.weight_kg ?? null}, weight_kg),
        activity_level = COALESCE(${b.activity_level ?? null}, activity_level),
        goal_type = COALESCE(${b.goal_type ?? null}, goal_type),
        goal_rate_kg_per_week = COALESCE(${b.goal_rate_kg_per_week ?? null}, goal_rate_kg_per_week),
        calorie_goal = COALESCE(${b.calorie_goal ?? null}, calorie_goal),
        protein_goal_g = COALESCE(${b.protein_goal_g ?? null}, protein_goal_g),
        carbs_goal_g = COALESCE(${b.carbs_goal_g ?? null}, carbs_goal_g),
        fat_goal_g = COALESCE(${b.fat_goal_g ?? null}, fat_goal_g),
        onboarded = COALESCE(${b.onboarded ?? null}, onboarded),
        updated_at = now()
      WHERE user_id = ${req.userId} RETURNING *`;
    // Onboarding with a starting weight also seeds the weight log
    if (b.weight_kg && b.log_weight_date && DATE_RE.test(b.log_weight_date)) {
      await sql`INSERT INTO weight_log (user_id, log_date, weight_kg) VALUES (${req.userId}, ${b.log_weight_date}, ${b.weight_kg})
                ON CONFLICT (user_id, log_date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg`;
    }
    res.json({ profile: p });
  } catch (e) { next(e); }
});

// ---------- food search ----------
app.get("/api/search", auth, async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json({ results: [], errors: [] });
    res.json(await searchFoods(q));
  } catch (e) { next(e); }
});

app.get("/api/barcode/:code", auth, async (req, res, next) => {
  try {
    const product = await lookupBarcode(req.params.code);
    if (!product) return res.status(404).json({ error: "Product not found in Open Food Facts" });
    res.json({ product });
  } catch (e) { next(e); }
});

// ---------- AI ----------
app.get("/api/ai/status", auth, (req, res) => res.json(aiStatus()));

function validItems(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .filter((i) => i && i.name && Number.isFinite(+i.calories))
    .map((i) => ({
      name: String(i.name).slice(0, 200),
      serving_desc: String(i.serving_desc || "").slice(0, 120),
      quantity: Number.isFinite(+i.quantity) && +i.quantity > 0 ? +i.quantity : 1,
      calories: Math.max(0, +i.calories),
      protein_g: Math.max(0, +i.protein_g || 0),
      carbs_g: Math.max(0, +i.carbs_g || 0),
      fat_g: Math.max(0, +i.fat_g || 0),
    }));
}

async function aiRoute(res, fn) {
  try {
    const parsed = await fn();
    const items = validItems(parsed);
    if (!items.length) return res.status(422).json({ error: "The AI couldn't find nutrition info in that — try a clearer photo or add a description", notes: parsed?.notes });
    res.json({ items, confidence: parsed.confidence || "medium", notes: parsed.notes || "" });
  } catch (e) {
    console.error("[ai]", e.message);
    res.status(502).json({ error: `AI analysis failed: ${e.message.slice(0, 200)}` });
  }
}

app.post("/api/ai/label", auth, (req, res) => {
  const { image, note } = req.body || {};
  if (!image?.startsWith("data:image/")) return res.status(400).json({ error: "image (data URL) required" });
  aiRoute(res, () => analyzeLabel(image, note));
});

app.post("/api/ai/meal", auth, (req, res) => {
  const { image, description } = req.body || {};
  if (!image?.startsWith("data:image/")) return res.status(400).json({ error: "image (data URL) required" });
  aiRoute(res, () => analyzeMeal(image, description));
});

app.post("/api/ai/describe", auth, (req, res) => {
  const { description } = req.body || {};
  if (!description?.trim()) return res.status(400).json({ error: "description required" });
  aiRoute(res, () => analyzeText(description.trim()));
});

// ---------- entries ----------
const MEALS = ["breakfast", "lunch", "dinner", "snack"];

app.get("/api/entries", auth, async (req, res, next) => {
  try {
    const date = reqDate(req, res); if (!date) return;
    const entries = await sql`SELECT * FROM entries WHERE user_id = ${req.userId} AND entry_date = ${date} ORDER BY created_at`;
    res.json({ entries });
  } catch (e) { next(e); }
});

app.post("/api/entries", auth, async (req, res, next) => {
  try {
    const { entry_date, meal_type, items } = req.body || {};
    if (!DATE_RE.test(entry_date || "")) return res.status(400).json({ error: "entry_date required" });
    if (!MEALS.includes(meal_type)) return res.status(400).json({ error: "meal_type must be breakfast/lunch/dinner/snack" });
    const list = Array.isArray(items) ? items : [items];
    const saved = [];
    for (const i of list) {
      if (!i?.name || !Number.isFinite(+i.calories)) continue;
      const [row] = await sql`INSERT INTO entries (user_id, entry_date, meal_type, name, brand, serving_desc, quantity, calories, protein_g, carbs_g, fat_g, source)
        VALUES (${req.userId}, ${entry_date}, ${meal_type}, ${String(i.name).slice(0, 200)}, ${i.brand || null}, ${i.serving_desc || null},
                ${+i.quantity > 0 ? +i.quantity : 1}, ${+i.calories}, ${+i.protein_g || 0}, ${+i.carbs_g || 0}, ${+i.fat_g || 0}, ${i.source || "manual"})
        RETURNING *`;
      saved.push(row);
    }
    if (!saved.length) return res.status(400).json({ error: "No valid items to save" });
    res.json({ entries: saved });
  } catch (e) { next(e); }
});

app.put("/api/entries/:id", auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const [row] = await sql`UPDATE entries SET
        name = COALESCE(${b.name ?? null}, name),
        meal_type = COALESCE(${b.meal_type ?? null}, meal_type),
        serving_desc = COALESCE(${b.serving_desc ?? null}, serving_desc),
        quantity = COALESCE(${b.quantity ?? null}, quantity),
        calories = COALESCE(${b.calories ?? null}, calories),
        protein_g = COALESCE(${b.protein_g ?? null}, protein_g),
        carbs_g = COALESCE(${b.carbs_g ?? null}, carbs_g),
        fat_g = COALESCE(${b.fat_g ?? null}, fat_g)
      WHERE id = ${+req.params.id} AND user_id = ${req.userId} RETURNING *`;
    if (!row) return res.status(404).json({ error: "Entry not found" });
    res.json({ entry: row });
  } catch (e) { next(e); }
});

app.delete("/api/entries/:id", auth, async (req, res, next) => {
  try {
    await sql`DELETE FROM entries WHERE id = ${+req.params.id} AND user_id = ${req.userId}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- summary & history ----------
app.get("/api/summary", auth, async (req, res, next) => {
  try {
    const date = reqDate(req, res); if (!date) return;
    const [totals] = await sql`SELECT COALESCE(SUM(calories),0)::float AS calories, COALESCE(SUM(protein_g),0)::float AS protein_g,
      COALESCE(SUM(carbs_g),0)::float AS carbs_g, COALESCE(SUM(fat_g),0)::float AS fat_g
      FROM entries WHERE user_id = ${req.userId} AND entry_date = ${date}`;
    const byMeal = await sql`SELECT meal_type, COALESCE(SUM(calories),0)::float AS calories, count(*)::int AS items
      FROM entries WHERE user_id = ${req.userId} AND entry_date = ${date} GROUP BY meal_type`;
    const [p] = await sql`SELECT calorie_goal, protein_goal_g, carbs_goal_g, fat_goal_g FROM profiles WHERE user_id = ${req.userId}`;
    res.json({ totals, byMeal, goals: p });
  } catch (e) { next(e); }
});

app.get("/api/history", auth, async (req, res, next) => {
  try {
    const days = Math.min(+req.query.days || 30, 365);
    const end = req.query.end && DATE_RE.test(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
    const rows = await sql`SELECT entry_date::text AS date, COALESCE(SUM(calories),0)::float AS calories,
        COALESCE(SUM(protein_g),0)::float AS protein_g, COALESCE(SUM(carbs_g),0)::float AS carbs_g,
        COALESCE(SUM(fat_g),0)::float AS fat_g, count(*)::int AS items
      FROM entries WHERE user_id = ${req.userId} AND entry_date > ${end}::date - ${days} AND entry_date <= ${end}
      GROUP BY entry_date ORDER BY entry_date DESC`;
    const [p] = await sql`SELECT calorie_goal FROM profiles WHERE user_id = ${req.userId}`;
    res.json({ days: rows, calorie_goal: p?.calorie_goal || null });
  } catch (e) { next(e); }
});

// ---------- quick add: recents & saved meals ----------
app.get("/api/recent", auth, async (req, res, next) => {
  try {
    const rows = await sql`SELECT DISTINCT ON (lower(name)) name, brand, serving_desc, quantity, calories, protein_g, carbs_g, fat_g, max(created_at) OVER (PARTITION BY lower(name)) AS last_used
      FROM entries WHERE user_id = ${req.userId} ORDER BY lower(name), created_at DESC`;
    rows.sort((a, b) => new Date(b.last_used) - new Date(a.last_used));
    res.json({ recent: rows.slice(0, 20) });
  } catch (e) { next(e); }
});

app.get("/api/meals", auth, async (req, res, next) => {
  try {
    const meals = await sql`SELECT * FROM saved_meals WHERE user_id = ${req.userId} ORDER BY use_count DESC, last_used_at DESC NULLS LAST`;
    res.json({ meals });
  } catch (e) { next(e); }
});

app.post("/api/meals", auth, async (req, res, next) => {
  try {
    const { name, items } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "Give the meal a name" });
    const list = (Array.isArray(items) ? items : []).filter((i) => i?.name && Number.isFinite(+i.calories));
    if (!list.length) return res.status(400).json({ error: "A saved meal needs at least one item" });
    const sum = (k) => list.reduce((a, i) => a + (+i[k] || 0), 0); // item values are already totals
    const [meal] = await sql`INSERT INTO saved_meals (user_id, name, items, calories, protein_g, carbs_g, fat_g)
      VALUES (${req.userId}, ${name.trim().slice(0, 100)}, ${JSON.stringify(list)}, ${sum("calories")}, ${sum("protein_g")}, ${sum("carbs_g")}, ${sum("fat_g")}) RETURNING *`;
    res.json({ meal });
  } catch (e) { next(e); }
});

app.post("/api/meals/:id/log", auth, async (req, res, next) => {
  try {
    const { entry_date, meal_type } = req.body || {};
    if (!DATE_RE.test(entry_date || "") || !MEALS.includes(meal_type)) return res.status(400).json({ error: "entry_date and meal_type required" });
    const [meal] = await sql`SELECT * FROM saved_meals WHERE id = ${+req.params.id} AND user_id = ${req.userId}`;
    if (!meal) return res.status(404).json({ error: "Saved meal not found" });
    const saved = [];
    for (const i of meal.items) {
      const [row] = await sql`INSERT INTO entries (user_id, entry_date, meal_type, name, serving_desc, quantity, calories, protein_g, carbs_g, fat_g, source)
        VALUES (${req.userId}, ${entry_date}, ${meal_type}, ${i.name}, ${i.serving_desc || null}, ${+i.quantity > 0 ? +i.quantity : 1},
                ${+i.calories}, ${+i.protein_g || 0}, ${+i.carbs_g || 0}, ${+i.fat_g || 0}, 'saved_meal') RETURNING *`;
      saved.push(row);
    }
    await sql`UPDATE saved_meals SET use_count = use_count + 1, last_used_at = now() WHERE id = ${meal.id}`;
    res.json({ entries: saved });
  } catch (e) { next(e); }
});

app.delete("/api/meals/:id", auth, async (req, res, next) => {
  try {
    await sql`DELETE FROM saved_meals WHERE id = ${+req.params.id} AND user_id = ${req.userId}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- weight ----------
app.get("/api/weight", auth, async (req, res, next) => {
  try {
    const days = Math.min(+req.query.days || 90, 730);
    const rows = await sql`SELECT log_date::text AS date, weight_kg::float FROM weight_log
      WHERE user_id = ${req.userId} AND log_date > CURRENT_DATE - ${days} ORDER BY log_date`;
    res.json({ weights: rows });
  } catch (e) { next(e); }
});

app.post("/api/weight", auth, async (req, res, next) => {
  try {
    const { date, weight_kg } = req.body || {};
    if (!DATE_RE.test(date || "") || !(+weight_kg > 20 && +weight_kg < 400)) return res.status(400).json({ error: "Valid date and weight (kg) required" });
    const [row] = await sql`INSERT INTO weight_log (user_id, log_date, weight_kg) VALUES (${req.userId}, ${date}, ${+weight_kg})
      ON CONFLICT (user_id, log_date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg RETURNING log_date::text AS date, weight_kg::float`;
    await sql`UPDATE profiles SET weight_kg = ${+weight_kg}, updated_at = now() WHERE user_id = ${req.userId}`;
    res.json({ weight: row });
  } catch (e) { next(e); }
});

app.delete("/api/weight/:date", auth, async (req, res, next) => {
  try {
    await sql`DELETE FROM weight_log WHERE user_id = ${req.userId} AND log_date = ${req.params.date}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- static ----------
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: "index.html" }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const PORT = process.env.PORT || 3000;
migrate()
  .then(() => detectModel().catch(() => {}))
  .then(() => app.listen(PORT, () => console.log(`Macro listening on :${PORT}`)))
  .catch((e) => { console.error("Boot failed:", e); process.exit(1); });

// housekeeping: purge expired sessions daily
setInterval(() => sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {}), 864e5).unref();
