"use client";

/**
 * ContactFormSettings — Instinct Sites contact-form configuration UI.
 *
 * Controlled component that edits `brief.contactForm` in place:
 *   - fields       — string[] of user-facing input names (chips + delete,
 *                    "Add field" input)
 *   - recipientEmail — where submissions land
 *   - subjectTemplate — overrides default `[{client}] contact form submission`
 *   - notifySlack  — optional webhook URL
 *
 * Also renders a copy-pasteable HTML snippet the designer can drop into
 * the wolfpack-site-template. The snippet includes the hidden
 * `_hp_website` honeypot + a form action pointed at the production
 * Instinct URL so clients don't have to guess the path.
 *
 * No data loss: parent controls the brief, we just call onChange. The
 * parent persists via the existing PATCH /api/sites/[id] brief flow and
 * emits `site.brief_updated` — no new analytics plumbing needed here.
 *
 * NOTE: we do not edit /sites/[id]/page.tsx directly (per Wave I-B
 * exclusion list) — the parent session wires this component into the
 * detail page.
 */

import { useCallback, useMemo, useState } from "react";
import type { SiteBrief } from "@/lib/sites-schema";

interface Props {
  brief: SiteBrief;
  onChange: (next: SiteBrief) => void;
  /** Origin of the deployed Instinct API (usually production URL). */
  apiBaseUrl?: string;
}

const DEFAULT_API_BASE = "https://wolfpack-instinct.vercel.app";
const SUBJECT_DEFAULT = "[{client}] contact form submission";

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidSlack(s: string): boolean {
  return s.startsWith("https://hooks.slack.com/");
}

