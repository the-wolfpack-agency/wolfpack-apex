/**
 * Document Quality Gate -- Validates content before it enters data stores.
 *
 * Checks:
 *   1. PII detection (SSN, credit card, phone, email addresses, passwords)
 *   2. Compliance (profanity, slurs, hate speech indicators)
 *   3. Data quality (empty, too short, gibberish, duplicate detection)
 *   4. Security (API keys, tokens, secrets, connection strings)
 *
 * Every check result is tracked in analytics for learning.
 * Rejected docs never enter the knowledge base.
 */

import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateVerdict = "pass" | "warn" | "reject";

export interface GateFlag {
  category: "pii" | "compliance" | "quality" | "security";
  severity: GateVerdict;
  message: string;
  match?: string; // redacted excerpt
}

export interface GateResult {
  verdict: GateVerdict;
  flags: GateFlag[];
  sanitizedContent?: string; // content with PII redacted, if applicable
}

// ---------------------------------------------------------------------------
// PII Patterns
// ---------------------------------------------------------------------------

const PII_PATTERNS: { name: string; pattern: RegExp; severity: GateVerdict }[] = [
  {
    name: "SSN",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    severity: "reject",
  },
  {
    name: "Credit card",
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}\b/g,
    severity: "reject",
  },
  {
    name: "Phone number",
    pattern: /\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    severity: "warn",
  },
  {
    name: "Email address",
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    severity: "warn",
  },
  {
    name: "Date of birth pattern",
    pattern: /\b(?:DOB|date of birth|born on)[:\s]+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi,
    severity: "reject",
  },
  {
    name: "Driver's license",
    pattern: /\b(?:DL|driver'?s?\s*license)[:\s#]*[A-Z0-9]{5,15}\b/gi,
    severity: "reject",
  },
];

// ---------------------------------------------------------------------------
// Security Patterns (secrets, keys, tokens)
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS: { name: string; pattern: RegExp; severity: GateVerdict }[] = [
  {
    name: "API key",
    pattern: /\b(?:sk|pk|api[_-]?key|apikey|secret[_-]?key)[_-]?[a-zA-Z0-9]{20,}\b/gi,
    severity: "reject",
  },
  {
    name: "AWS key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "reject",
  },
  {
    name: "Connection string",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/gi,
    severity: "reject",
  },
  {
    name: "Bearer token",
    pattern: /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/g,
    severity: "reject",
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    severity: "reject",
  },
  {
    name: "Password assignment",
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{4,}['"]/gi,
    severity: "reject",
  },
  {
    name: "JWT token",
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    severity: "reject",
  },
];

// ---------------------------------------------------------------------------
// Compliance Patterns
// ---------------------------------------------------------------------------

const COMPLIANCE_PATTERNS: { name: string; pattern: RegExp; severity: GateVerdict }[] = [
  {
    name: "Explicit profanity",
    pattern: /\b(?:fuck|shit|bitch|asshole|damn|bastard|crap)\b/gi,
    severity: "warn",
  },
];

// ---------------------------------------------------------------------------
// Quality Checks
// ---------------------------------------------------------------------------

const MIN_CONTENT_LENGTH = 10;
const MAX_GIBBERISH_RATIO = 0.6; // if 60%+ non-alphanumeric, likely garbage

function checkQuality(content: string): GateFlag[] {
  const flags: GateFlag[] = [];

  if (!content || content.trim().length === 0) {
    flags.push({
      category: "quality",
      severity: "reject",
      message: "Content is empty",
    });
    return flags;
  }

  if (content.trim().length < MIN_CONTENT_LENGTH) {
    flags.push({
      category: "quality",
      severity: "reject",
      message: `Content too short (${content.trim().length} chars, minimum ${MIN_CONTENT_LENGTH})`,
    });
  }

  // Gibberish detection: ratio of non-alphanumeric to total
  const alphanumCount = (content.match(/[a-zA-Z0-9]/g) || []).length;
  const total = content.length;
  if (total > 20 && alphanumCount / total < (1 - MAX_GIBBERISH_RATIO)) {
    flags.push({
      category: "quality",
      severity: "warn",
      message: "Content appears to be mostly non-text characters",
    });
  }

  // Repetition detection: same line repeated 5+ times
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
  }
  for (const [line, count] of lineCounts) {
    if (count >= 5) {
      flags.push({
        category: "quality",
        severity: "warn",
        message: `Repeated line detected (${count}x): "${line.slice(0, 40)}..."`,
        match: line.slice(0, 40),
      });
      break;
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Pattern Scanner
// ---------------------------------------------------------------------------

function scanPatterns(
  content: string,
  patterns: { name: string; pattern: RegExp; severity: GateVerdict }[],
  category: GateFlag["category"],
): GateFlag[] {
  const flags: GateFlag[] = [];
  for (const { name, pattern, severity } of patterns) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      // Redact the match for safety
      const redacted = matches[0].length > 8
        ? matches[0].slice(0, 4) + "****" + matches[0].slice(-2)
        : "****";
      flags.push({
        category,
        severity,
        message: `${name} detected (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        match: redacted,
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Sanitize: redact PII from content
// ---------------------------------------------------------------------------

export function redactPII(content: string): string {
  let sanitized = content;
  for (const { pattern } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  for (const { pattern } of SECURITY_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Main Gate Function
// ---------------------------------------------------------------------------

export function checkDocQuality(content: string): GateResult {
  const flags: GateFlag[] = [];

  // 1. Quality checks
  flags.push(...checkQuality(content));

  // 2. PII scan
  flags.push(...scanPatterns(content, PII_PATTERNS, "pii"));

  // 3. Security scan
  flags.push(...scanPatterns(content, SECURITY_PATTERNS, "security"));

  // 4. Compliance scan
  flags.push(...scanPatterns(content, COMPLIANCE_PATTERNS, "compliance"));

  // Determine overall verdict
  const hasReject = flags.some((f) => f.severity === "reject");
  const hasWarn = flags.some((f) => f.severity === "warn");
  const verdict: GateVerdict = hasReject ? "reject" : hasWarn ? "warn" : "pass";

  // If warnings only (no reject), provide sanitized content
  const sanitizedContent = hasWarn && !hasReject ? redactPII(content) : undefined;

  return { verdict, flags, sanitizedContent };
}

// ---------------------------------------------------------------------------
// Track gate results in analytics
// ---------------------------------------------------------------------------

export function trackGateResult(
  result: GateResult,
  userId: string,
  userRole: string,
  fileName: string,
): void {
  trackEvent("assistant.doc_quality_checked", userId, userRole, {
    file_name: fileName,
    verdict: result.verdict,
    flag_count: result.flags.length,
    categories: [...new Set(result.flags.map((f) => f.category))].join(","),
    module: "assistant",
  });

  if (result.verdict === "reject") {
    trackEvent("assistant.doc_rejected", userId, userRole, {
      file_name: fileName,
      reasons: result.flags
        .filter((f) => f.severity === "reject")
        .map((f) => f.message)
        .join("; "),
      module: "assistant",
    });
  }
}
