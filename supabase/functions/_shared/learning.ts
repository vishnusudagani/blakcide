// Learning pipeline — "constantly learning" + non-salesy profile filling.
//
// Runs AFTER a reply is sent, so it never adds latency to the conversation. It
// (1) silently extracts durable facts into symp_persona_facts, (2) categorises
// the thread for the app's grouped view, (3) keeps a rolling conversation
// summary, and (4) writes a daily session summary so WhatsApp feeds the SAME
// vault pipeline the app already uses. Every step is best-effort and swallows
// its own errors — learning must never break the chat.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { BrainContext } from "./types.ts";
import { chatJson } from "./llm.ts";

// Categories for the app's grouped chat view. Keep stable — the app UI groups
// on these exact strings.
export const CATEGORIES = [
  "wellbeing",
  "relationships",
  "work_study",
  "health",
  "plans_logistics",
  "money",
  "ideas_learning",
  "fun_culture",
  "admin_tasks",
  "just_talking",
] as const;

interface Extraction {
  facts: Record<string, string>; // field -> value, only durable/confident
  category: string; // one of CATEGORIES
  categories: string[]; // 1-3 of CATEGORIES
  title: string; // short human title for the thread
  summary: string; // 1-2 sentence rolling summary
}

/**
 * One cheap JSON call distills the latest turns. We pass the prior summary so
 * the model updates rather than restarts it.
 */
async function distill(
  ctx: BrainContext,
  userText: string,
  blakText: string,
): Promise<Extraction | null> {
  const priorSummary = ctx.conversation.summary ?? "";
  const known = Object.keys(ctx.personaFacts);

  const sys =
    `You are a careful note-taker observing a friendship chat. Output STRICT JSON only.\n` +
    `Extract ONLY durable, confidently-stated facts about the user worth remembering long-term ` +
    `(their name, city, work/study, family, close people, hobbies, food, routines, goals, ` +
    `stresses, celebrations, preferences). Do NOT invent. Do NOT include transient chit-chat. ` +
    `Do NOT re-extract things already known: ${JSON.stringify(known)}.\n` +
    `Also classify the conversation.\n` +
    `Categories must be from: ${JSON.stringify(CATEGORIES)}.\n` +
    `Return: {"facts": {field: value}, "category": string, "categories": string[], "title": string, "summary": string}.\n` +
    `"facts" may be empty {}. Keep "summary" to 1-2 sentences, updating this prior summary: ${JSON.stringify(priorSummary)}.`;

  const user =
    `User said: ${JSON.stringify(userText)}\n` +
    `Blak replied: ${JSON.stringify(blakText)}`;

  return await chatJson<Extraction>(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { maxTokens: 500 },
  );
}

/**
 * Run the full learning pass for one turn. Safe to fire-and-forget.
 */
export async function learnFromTurn(
  db: SupabaseClient,
  ctx: BrainContext,
  userText: string,
  blakText: string,
): Promise<void> {
  try {
    const ex = await distill(ctx, userText, blakText);
    if (!ex) return;

    // 1 + 3 + categorisation: update the conversation row.
    const category = CATEGORIES.includes(ex.category as never)
      ? ex.category
      : "just_talking";
    const categories = (ex.categories ?? [])
      .filter((c) => CATEGORIES.includes(c as never))
      .slice(0, 3);

    await db
      .from("blak_conversations")
      .update({
        title: ex.title?.slice(0, 120) ?? ctx.conversation.title,
        category,
        categories: categories.length ? categories : [category],
        summary: ex.summary?.slice(0, 1000) ?? ctx.conversation.summary,
      })
      .eq("id", ctx.conversation.id);

    // 2: merge durable facts into symp_persona_facts (only for linked users —
    // shadow users have no auth.users row to key on; their facts ride in the
    // conversation summary until they link, then get distilled forward).
    if (ctx.identity.user_id && ex.facts && Object.keys(ex.facts).length) {
      const merged = { ...ctx.personaFacts, ...ex.facts };
      await db.from("symp_persona_facts").upsert(
        {
          user_id: ctx.identity.user_id,
          persona_id: ctx.activePersona,
          facts: merged,
        },
        { onConflict: "user_id,persona_id" },
      );
    }

    // 4: feed the daily vault pipeline (source 'ai' — Blak is the AI channel).
    if (ctx.identity.user_id) {
      await appendSessionSummary(db, ctx.identity.user_id, ex.summary, ctx.conversation.id);
    }
  } catch {
    /* learning is best-effort; never surface to the chat */
  }
}

/**
 * Upsert today's AI session summary so the existing Module-4 daily analyser
 * picks up WhatsApp activity alongside in-app sessions. Mirrors the
 * symp_session_summaries (user_id, summary_date, source) unique key.
 */
async function appendSessionSummary(
  db: SupabaseClient,
  userId: string,
  summary: string,
  conversationId: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // UTC date
  const { data: existing } = await db
    .from("symp_session_summaries")
    .select("id, content, session_refs")
    .eq("user_id", userId)
    .eq("summary_date", today)
    .eq("source", "ai")
    .maybeSingle();

  const ref = { session_id: conversationId, session_type: "whatsapp", at: new Date().toISOString() };

  if (existing) {
    const refs = Array.isArray((existing as { session_refs?: unknown[] }).session_refs)
      ? (existing as { session_refs: unknown[] }).session_refs
      : [];
    const hasRef = refs.some(
      (r) => (r as { session_id?: string })?.session_id === conversationId,
    );
    await db
      .from("symp_session_summaries")
      .update({
        content: `${(existing as { content?: string }).content ?? ""}\n${summary}`.trim().slice(0, 8000),
        session_refs: hasRef ? refs : [...refs, ref],
      })
      .eq("id", (existing as { id: string }).id);
  } else {
    await db.from("symp_session_summaries").insert({
      user_id: userId,
      summary_date: today,
      source: "ai",
      content: summary,
      session_refs: [ref],
    });
  }
}
