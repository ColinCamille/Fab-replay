// ============================================================
// Edge Function « game-read » — lecture SEULE des parties d'un joueur.
// ------------------------------------------------------------
// Pour les sessions Claude (skill fab-game-review) : évite execute_sql
// (qui peut écrire) et ses confirmations. Authentification par jeton
// (en-tête `x-read-token`) comparé au SHA-256 stocké dans game_read_tokens ;
// on ne renvoie QUE les parties du user_id associé au jeton.
//
//   GET ?game_id=2577664                 → log brut (text/plain)
//   GET ?hero=boltyn&opp=marlynn&limit=5 → liste JSON (plus récentes d'abord)
//
// Déploiement : verify_jwt = false (c'est le jeton qui authentifie).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Échappe les jokers LIKE (% _ \) d'un filtre utilisateur.
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const token = req.headers.get("x-read-token") || "";
  if (token.length < 32) return json({ error: "unauthorized" }, 401);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const hash = await sha256(token);
  const { data: tok } = await sb.from("game_read_tokens")
    .select("user_id").eq("token_hash", hash).maybeSingle();
  if (!tok) return json({ error: "unauthorized" }, 401);
  await sb.from("game_read_tokens")
    .update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);

  const url = new URL(req.url);
  const gameId = url.searchParams.get("game_id");

  if (gameId) {
    if (!/^\d+$/.test(gameId)) return json({ error: "invalid game_id" }, 400);
    const { data, error } = await sb.from("games").select("raw")
      .eq("user_id", tok.user_id).eq("game_id", gameId).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "not found" }, 404);
    return new Response(data.raw, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 50);
  let q = sb.from("games")
    .select("game_id, my_hero, opp_hero, format, captured_at")
    .eq("user_id", tok.user_id)
    .order("captured_at", { ascending: false })
    .limit(limit);
  const hero = url.searchParams.get("hero");
  const opp = url.searchParams.get("opp");
  if (hero) q = q.ilike("my_hero", `%${likeEsc(hero)}%`);
  if (opp) q = q.ilike("opp_hero", `%${likeEsc(opp)}%`);
  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json(data);
});