export default function ContactFormSettings({
  brief,
  onChange,
  apiBaseUrl,
}: Props) {
  const cf = brief.contactForm ?? { fields: [] };
  // Memoize so the dependency arrays below have a stable reference; the
  // logical-OR fallback would otherwise spawn a fresh array each render
  // and re-trigger every dependent hook.
  const fields = useMemo(() => cf.fields ?? [], [cf.fields]);
  const [fieldInput, setFieldInput] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [slackTouched, setSlackTouched] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);

  const apiBase = apiBaseUrl || DEFAULT_API_BASE;

  const patchContactForm = useCallback(
    (next: Partial<NonNullable<SiteBrief["contactForm"]>>) => {
      onChange({
        ...brief,
        contactForm: {
          fields,
          ...(cf.recipientEmail ? { recipientEmail: cf.recipientEmail } : {}),
          ...(cf.subjectTemplate ? { subjectTemplate: cf.subjectTemplate } : {}),
          ...(cf.notifySlack ? { notifySlack: cf.notifySlack } : {}),
          ...next,
        },
      });
    },
    [brief, cf.recipientEmail, cf.subjectTemplate, cf.notifySlack, fields, onChange],
  );

  const addField = useCallback(() => {
    const v = fieldInput.trim();
    if (!v) return;
    if (fields.includes(v)) {
      setFieldInput("");
      return;
    }
    patchContactForm({ fields: [...fields, v] });
    setFieldInput("");
  }, [fieldInput, fields, patchContactForm]);

  const removeField = useCallback(
    (name: string) => {
      patchContactForm({ fields: fields.filter((f) => f !== name) });
    },
    [fields, patchContactForm],
  );

  const emailInvalid =
    emailTouched &&
    cf.recipientEmail !== undefined &&
    cf.recipientEmail.length > 0 &&
    !isValidEmail(cf.recipientEmail);

  const slackInvalid =
    slackTouched &&
    cf.notifySlack !== undefined &&
    cf.notifySlack.length > 0 &&
    !isValidSlack(cf.notifySlack);

  const actionUrl = useMemo(
    () => `${apiBase.replace(/\/+$/, "")}/api/public/forms/{siteId}/submit`,
    [apiBase],
  );

  const snippet = useMemo(() => {
    const fieldBlocks = fields.length
      ? fields
      : ["name", "email", "message"];
    const inputs = fieldBlocks
      .map((name) => {
        const type =
          name.toLowerCase().includes("email") ? "email" : "text";
        const tag =
          name.toLowerCase() === "message"
            ? `<textarea name="message" required rows="5"></textarea>`
            : `<input type="${type}" name="${name}" required />`;
        return `  <label>${name}\n    ${tag}\n  </label>`;
      })
      .join("\n");
    return [
      `<form method="POST" action="${actionUrl}" enctype="application/x-www-form-urlencoded">`,
      inputs,
      `  <!-- honeypot — bots fill it, humans don't -->`,
      `  <input type="text" name="_hp_website" style="display:none" tabindex="-1" autocomplete="off" />`,
      `  <button type="submit">Send</button>`,
      `</form>`,
    ].join("\n");
  }, [actionUrl, fields]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — user can select + copy manually.
    }
  }, [snippet]);

  return (
    <section
      data-testid="contact-form-settings"
      style={{
        padding: 16,
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
      }}
      aria-labelledby="contact-form-settings-heading"
    >
      <h3 id="contact-form-settings-heading" style={{ marginTop: 0 }}>
        Contact form
      </h3>
      <p style={{ color: "#888", fontSize: 13 }}>
        Fields the visitor fills in, where submissions go, and the HTML
        snippet to drop into the site template.
      </p>

      {/* ----- Fields ----- */}
      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="contact-form-field-input"
          style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
        >
          Fields
        </label>
        <div
          data-testid="contact-form-fields"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 8,
          }}
        >
          {fields.length === 0 && (
            <span
              data-testid="contact-form-fields-empty"
              style={{ color: "#666", fontSize: 13 }}
            >
              No fields yet — add name, email, message.
            </span>
          )}
          {fields.map((f) => (
            <span
              key={f}
              data-testid={`contact-form-field-chip-${f}`}
              style={{
                background: "rgba(255,255,255,0.08)",
                padding: "4px 8px",
                borderRadius: 12,
                fontSize: 13,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {f}
              <button
                type="button"
                aria-label={`Remove field ${f}`}
                data-testid={`contact-form-field-remove-${f}`}
                onClick={() => removeField(f)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#eee",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="contact-form-field-input"
            data-testid="contact-form-field-input"
            type="text"
            value={fieldInput}
            onChange={(e) => setFieldInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addField();
              }
            }}
            placeholder="e.g. phone"
            style={{ flex: 1, padding: "6px 8px" }}
          />
          <button
            type="button"
            data-testid="contact-form-field-add"
            onClick={addField}
          >
            Add field
          </button>
        </div>
      </div>

      {/* ----- Recipient email ----- */}
      <div style={{ marginTop: 16 }}>
        <label
          htmlFor="contact-form-recipient"
          style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
        >
          Recipient email
        </label>
        <input
          id="contact-form-recipient"
          data-testid="contact-form-recipient"
          type="email"
          value={cf.recipientEmail ?? ""}
          onChange={(e) =>
            patchContactForm({ recipientEmail: e.target.value })
          }
          onBlur={() => setEmailTouched(true)}
          placeholder="leads@client.com"
          aria-invalid={emailInvalid}
          style={{ width: "100%", padding: "6px 8px" }}
        />
        {emailInvalid && (
          <span
            data-testid="contact-form-recipient-error"
            style={{ color: "#e6b84d", fontSize: 12 }}
          >
            Must be a valid email.
          </span>
        )}
      </div>

      {/* ----- Subject template ----- */}
      <div style={{ marginTop: 16 }}>
        <label
          htmlFor="contact-form-subject"
          style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
        >
          Subject template
        </label>
        <input
          id="contact-form-subject"
          data-testid="contact-form-subject"
          type="text"
          value={cf.subjectTemplate ?? ""}
          onChange={(e) =>
            patchContactForm({ subjectTemplate: e.target.value })
          }
          placeholder={SUBJECT_DEFAULT}
          maxLength={120}
          style={{ width: "100%", padding: "6px 8px" }}
        />
        <span style={{ color: "#888", fontSize: 12 }}>
          {`{client}`} and {`{site}`} are substituted at send time.
        </span>
      </div>

      {/* ----- Slack webhook ----- */}
      <div style={{ marginTop: 16 }}>
        <label
          htmlFor="contact-form-slack"
          style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
        >
          Slack webhook (optional)
        </label>
        <input
          id="contact-form-slack"
          data-testid="contact-form-slack"
          type="url"
          value={cf.notifySlack ?? ""}
          onChange={(e) => patchContactForm({ notifySlack: e.target.value })}
          onBlur={() => setSlackTouched(true)}
          placeholder="https://hooks.slack.com/services/..."
          aria-invalid={slackInvalid}
          style={{ width: "100%", padding: "6px 8px" }}
        />
        {slackInvalid && (
          <span
            data-testid="contact-form-slack-error"
            style={{ color: "#e6b84d", fontSize: 12 }}
          >
            Must start with https://hooks.slack.com/
          </span>
        )}
      </div>

      {/* ----- HTML snippet ----- */}
      <div style={{ marginTop: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 4,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            Form action URL + HTML snippet
          </span>
          <button
            type="button"
            data-testid="contact-form-snippet-copy"
            onClick={onCopy}
          >
            {snippetCopied ? "Copied!" : "Copy HTML"}
          </button>
        </div>
        <pre
          data-testid="contact-form-snippet"
          style={{
            background: "rgba(0,0,0,0.3)",
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            overflowX: "auto",
            userSelect: "all",
          }}
        >
          {snippet}
        </pre>
        <div style={{ color: "#888", fontSize: 12 }}>
          The action URL will resolve to this site once deployed. Replace
          <code>{"{siteId}"}</code> with the site id in the URL bar.
        </div>
      </div>
    </section>
  );
}
