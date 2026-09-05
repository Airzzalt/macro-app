// Vision tests: posts real images to /api/ai/label and /api/ai/meal. Usage: node test/ai-vision.mjs http://localhost:3210
import { readFileSync } from "node:fs";
const BASE = process.argv[2] || "http://localhost:3210";
let cookie = ""; let pass = 0, fail = 0;
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n} ${c ? "" : x}`); };
const dataUrl = (p) => "data:image/jpeg;base64," + readFileSync(p).toString("base64");
const user = `zz_vision_${Date.now().toString(36)}`;
await call("POST", "/api/auth/register", { username: user, password: "test1234" });
console.log("  … label scan (kJ label)");
let r = await call("POST", "/api/ai/label", { image: dataUrl("test/fixtures/label.jpg") });
check("label returns 200 + 1 item", r.status === 200 && r.data.items?.length >= 1, JSON.stringify(r.data).slice(0, 300));
if (r.status === 200) {
  const it = r.data.items[0];
  console.log(`    → ${it.name} | ${it.serving_desc} | ${it.calories} kcal P${it.protein_g} C${it.carbs_g} F${it.fat_g}${it.warning ? " ⚠ " + it.warning : ""}`);
  check("kJ converted to kcal (680kJ ≈ 163 kcal, ±8%)", Math.abs(it.calories - 163) <= 13, `got ${it.calories}`);
  check("macros read correctly", Math.abs(it.protein_g - 4.1) < 0.6 && Math.abs(it.fat_g - 5.6) < 0.6 && Math.abs(it.carbs_g - 24.8) < 1.5, `P${it.protein_g} C${it.carbs_g} F${it.fat_g}`);
}
console.log("  … label scan with note (2 serves)");
r = await call("POST", "/api/ai/label", { image: dataUrl("test/fixtures/label.jpg"), note: "I ate 2 serves" });
if (r.status === 200) { const it = r.data.items[0]; console.log(`    → ${it.serving_desc} | ${it.calories} kcal`); check("note applied (≈325 kcal or qty 2)", Math.abs(it.calories - 325) <= 30 || (it.quantity === 2 && Math.abs(it.calories - 163) <= 13), `got ${it.calories} qty ${it.quantity}`); }
else check("label with note", false, JSON.stringify(r.data).slice(0, 200));
console.log("  … meal photo + description");
r = await call("POST", "/api/ai/meal", { image: dataUrl("test/fixtures/meal.jpg"), description: "2 boiled eggs, 1 slice of wholemeal toast with butter, and a handful of spinach" });
check("meal returns items", r.status === 200 && r.data.items?.length >= 2, JSON.stringify(r.data).slice(0, 300));
if (r.status === 200) {
  const tot = r.data.items.reduce((a, i) => a + i.calories, 0);
  console.log(`    → ${r.data.items.map((i) => `${i.name} ${i.calories}`).join(" | ")} = ${tot} kcal (${r.data.confidence}) ${r.data.notes}`);
  check("meal total plausible (220–420 kcal)", tot >= 220 && tot <= 420, `got ${tot}`);
}
await call("DELETE", "/api/auth/account", { password: "test1234" });
console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
