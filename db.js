import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

export const sql = neon(process.env.DATABASE_URL);

// Ensure schema exists (idempotent — safe on every boot)
export async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS profiles (user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sex TEXT, birth_date DATE, height_cm NUMERIC, weight_kg NUMERIC, activity_level TEXT, goal_type TEXT, goal_rate_kg_per_week NUMERIC, calorie_goal INT, protein_goal_g INT, carbs_goal_g INT, fat_goal_g INT, onboarded BOOLEAN DEFAULT false, updated_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS entries (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, entry_date DATE NOT NULL, meal_type TEXT NOT NULL, name TEXT NOT NULL, brand TEXT, serving_desc TEXT, quantity NUMERIC DEFAULT 1, calories NUMERIC NOT NULL, protein_g NUMERIC DEFAULT 0, carbs_g NUMERIC DEFAULT 0, fat_g NUMERIC DEFAULT 0, source TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, entry_date)`;
  await sql`CREATE TABLE IF NOT EXISTS saved_meals (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, items JSONB NOT NULL DEFAULT '[]', calories NUMERIC NOT NULL, protein_g NUMERIC DEFAULT 0, carbs_g NUMERIC DEFAULT 0, fat_g NUMERIC DEFAULT 0, use_count INT DEFAULT 0, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS weight_log (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, log_date DATE NOT NULL, weight_kg NUMERIC NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, log_date))`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS water_log (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, log_date DATE NOT NULL, ml INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, log_date))`;
  await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS water_goal_ml INT DEFAULT 2500`;
  await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS goal_weight_kg NUMERIC`;
  await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT`;
}
