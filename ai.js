// OpenAI integration: model auto-detection + vision analysis for
// nutrition labels, meal photos, and text descriptions.

const OPENAI_BASE = "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY || "";

let detectedModel = null;
let detectError = null;

// Rank available models: strongest vision-capable first. Never a mini/nano.
function rankModels(ids) {
  const bad = /mini|nano|audio|realtime|search|transcribe|tts|image|instruct|embed|moderation|davinci|babbage|whisper|codex/i;
  const candidates = ids.filter((id) => !bad.test(id));
  const tiers = [
    /^gpt-5\.\d+(-chat-latest)?$/, //  gpt-5.1, gpt-5.2 ...
    /^gpt-5\.\d+-\d{4}-\d{2}-\d{2}$/,
    /^gpt-5(-chat-latest)?$/,
    /^gpt-5-\d{4}-\d{2}-\d{2}$/,
    /^chatgpt-4o-latest$/,
    /^gpt-4\.1$/,
    /^gpt-4\.1-\d{4}-\d{2}-\d{2}$/,
    /^gpt-4o$/,
    /^gpt-4o-\d{4}-\d{2}-\d{2}$/,
  ];
  for (const re of tiers) {
    const matches = candidates.filter((id) => re.test(id)).sort().reverse();
    if (matches.length) return matches[0];
  }
  return null;
}

export async function detectModel() {
  if (process.env.OPENAI_MODEL) {
    detectedModel = process.env.OPENAI_MODEL;
    return detectedModel;
  }
  if (!KEY) { detectError = "No OPENAI_API_KEY configured"; return null; }
  try {
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) throw new Error(`models list HTTP ${r.status}`);
    const data = await r.json();
    const ids = (data.data || []).map((m) => m.id);
    detectedModel = rankModels(ids);
    if (!detectedModel) detectError = "No suitable vision model found on this key";
    else console.log(`[ai] using model: ${detectedModel}`);
    return detectedModel;
  } catch (e) {
    detectError = e.message;
    console.error("[ai] model detection failed:", e.message);
    return null;
  }
}

export function aiStatus() {
  return { configured: !!KEY, model: detectedModel, error: detectError };
}

// Chat completion with vision, defensive across model generations:
// newer models want max_completion_tokens and default temperature only.
async function chat(messages, { maxTokens = 1600 } = {}) {
  if (!KEY) throw new Error("OpenAI API key not configured");
  const model = detectedModel || (await detectModel());
  if (!model) throw new Error(detectError || "No model available");

  const attempt = async (tokenParam) => {
    const body = { model, messages, [tokenParam]: maxTokens };
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`OpenAI HTTP ${r.status}: ${text.slice(0, 300)}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return JSON.parse(text);
  };

  let resp;
  try {
    resp = await attempt("max_completion_tokens");
  } catch (e) {
    if (e.status === 400 && /max_completion_tokens/.test(e.body || "")) {
      resp = await attempt("max_tokens");
    } else throw e;
  }
  const content = resp.choices?.[0]?.message?.content || "";
  return content;
}

// Extract the first JSON object from a model reply (handles code fences).
function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error("No JSON in AI response");
  // walk to matching close brace
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "{") depth++;
    else if (t[i] === "}") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("Unbalanced JSON in AI response");
}

const ITEM_SCHEMA = `Each item: {"name": string, "serving_desc": string (e.g. "1 cup (250g)"), "quantity": number, "calories": number (kcal), "protein_g": number, "carbs_g": number, "fat_g": number}`;

const RULES = `Rules:
- ALL energy values in kilocalories (kcal). If the label shows kilojoules (kJ), convert: kcal = kJ / 4.184. Australian labels usually show kJ — always convert.
- Numbers are for the stated quantity of that item (not per 100g), realistic and internally consistent (protein*4 + carbs*4 + fat*9 should be within ~15% of calories).
- Reply with ONLY a JSON object, no prose, no markdown.`;

export async function analyzeLabel(imageDataUrl, note) {
  const content = [
    { type: "text", text:
`You are a precise nutrition-label reader. Read this nutrition label photo carefully.
${note ? `User note: ${note}` : ""}
Return JSON: {"items":[...], "confidence": "high"|"medium"|"low", "notes": string}
Exactly one item representing ONE serving as stated on the label (put the serving size in serving_desc). If the label only shows per-100g, use per-100g and say so in serving_desc. Include the product name if visible on packaging.
${ITEM_SCHEMA}
${RULES}` },
    { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
  ];
  const raw = await chat([{ role: "user", content }]);
  return parseJson(raw);
}

export async function analyzeMeal(imageDataUrl, description) {
  const content = [
    { type: "text", text:
`You are an expert nutritionist estimating a meal from a photo${description ? " and the user's own description of what they used/ate — trust the description over the photo where they conflict, it is first-hand" : ""}.
${description ? `User's description: "${description}"` : ""}
Identify every distinct food item and estimate its portion from visual cues (plate size, utensils, packaging).
Return JSON: {"items":[...], "confidence": "high"|"medium"|"low", "notes": string (one short sentence on how you estimated portions)}
${ITEM_SCHEMA}
${RULES}` },
    { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
  ];
  const raw = await chat([{ role: "user", content }], { maxTokens: 2000 });
  return parseJson(raw);
}

export async function analyzeText(description) {
  const raw = await chat([
    { role: "user", content:
`You are an expert nutritionist. The user describes what they ate; estimate the nutrition.
Description: "${description}"
Assume common Australian portion sizes when the user doesn't specify amounts.
Return JSON: {"items":[...], "confidence": "high"|"medium"|"low", "notes": string}
${ITEM_SCHEMA}
${RULES}` },
  ], { maxTokens: 2000 });
  return parseJson(raw);
}
