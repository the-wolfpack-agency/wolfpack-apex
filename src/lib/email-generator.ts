/**
 * Client Email Draft Generator — Zero-token email template system.
 *
 * All templates are code-defined (no DB). Every generation tracks analytics
 * for the learning loop to measure client engagement patterns.
 */

import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailDraft {
  subject: string;
  body: string;
  templateId: string;
  generatedAt: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  requiredVariables: string[];
  optionalVariables: string[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATES: Record<
  string,
  {
    name: string;
    description: string;
    requiredVariables: string[];
    optionalVariables: string[];
    subject: (vars: Record<string, string>) => string;
    body: (vars: Record<string, string>) => string;
  }
> = {
  proposal: {
    name: "Product Proposal",
    description: "Send a product proposal to a prospective or existing client",
    requiredVariables: ["clientName", "productName", "features"],
    optionalVariables: ["pricing", "senderName"],
    subject: (v) => `Wolfpack ${v.productName} — Proposal for ${v.clientName}`,
    body: (v) => {
      const features = v.features
        .split(",")
        .map((f: string) => `  - ${f.trim()}`)
        .join("\n");
      const pricingBlock = v.pricing
        ? `\nInvestment\n----------\n${v.pricing}\n`
        : "";
      return `Hi ${v.clientName},

Thank you for your interest in Wolfpack ${v.productName}. We have put together a tailored solution based on our conversation.

Key Capabilities
----------------
${features}
${pricingBlock}
Next Steps
----------
1. Review the attached capabilities document
2. Schedule a 30-minute walkthrough at your convenience
3. We will configure a demo environment for your team

We are excited about the opportunity to work together. Please let us know if you have any questions.

Best regards,
${v.senderName || "The Wolfpack Team"}`;
    },
  },

  followup: {
    name: "Meeting Follow-Up",
    description: "Follow up after a client meeting with action items",
    requiredVariables: ["clientName", "meetingDate", "actionItems"],
    optionalVariables: ["senderName"],
    subject: (v) => `Follow-Up: Wolfpack Meeting — ${v.meetingDate}`,
    body: (v) => {
      const items = v.actionItems
        .split(",")
        .map((item: string, i: number) => `  ${i + 1}. ${item.trim()}`)
        .join("\n");
      return `Hi ${v.clientName},

Thank you for taking the time to meet with us on ${v.meetingDate}. Here is a summary of the action items we discussed:

Action Items
------------
${items}

We will begin working on these immediately and will provide updates as each item is completed. If anything was missed or needs clarification, please do not hesitate to reach out.

Best regards,
${v.senderName || "The Wolfpack Team"}`;
    },
  },

  status_update: {
    name: "Project Status Update",
    description: "Send a project status update with completed and upcoming items",
    requiredVariables: ["clientName", "projectName", "completedItems", "upcomingItems"],
    optionalVariables: ["senderName"],
    subject: (v) => `${v.projectName} — Status Update`,
    body: (v) => {
      const completed = v.completedItems
        .split(",")
        .map((item: string) => `  [x] ${item.trim()}`)
        .join("\n");
      const upcoming = v.upcomingItems
        .split(",")
        .map((item: string) => `  [ ] ${item.trim()}`)
        .join("\n");
      return `Hi ${v.clientName},

Here is your latest status update for ${v.projectName}.

Completed
---------
${completed}

Coming Up Next
--------------
${upcoming}

We are on track and will continue to keep you informed. Let us know if priorities need to shift.

Best regards,
${v.senderName || "The Wolfpack Team"}`;
    },
  },

  onboarding: {
    name: "Client Onboarding Welcome",
    description: "Welcome a new client with login credentials and getting-started info",
    requiredVariables: ["clientName", "loginUrl", "adminUrl"],
    optionalVariables: ["senderName"],
    subject: (v) => `Welcome to Wolfpack — Your Account is Ready`,
    body: (v) => `Hi ${v.clientName},

Welcome aboard! Your Wolfpack account has been provisioned and is ready to use.

Getting Started
---------------
  1. Log in at: ${v.loginUrl}
  2. Admin dashboard: ${v.adminUrl}
  3. Complete your profile and invite team members
  4. Review the getting-started guide in your dashboard

Your initial password was sent in a separate secure email. Please change it on first login.

Support
-------
  - Email: support@wolfpackagency.com
  - Response time: within 4 business hours

We are thrilled to have you on board. Do not hesitate to reach out with any questions.

Best regards,
${v.senderName || "The Wolfpack Team"}`,
  },
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function validateRequiredVars(templateId: string, vars: Record<string, string>): void {
  const template = TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Unknown template: ${templateId}. Available: ${Object.keys(TEMPLATES).join(", ")}`);
  }

  const missing = template.requiredVariables.filter((v) => !vars[v] || typeof vars[v] !== "string");
  if (missing.length > 0) {
    throw new Error(`Missing required variables for "${template.name}": ${missing.join(", ")}`);
  }
}

/**
 * Generate a proposal email.
 */
export function generateProposalEmail(
  clientName: string,
  productName: string,
  features: string[],
  userId: string = "system",
  userRole: string = "sales",
  pricing?: string,
): EmailDraft {
  const vars: Record<string, string> = {
    clientName,
    productName,
    features: features.join(", "),
  };
  if (pricing) vars.pricing = pricing;

  validateRequiredVars("proposal", vars);

  const draft: EmailDraft = {
    subject: TEMPLATES.proposal.subject(vars),
    body: TEMPLATES.proposal.body(vars),
    templateId: "proposal",
    generatedAt: new Date().toISOString(),
  };

  trackEvent("client.email_drafted", userId, userRole, {
    template: "proposal",
    client: clientName,
    product: productName,
  });

  return draft;
}

/**
 * Generate a meeting follow-up email.
 */
export function generateFollowUpEmail(
  clientName: string,
  meetingDate: string,
  actionItems: string[],
  userId: string = "system",
  userRole: string = "sales",
): EmailDraft {
  const vars: Record<string, string> = {
    clientName,
    meetingDate,
    actionItems: actionItems.join(", "),
  };

  validateRequiredVars("followup", vars);

  const draft: EmailDraft = {
    subject: TEMPLATES.followup.subject(vars),
    body: TEMPLATES.followup.body(vars),
    templateId: "followup",
    generatedAt: new Date().toISOString(),
  };

  trackEvent("client.email_drafted", userId, userRole, {
    template: "followup",
    client: clientName,
    meeting_date: meetingDate,
  });

  return draft;
}

/**
 * Generate a project status update email.
 */
export function generateStatusUpdateEmail(
  clientName: string,
  projectName: string,
  completedItems: string[],
  upcomingItems: string[],
  userId: string = "system",
  userRole: string = "ops",
): EmailDraft {
  const vars: Record<string, string> = {
    clientName,
    projectName,
    completedItems: completedItems.join(", "),
    upcomingItems: upcomingItems.join(", "),
  };

  validateRequiredVars("status_update", vars);

  const draft: EmailDraft = {
    subject: TEMPLATES.status_update.subject(vars),
    body: TEMPLATES.status_update.body(vars),
    templateId: "status_update",
    generatedAt: new Date().toISOString(),
  };

  trackEvent("client.email_drafted", userId, userRole, {
    template: "status_update",
    client: clientName,
    project: projectName,
  });

  return draft;
}

/**
 * Generate a client onboarding welcome email.
 */
export function generateOnboardingEmail(
  clientName: string,
  loginUrl: string,
  adminUrl: string,
  userId: string = "system",
  userRole: string = "ops",
): EmailDraft {
  const vars: Record<string, string> = {
    clientName,
    loginUrl,
    adminUrl,
  };

  validateRequiredVars("onboarding", vars);

  const draft: EmailDraft = {
    subject: TEMPLATES.onboarding.subject(vars),
    body: TEMPLATES.onboarding.body(vars),
    templateId: "onboarding",
    generatedAt: new Date().toISOString(),
  };

  trackEvent("client.email_drafted", userId, userRole, {
    template: "onboarding",
    client: clientName,
  });

  return draft;
}

/**
 * Return all available templates with descriptions.
 */
export function getEmailTemplates(): EmailTemplate[] {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    requiredVariables: t.requiredVariables,
    optionalVariables: t.optionalVariables,
  }));
}

/**
 * Fill any template with custom variables.
 */
export function customizeTemplate(
  templateId: string,
  variables: Record<string, string>,
  userId: string = "system",
  userRole: string = "sales",
): EmailDraft {
  validateRequiredVars(templateId, variables);

  const template = TEMPLATES[templateId];
  const draft: EmailDraft = {
    subject: template.subject(variables),
    body: template.body(variables),
    templateId,
    generatedAt: new Date().toISOString(),
  };

  trackEvent("client.email_drafted", userId, userRole, {
    template: templateId,
    custom: true,
  });

  return draft;
}
