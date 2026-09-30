// ============================================================
// Edge Function « report-read » — agrégats du rapport quotidien.
// ------------------------------------------------------------
// Pour la tâche planifiée Claude (rapport de 6h) : même JETON DE LECTURE que
// meta-read (table meta_read_tokens, haché), en-tête `x-meta-token`.
//   GET ?date=AAAA-MM-JJ  → parties capturées ce jour-là (heure de Paris),
//                           agrégées par (utilisateur, héros, format).
// Ne renvoie QUE des agrégats (pseudo, héros, format, parties, victoires) :
// jamais le log brut ni les parties elles-mêmes.
//
// Victoire : lue dans le bloc END GAME STATS du log (winner vs myPlayerID),
// même règle que talishar-parser.js. Sans ce bloc (partie non terminée) →
// comptée dans `unknown`, exclue du winrate.
//
// ⚠️ « Enforce JWT verification » désactivé : l'authentification, c'est le jeton.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = "Europe/Paris";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Minuit (heure de Paris) du jour donné, en instant UTC (UTC+1 ou UTC+2).
function parisMidnight(date: string): Date {
  for (const h of [22, 23]) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCHours(d.getUTCHours() - 24 + h);
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d);
    if (hour === "00") return d;
  }
  return new Date(`${date}T00:00:00Z`);
}

// true = victoire, false = défaite, null = inconnu (pas de stats de fin).
export function gameWon(raw: string): boolean | null {
  const marker = "=== END GAME STATS (Talishar";
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;
  const nl = raw.indexOf("\n", idx);
  const line = raw.slice(nl + 1).trim().split("\n")[0];
  try {
    const p = JSON.parse(line);
    if (!p || !p.byPlayer) return null;
    const myId = p.myPlayerID || Object.keys(p.byPlayer)[0];
    const d = p.byPlayer[myId];
    if (!d) return null;
    if (d.winner != null) return Number(d.winner) === Number(myId);
    if (d.result != null) return d.result === 1;
    return null;
  } catch (_) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const token = req.headers.get("x-meta-token") || "";
  if (token.length < 32) return json({ error: "missing token" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const hash = await sha256(token);
  const { data: tok, error: tokErr } = await admin
    .from("meta_read_tokens").select("token_hash").eq("token_hash", hash).maybeSingle();
  if (tokErr) return json({ error: "auth lookup failed" }, 500);
  if (!tok) return json({ error: "invalid token" }, 401);
  await admin.from("meta_read_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);

  const date = new URL(req.url).searchParams.get("date") || "";
  if (!DATE.test(date)) return json({ error: "date=AAAA-MM-JJ required" }, 400);
  const from = parisMidnight(date);
  const to = new Date(from.getTime() + 36 * 3600e3); // borne large, recoupée ci-dessous
  const next = parisMidnight(new Date(from.getTime() + 30 * 3600e3).toISOString().slice(0, 10));

  const { data: games, error } = await admin
    .from("games").select("user_id, my_hero, format, captured_at, raw")
    .gte("captured_at", from.toISOString()).lt("captured_at", to.toISOString());
  if (error) return json({ error: "games query failed" }, 500);

  const { data: profiles } = await admin.from("profiles").select("id, display_name");
  const names = new Map((profiles || []).map((p) => [p.id, p.display_name]));

  type Row = { user_id: string; name: string | null; hero: string; format: string;
    games: number; wins: number; losses: number; unknown: number };
  const agg = new Map<string, Row>();
  for (const g of games || []) {
    if (new Date(g.captured_at) >= next) continue;
    const key = `${g.user_id}|${g.my_hero}|${g.format}`;
    let a = agg.get(key);
    if (!a) {
      a = { user_id: g.user_id, name: names.get(g.user_id) || null, hero: g.my_hero, format: g.format,
        games: 0, wins: 0, losses: 0, unknown: 0 };
      agg.set(key, a);
    }
    const w = gameWon(g.raw || "");
    a.games++;
    if (w === true) a.wins++; else if (w === false) a.losses++; else a.unknown++;
  }
  return json({ date, tz: TZ, rows: [...agg.values()] });
});
