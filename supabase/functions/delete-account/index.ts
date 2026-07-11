// ============================================================
// Edge Function « delete-account » — RGPD : suppression du compte.
// ------------------------------------------------------------
// Appelée par l'app (utilisateur connecté). On identifie l'appelant
// via son jeton de session (Authorization: Bearer <access_token>,
// envoyé automatiquement par supabase-js functions.invoke), puis on
// supprime SON compte auth avec la clé service_role. Grâce au
// « on delete cascade » sur games.user_id et device_tokens.user_id,
// toutes ses parties et codes d'appairage sont effacés en même temps.
//
// Déploiement (dashboard → Edge Functions → Via Editor, nom
//   « delete-account »). Ici on PEUT laisser « Verify JWT » activé :
//   l'appel porte un vrai jeton utilisateur.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

  const authz = req.headers.get("Authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no session" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1) Identifier l'appelant à partir de son jeton.
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: u, error: uErr } = await asUser.auth.getUser();
  if (uErr || !u?.user) return json({ error: "invalid session" }, 401);
  const uid = u.user.id;

  // 2) Supprimer le compte → cascade sur games + device_tokens.
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) return json({ error: "delete failed", detail: delErr.message }, 500);

  return json({ ok: true });
});
