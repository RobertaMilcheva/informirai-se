// Пуска се от Vercel при всяко публикуване: прави public/config.js от настройките в Vercel
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const url = process.env.SUPABASE_URL || "";
const anon = process.env.SUPABASE_ANON_KEY || "";
if (!url || !anon) console.warn("⚠️  Липсват SUPABASE_URL / SUPABASE_ANON_KEY във Vercel");

writeFileSync("public/config.js",
  `window.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: anon })};\n`);
mkdirSync("public/data", { recursive: true });
copyFileSync("config/categories.json", "public/data/categories.json");
copyFileSync("config/sources.json", "public/data/sources.json");
console.log("config.js е готов");
