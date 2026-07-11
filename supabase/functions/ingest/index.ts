// ============================================================
// Edge Function « ingest » — réception des parties du grabber.
// ------------------------------------------------------------
// Le grabber (sur talishar.net) POSTe ici la partie capturée, avec
// un CODE D'APPAIRAGE (device_token) au lieu d'un login. La fonction
// valide ce code contre la table device_tokens (via la clé
// service_role, qui contourne la RLS), retrouve le user_id associé,
// puis upsert la partie dans `games` pour CE joueur.
//
// Déploiement (dashboard Supabase → Edge Functions → Deploy new function,
//   nom « ingest ») :
//   ⚠️ Désactive « Enforce JWT verification » pour cette fonction : elle
//   est appelée par le grabber qui n'a pas de session Supabase — c'est le
//   device_token (dans le corps) qui fait l'authentification.
//
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement
// par Supabase dans l'environnement de la fonction (rien à configurer).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const { device_token, game_id, raw, me, opp_hero, format, captured_at } = body || {};
  if (!device_token || !game_id || !raw) return json({ error: "missing fields" }, 400);
  if (!/^\d+$/.test(String(game_id))) return json({ error: "invalid game_id" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 1) Valider le code d'appareil → user_id.
  const { data: dt, error: dtErr } = await admin
    .from("device_tokens").select("user_id").eq("token", device_token).maybeSingle();
  if (dtErr) return json({ error: "auth lookup failed" }, 500);
  if (!dt) return json({ error: "invalid device token" }, 401);

  // 2) Upsert de la partie pour ce joueur (dédup par user_id+game_id).
  const { error: upErr } = await admin.from("games").upsert({
    user_id: dt.user_id,
    game_id: String(game_id),
    raw: String(raw),
    me: me ?? null,
    opp_hero: opp_hero ?? null,
    format: format ?? null,
    captured_at: captured_at ?? null,
  }, { onConflict: "user_id,game_id" });
  if (upErr) return json({ error: "insert failed", detail: upErr.message }, 500);

  // 3) Marquer le code comme utilisé (best-effort, non bloquant).
  admin.from("device_tokens").update({ last_used_at: new Date().toISOString() })
    .eq("token", device_token).then(() => {}, () => {});

  return json({ ok: true, game_id: String(game_id) });
});
