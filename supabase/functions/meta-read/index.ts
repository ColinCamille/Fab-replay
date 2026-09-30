// ============================================================
// Edge Function « meta-read » — lecture seule du bucket privé meta-games.
// ------------------------------------------------------------
// Pour les sessions Claude (skill fab-top-lists) : elles ont un JETON DE
// LECTURE (table meta_read_tokens, stocké haché) au lieu de la clé secrète
// Supabase. Le jeton ne permet que :
//   GET ?list=<dossier>           → noms des fichiers du dossier (cc, cc-comp…)
//   GET ?path=<dossier>/<date>.jsonl.xz → lien de téléchargement signé (5 min)
// Jeton dans l'en-tête `x-meta-token`.
//
// ⚠️ « Enforce JWT verification » désactivé : l'authentification, c'est le jeton.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont injectés par Supabase.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "meta-games";
const FOLDER = /^[a-z0-9-]{1,32}$/;
const FILE = /^[a-z0-9-]{1,32}\/\d{4}-\d{2}-\d{2}\.jsonl\.xz$/;

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

  const url = new URL(req.url);
  const list = url.searchParams.get("list");
  const path = url.searchParams.get("path");

  if (list !== null) {
    if (!FOLDER.test(list)) return json({ error: "invalid folder" }, 400);
    const { data, error } = await admin.storage.from(BUCKET).list(list, { limit: 1000 });
    if (error) return json({ error: "list failed" }, 500);
    return json({ files: (data || []).map((o) => o.name) });
  }
  if (path !== null) {
    if (!FILE.test(path)) return json({ error: "invalid path" }, 400);
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
    // Fichier absent (jour pas encore collecté) → 404, le client passe à l'API.
    if (error || !data) return json({ error: "not found" }, 404);
    return json({ url: data.signedUrl });
  }
  return json({ error: "list or path required" }, 400);
});
