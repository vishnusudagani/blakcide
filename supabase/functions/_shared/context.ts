// Context assembler — the "same brain, live cross-reference" layer.
//
// Reads the user's brain from the existing Blaksyd tables (vault profile,
// persona state + facts, vibe) plus the recent WhatsApp turns, and packages it
// for the prompt. For a SHADOW identity (no app account yet) the brain tables
// are empty — Blak simply starts learning fresh and fills the profile over time.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { BrainContext, Conversation, Identity, LangLane } from "./types.ts";
import { recentTurns } from "./identity.ts";

// Profile fields Blak can learn organically over time. We surface only the
// ones still MISSING, so Blak's curiosity is targeted — never an intake form.
const PROFILE_FIELDS = [
  "name",
  "city",
  "work_or_study",
  "family",
  "close_people",
  "hobbies",
  "food_preferences",
  "daily_rhythm",
  "current_goals",
  "stress_points",
  "celebrations",
  "language_preference",
];

export async function assembleContext(
  db: SupabaseClient,
  identity: Identity,
  conversation: Conversation,
  lang: LangLane,
): Promise<BrainContext> {
  const userId = identity.user_id;

  // Brain reads run in parallel; all are best-effort (shadow users have none).
  const [vault, personaState, vibe, turns] = await Promise.all([
    userId
      ? db.from("symp_vault_profiles").select("*").eq("user_id", userId).maybeSingle()
        .then((r) => r.data)
      : Promise.resolve(null),
    userId
      ? db.from("symp_persona_state").select("*").eq("user_id", userId).maybeSingle()
        .then((r) => r.data)
      : Promise.resolve(null),
    userId
      ? db.from("symp_vibe_state").select("*").eq("user_id", userId).maybeSingle()
        .then((r) => r.data)
      : Promise.resolve(null),
    recentTurns(db, conversation.id, 16),
  ]);

  const activePersona =
    (personaState as { active_persona?: string } | null)?.active_persona ??
    "friend";

  // Per-persona accumulated facts (the profile we fill without being salesy).
  let personaFacts: Record<string, unknown> = {};
  if (userId) {
    const { data: pf } = await db
      .from("symp_persona_facts")
      .select("facts")
      .eq("user_id", userId)
      .eq("persona_id", activePersona)
      .maybeSingle();
    personaFacts = ((pf as { facts?: Record<string, unknown> } | null)?.facts) ?? {};
  }

  const known = new Set(Object.keys(personaFacts));
  const missingProfileFields = PROFILE_FIELDS.filter((f) => !known.has(f));

  return {
    identity,
    conversation,
    vault: vault as Record<string, unknown> | null,
    personaState: personaState as Record<string, unknown> | null,
    personaFacts,
    vibe: vibe as Record<string, unknown> | null,
    recentTurns: turns,
    retrieved: [], // embedding retrieval can be layered in later (nexus_vault_embeddings)
    activePersona,
    lang,
    missingProfileFields,
  };
}

/** Render the brain into a compact block for the system prompt. */
export function renderContext(ctx: BrainContext): string {
  const lines: string[] = [];
  const name =
    (ctx.personaFacts.name as string | undefined) ??
    ctx.identity.display_name ??
    null;
  if (name) lines.push(`Their name: ${name}`);

  if (ctx.vibe) {
    const v = ctx.vibe as Record<string, unknown>;
    if (v.primary_emotion) lines.push(`Current mood read: ${v.primary_emotion} (energy ${v.energy ?? "?"})`);
    if (v.last_topic) lines.push(`Last topic on their mind: ${v.last_topic}`);
    if (v.streak_days) lines.push(`Engagement streak: ${v.streak_days} days`);
  }

  if (ctx.vault) {
    const vp = ctx.vault as Record<string, unknown>;
    const themes = vp.running_themes;
    if (Array.isArray(themes) && themes.length) {
      lines.push(`Recurring themes: ${themes.slice(0, 6).map(String).join(", ")}`);
    }
    const risk = vp.risk_flags as Record<string, boolean> | undefined;
    if (risk && Object.values(risk).some(Boolean)) {
      const active = Object.entries(risk).filter(([, on]) => on).map(([k]) => k);
      lines.push(`⚠ Care flags raised earlier: ${active.join(", ")} — be gentle; offer the Minit listener if it resurfaces.`);
    }
  }

  const facts = Object.entries(ctx.personaFacts).filter(([k]) => k !== "name");
  if (facts.length) {
    lines.push("What Blak already knows about them:");
    for (const [k, val] of facts.slice(0, 20)) {
      lines.push(`  • ${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`);
    }
  }

  if (ctx.retrieved.length) {
    lines.push("Relevant memories:");
    for (const r of ctx.retrieved.slice(0, 5)) lines.push(`  • ${r}`);
  }

  return lines.length ? lines.join("\n") : "(No history yet — this is early in getting to know them.)";
}
