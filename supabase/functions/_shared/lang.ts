// Language-lane detection — matches symp_vibe_state.language_lane vocabulary.
//
// India-first: users on +91 7702063434 routinely type Telugu/Hindi in native
// script OR romanized ("ela unnav", "kaise ho"). Blak must MIRROR whatever the
// user used — same language, same script — so the reply feels like a friend,
// not a translator. Detection is cheap and script-first; romanized is a
// keyword/heuristic layer on top. When unsure we default to English.

import type { LangLane } from "./types.ts";

// Unicode blocks.
const TELUGU = /[ఀ-౿]/;
const DEVANAGARI = /[ऀ-ॿ]/; // Hindi (and others, but Hindi-dominant here)

// Common romanized markers. Deliberately small + high-signal; the LLM handles
// the long tail. We only need a nudge for the language lane + mirroring hint.
const ROMAN_TE = [
  "ela", "unnav", "unnara", "emi", "cheppu", "bagunna", "bagunnava", " enti",
  "nuvvu", "nenu", "kavali", "vddu", "vaddu", "chesava", "ekkada", "ippudu",
  "ranu", "vstanu", "vastanu", "thopu", "anna", "akka", "ammai", "abbai",
];
const ROMAN_HI = [
  "kaise", "ho", "kya", "hai", "kaisa", "tum", "aap", "kar", "raha", "rahe",
  "rahi", "nahi", "nahin", "haan", "theek", "thik", "acha", "accha", "kyun",
  "kyon", "matlab", "bhai", "yaar", "abhi", "chalo", "bata", "batao", "mujhe",
];

function romanScore(words: string[], lex: string[]): number {
  const set = new Set(lex);
  let hits = 0;
  for (const w of words) if (set.has(w)) hits++;
  return hits;
}

/** Detect the language lane of an inbound message. */
export function detectLang(text: string): LangLane {
  if (!text) return "en";

  if (TELUGU.test(text)) return "te";
  if (DEVANAGARI.test(text)) return "hi";

  // Romanized heuristic — only for predominantly ASCII text.
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length > 0) {
    const te = romanScore(words, ROMAN_TE);
    const hi = romanScore(words, ROMAN_HI);
    // Require at least 2 signal words and a clear winner to claim romanized.
    if (te >= 2 && te >= hi) return "romanized-te";
    if (hi >= 2 && hi > te) return "romanized-hi";
  }

  return "en";
}

const LABEL: Record<LangLane, string> = {
  te: "Telugu (native script)",
  hi: "Hindi (Devanagari script)",
  en: "English",
  "romanized-te": "Telugu written in Latin/English letters (romanized)",
  "romanized-hi": "Hindi written in Latin/English letters (romanized)",
};

/**
 * Instruction injected into the system prompt so the model mirrors the user's
 * language AND script exactly. Mirroring beats "translate to X" — it preserves
 * code-switching, which Indian users do constantly within one message.
 */
export function mirrorInstruction(lang: LangLane): string {
  if (lang === "en") {
    return "The user is writing in English. Reply in natural English. If they code-switch into another language mid-message, mirror that naturally.";
  }
  return `The user is writing in ${LABEL[lang]}. Reply in the SAME language and the SAME script they used — do not switch scripts on them, and do not translate to English unless they do. Match their register and slang. Code-switching is fine when they do it.`;
}
