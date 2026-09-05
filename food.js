// Live food search: built-in staples + USDA FoodData Central (whole foods)
// + Open Food Facts (branded/packaged), merged. Barcode lookup via OFF.
import { BUILTIN_FOODS } from "./foods-builtin.js";

const USDA_KEY = process.env.USDA_API_KEY || "DEMO_KEY";
const TIMEOUT_MS = 5000;

function fetchTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

function searchBuiltin(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return BUILTIN_FOODS
    .map((f) => {
      const hay = f.name.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (!hay.includes(t)) return null;
        score += hay.startsWith(t) ? 3 : 1;
      }
      return { ...f, source: "common", score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ score, ...f }) => f);
}

async function searchUSDA(q) {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}&query=${encodeURIComponent(q)}&dataType=Foundation,SR%20Legacy&pageSize=8`;
  const r = await fetchTimeout(url);
  if (!r.ok) throw new Error(`USDA HTTP ${r.status}`);
  const data = await r.json();
  return (data.foods || []).map((f) => {
    const nut = {};
    for (const n of f.foodNutrients || []) {
      nut[n.nutrientNumber || n.nutrientId] = n.value;
    }
    return {
      name: titleCase(f.description || ""),
      brand: null,
      source: "usda",
      serving_desc: "100g",
      calories: round1(nut["208"]),
      protein_g: round1(nut["203"]),
      carbs_g: round1(nut["205"]),
      fat_g: round1(nut["204"]),
    };
  }).filter((f) => f.calories > 0 || f.protein_g > 0);
}

async function searchOFF(q) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,brands,nutriments,serving_size,code&sort_by=unique_scans_n`;
  const r = await fetchTimeout(url, { headers: { "User-Agent": "MacroPWA/1.0 (personal use)" } });
  if (!r.ok) throw new Error(`OFF HTTP ${r.status}`);
  const data = await r.json();
  return (data.products || []).map(mapOFFProduct).filter(Boolean);
}

function mapOFFProduct(p) {
  const n = p.nutriments || {};
  const name = (p.product_name || "").trim();
  if (!name) return null;
  // Prefer per-serving when present, else per-100g
  let per = "100g", cal = n["energy-kcal_100g"], pro = n.proteins_100g, carb = n.carbohydrates_100g, fat = n.fat_100g;
  if (n["energy-kcal_serving"] != null && p.serving_size) {
    per = p.serving_size;
    cal = n["energy-kcal_serving"]; pro = n.proteins_serving; carb = n.carbohydrates_serving; fat = n.fat_serving;
  }
  if (cal == null && n.energy_100g != null) cal = n.energy_100g / 4.184; // kJ fallback
  if (cal == null) return null;
  return {
    name,
    brand: (p.brands || "").split(",")[0].trim() || null,
    source: "off",
    serving_desc: per,
    calories: round1(cal),
    protein_g: round1(pro),
    carbs_g: round1(carb),
    fat_g: round1(fat),
    barcode: p.code || null,
  };
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s,(])\w/g, (c) => c.toUpperCase());
}

export async function searchFoods(q) {
  const [usda, off] = await Promise.allSettled([searchUSDA(q), searchOFF(q)]);
  const errors = [];
  if (usda.status === "rejected") errors.push(`USDA: ${usda.reason.message}`);
  if (off.status === "rejected") errors.push(`OpenFoodFacts: ${off.reason.message}`);
  return {
    results: [
      ...searchBuiltin(q),
      ...(usda.status === "fulfilled" ? usda.value : []),
      ...(off.status === "fulfilled" ? off.value : []),
    ],
    errors,
  };
}

export async function lookupBarcode(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_size,code`;
  const r = await fetchTimeout(url, { headers: { "User-Agent": "MacroPWA/1.0 (personal use)" } });
  if (!r.ok) throw new Error(`Barcode lookup HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 1 || !data.product) return null;
  return mapOFFProduct(data.product);
}
