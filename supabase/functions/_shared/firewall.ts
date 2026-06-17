// Deterministic safety firewall — runs BEFORE any model call or storage.
//
// Ported in spirit from V-Pro/blaksyd_whatsassist's rule-based firewall: some
// content must NEVER be stored raw, echoed back, or fed to the model. This is
// rule-based ON PURPOSE — an LLM may judge ON TOP of this layer, never replace
// it. BLOCK is absolute: the message is redacted before persistence and the
// model is told only that "sensitive data was redacted", never the value.
//
// Scope here is narrow and high-precision: secrets a friend would never need
// echoed (OTPs, full card+CVV, government IDs). We bias to redaction, not
// silence — Blak still replies, just without the secret in context.

export type FirewallSeverity = "ok" | "redact" | "block";

export interface FirewallVerdict {
  severity: FirewallSeverity;
  reasons: string[];
  /** Message with sensitive spans replaced by ⟦redacted:type⟧ placeholders. */
  sanitized: string;
}

interface Rule {
  type: string;
  severity: FirewallSeverity;
  pattern: RegExp;
}

// High-precision patterns. Order matters: longer/more-specific first.
const RULES: Rule[] = [
  // One-time passcodes: "OTP is 482910", "code: 0934", "verification 12 34 56"
  {
    type: "otp",
    severity: "block",
    pattern:
      /\b(?:otp|one[\s-]?time(?:\s+password|\s+code)?|verification(?:\s+code)?|auth(?:entication)?\s+code|2fa)\b[^0-9]{0,15}(\d[\d\s-]{2,7}\d)/gi,
  },
  // Card PAN (13–19 digits, optional spaces/dashes) optionally followed by CVV.
  {
    type: "card",
    severity: "block",
    pattern:
      /\b(?:\d[ -]?){13,19}\b(?:[^0-9]{0,12}\b(?:cvv|cvc|security\s+code)\b[^0-9]{0,6}\d{3,4})?/gi,
  },
  // CVV called out explicitly.
  {
    type: "cvv",
    severity: "block",
    pattern: /\b(?:cvv|cvc|security\s+code)\b[^0-9]{0,6}(\d{3,4})\b/gi,
  },
  // India Aadhaar (12 digits, often spaced 4-4-4).
  {
    type: "aadhaar",
    severity: "block",
    pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/gi,
  },
  // US SSN.
  {
    type: "ssn",
    severity: "block",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
];

/**
 * Inspect inbound (or outbound) text. Returns a verdict plus a sanitized copy
 * safe to persist and feed the model. Never throws.
 */
export function inspect(text: string): FirewallVerdict {
  if (!text) return { severity: "ok", reasons: [], sanitized: "" };

  let sanitized = text;
  const reasons = new Set<string>();
  let worst: FirewallSeverity = "ok";

  for (const rule of RULES) {
    if (rule.pattern.test(sanitized)) {
      reasons.add(rule.type);
      worst = escalate(worst, rule.severity);
      // Reset lastIndex (global regex is stateful) then redact all matches.
      rule.pattern.lastIndex = 0;
      sanitized = sanitized.replace(rule.pattern, `⟦redacted:${rule.type}⟧`);
    }
    rule.pattern.lastIndex = 0;
  }

  return { severity: worst, reasons: [...reasons], sanitized };
}

function escalate(a: FirewallSeverity, b: FirewallSeverity): FirewallSeverity {
  const rank = { ok: 0, redact: 1, block: 2 } as const;
  return rank[b] > rank[a] ? b : a;
}
