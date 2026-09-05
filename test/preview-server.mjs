// Serves the real frontend with stubbed API responses so the UI can be screenshotted offline.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const d = (n) => { const x = new Date(today + "T12:00:00"); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
const goals = { calorie_goal: 2200, protein_goal_g: 170, carbs_goal_g: 230, fat_goal_g: 65, water_goal_ml: 2500, display_name: "Ayaan" };
const entries = [
  { id: 1, entry_date: today, meal_type: "breakfast", name: "Oats with banana", serving_desc: "1 bowl", quantity: 1, calories: 320, protein_g: 9, carbs_g: 58, fat_g: 6 },
  { id: 2, entry_date: today, meal_type: "breakfast", name: "Flat white", serving_desc: "regular (250ml)", quantity: 1, calories: 120, protein_g: 6.4, carbs_g: 9.3, fat_g: 6.5 },
  { id: 3, entry_date: today, meal_type: "lunch", name: "Chicken burrito bowl", brand: "Guzman y Gomez", serving_desc: "1 bowl", quantity: 1, calories: 640, protein_g: 42, carbs_g: 62, fat_g: 22 },
  { id: 4, entry_date: today, meal_type: "snack", name: "Protein bar", serving_desc: "1 bar (60g)", quantity: 1, calories: 214, protein_g: 20, carbs_g: 21, fat_g: 6 },
];
const totals = entries.reduce((a, e) => ({ calories: a.calories + e.calories, protein_g: a.protein_g + e.protein_g, carbs_g: a.carbs_g + e.carbs_g, fat_g: a.fat_g + e.fat_g }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
app.get("/api/auth/state", (q, r) => r.json({ hasAccount: true, user: q.query.out ? null : { id: 1, username: "ayaan", onboarded: !q.query.ob } }));
app.get("/api/auth/config", (q, r) => r.json({ inviteRequired: false }));
app.get("/api/summary", (q, r) => r.json({ totals, byMeal: [], goals, water_ml: 1250, streak: 6 }));
app.get("/api/entries", (q, r) => r.json({ entries: q.query.date === today ? entries : [] }));
app.get("/api/history", (q, r) => r.json({ calorie_goal: 2200, days: [0, 1, 2, 3, 4, 6, 7, 9].map((n) => ({ date: d(n), calories: n === 0 ? totals.calories : 1700 + ((n * 137) % 900), protein_g: 150, carbs_g: 200, fat_g: 60, items: 5 })) }));
app.get("/api/weight", (q, r) => r.json({ weights: [20, 16, 13, 9, 6, 3, 0].map((n) => ({ date: d(n), weight_kg: 82 - (20 - n) * 0.12 })) }));
app.get("/api/profile", (q, r) => r.json({ profile: { ...goals, goal_weight_kg: 76, weight_kg: 79.6, sex: "male", birth_date: "1998-05-05", height_cm: 178, activity_level: "moderate", goal_type: "cut", goal_rate_kg_per_week: 0.5 } }));
app.get("/api/meals", (q, r) => r.json({ meals: [{ id: 1, name: "My usual breakfast", calories: 440, protein_g: 15, carbs_g: 67, fat_g: 12, use_count: 12 }] }));
app.get("/api/recent", (q, r) => r.json({ recent: entries.slice(0, 3) }));
app.get("/api/ai/status", (q, r) => r.json({ configured: true, model: "gpt-5.5" }));
app.get("/api/search", (q, r) => r.json({ results: [{ name: "Chicken breast, grilled", serving_desc: "100g", calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, source: "common" }, { name: "Chicken Breast", brand: "Woolworths", serving_desc: "100g", calories: 120, protein_g: 24, carbs_g: 0, fat_g: 2, source: "off" }], errors: [] }));
app.post("/api/water", (q, r) => r.json({ ml: 1500 }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.listen(3999, () => console.log("preview on :3999"));
