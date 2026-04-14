/**
 * HR Field Extractor — deterministic, zero-token field extraction for
 * W-4 and I-9 documents.
 *
 * Pure functions over raw PDF text. No AI calls, no external APIs.
 * Uses regex patterns modeled on the 2026 IRS W-4 and USCIS I-9 layouts.
 *
 * SSN safety: ONLY the last 4 digits are ever extracted or returned.
 * Full SSNs are never stored, logged, or returned.
 */

/* ----------------------------- Types --------------------------------- */

export interface W4Fields {
  employee_name: string | null;
  ssn_last_four: string | null;
  address: string | null;
  filing_status: "single" | "married_filing_jointly" | "head_of_household" | null;
  multiple_jobs: boolean | null;
  dependents_amount: number | null;
  extra_withholding: number | null;
  exempt: boolean;
  signed_date: string | null;
  employer_ein: string | null;
  employer_name: string | null;
}

export interface I9Fields {
  employee_name: string | null;
  maiden_name: string | null;
  address: string | null;
  date_of_birth: string | null;
  ssn_last_four: string | null;
  email: string | null;
  phone: string | null;
  citizenship_status: "citizen" | "noncitizen_national" | "permanent_resident" | "alien_authorized" | null;
  uscis_number: string | null;
  i94_number: string | null;
  passport_number: string | null;
  signed_date: string | null;
  preparer_used: boolean | null;
}

export interface ExtractionResult<T> {
  fields: T;
  field_count: number;
  total_fields: number;
  completeness: number;
  extraction_notes: string[];
}

/* ----------------------------- Helpers -------------------------------- */

/**
 * Extract only the last 4 digits of an SSN. Never returns a full SSN.
 * Accepts patterns like: XXX-XX-1234, ***-**-1234, 123-45-6789
 */
function extractSsnLastFour(text: string): string | null {
  // Masked SSN patterns: XXX-XX-1234 or ***-**-1234
  const masked = text.match(/[X*]{3}[-\s]?[X*]{2}[-\s]?(\d{4})/i);
  if (masked) return masked[1];

  // Full SSN pattern — only capture last 4
  const full = text.match(/\d{3}[-\s]?\d{2}[-\s]?(\d{4})/);
  if (full) return full[1];

  return null;
}

/** Extract a date in common formats: MM/DD/YYYY, MM-DD-YYYY, Month DD, YYYY */
function extractDate(text: string, contextPattern?: RegExp): string | null {
  const searchText = contextPattern
    ? (text.match(new RegExp(contextPattern.source + "[\\s\\S]{0,100}", contextPattern.flags))?.[0] ?? "")
    : text;

  // MM/DD/YYYY or MM-DD-YYYY
  const slashDate = searchText.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (slashDate) return `${slashDate[1]}/${slashDate[2]}/${slashDate[3]}`;

  // Month DD, YYYY
  const namedDate = searchText.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (namedDate) return `${namedDate[1]} ${namedDate[2]}, ${namedDate[3]}`;

  return null;
}

/** Extract a dollar amount from text near a context pattern */
function extractDollarAmount(text: string, contextPattern: RegExp): number | null {
  const match = text.match(new RegExp(contextPattern.source + "[\\s\\S]{0,80}\\$([\\d,]+(?:\\.\\d{2})?)", contextPattern.flags));
  if (match) {
    const val = parseFloat(match[match.length - 1].replace(/,/g, ""));
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

function countNonNull(obj: Record<string, unknown>): number {
  return Object.values(obj).filter((v) => v !== null && v !== undefined).length;
}

/* ----------------------------- W-4 Extractor -------------------------- */

export function extractW4Fields(text: string): ExtractionResult<W4Fields> {
  const notes: string[] = [];

  // Employee name — look for First name / Last name labels on separate lines
  let employee_name: string | null = null;
  // Pattern 1: "First name..." line, then value line, then "Last name" line, then value line
  const firstNameVal = text.match(
    /(?:First name(?:\s+and\s+middle\s+initial)?)[\s\S]{0,10}?[\n\r]+\s*([A-Z][a-zA-Z]+(?:\s+[A-Z]\.?)?)\s*[\n\r]/i,
  );
  const lastNameVal = text.match(
    /(?:Last name)[\s\S]{0,10}?[\n\r]+\s*([A-Z][a-zA-Z]+)\s*[\n\r]/i,
  );
  if (firstNameVal && lastNameVal) {
    employee_name = `${firstNameVal[1].trim()} ${lastNameVal[1].trim()}`;
  } else if (firstNameVal) {
    employee_name = firstNameVal[1].trim();
  }

  // SSN — last 4 only
  const ssn_last_four = extractSsnLastFour(text);
  if (ssn_last_four) notes.push("SSN last 4 extracted (full SSN redacted)");

  // Address
  let address: string | null = null;
  const addrMatch = text.match(
    /(?:Address|Home address|Street address)[\s\S]{0,10}?[\n\r]+\s*(\d+[^\n\r]{5,80})/i,
  );
  if (addrMatch) address = addrMatch[1].trim();

  // Filing status
  let filing_status: W4Fields["filing_status"] = null;
  if (/(?:head of household|head_of_household)/i.test(text) && /\[?\s*[xX✓✗☑]\s*\]?/.test(text.match(/head of household[\s\S]{0,30}/i)?.[0] ?? "") || /head of household/i.test(text)) {
    // Check more specifically
  }
  if (/(?:single|Single or Married filing separately)[\s\S]{0,20}(?:\[?\s*[xX✓✗☑]\s*\]?|checked|✓)/i.test(text)) {
    filing_status = "single";
  } else if (/(?:Married filing jointly)[\s\S]{0,20}(?:\[?\s*[xX✓✗☑]\s*\]?|checked|✓)/i.test(text)) {
    filing_status = "married_filing_jointly";
  } else if (/(?:Head of household)[\s\S]{0,20}(?:\[?\s*[xX✓✗☑]\s*\]?|checked|✓)/i.test(text)) {
    filing_status = "head_of_household";
  }
  // Simpler: just look for the status keyword near a checkbox-like indicator
  if (!filing_status) {
    if (/filing status[\s\S]{0,100}head of household/i.test(text)) filing_status = "head_of_household";
    else if (/filing status[\s\S]{0,100}married filing jointly/i.test(text)) filing_status = "married_filing_jointly";
    else if (/filing status[\s\S]{0,100}single/i.test(text)) filing_status = "single";
  }

  // Multiple jobs (Step 2)
  let multiple_jobs: boolean | null = null;
  const step2Section = text.match(/Step\s+2[\s\S]{0,500}/i)?.[0] ?? "";
  if (/\[?\s*[xX✓☑]\s*\]?\s*(?:multiple jobs|two jobs)/i.test(step2Section)) {
    multiple_jobs = true;
  } else if (/Step\s+2/i.test(text)) {
    multiple_jobs = false; // Step 2 present but no checkbox marked
  }

  // Step 3 — dependents dollar amount
  let dependents_amount: number | null = null;
  const step3Match = text.match(/Step\s+3[\s\S]{0,300}/i)?.[0] ?? "";
  const depDollar = step3Match.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (depDollar) {
    dependents_amount = parseFloat(depDollar[1].replace(/,/g, ""));
  }

  // Step 4(c) — extra withholding
  let extra_withholding: number | null = null;
  // Look for "4(c)" or "Extra withholding" or "additional tax/amount" followed by a dollar amount
  const step4cMatch = text.match(/(?:\(\s*c\s*\)|Extra withholding|additional\s+(?:tax|amount))[\s\S]{0,80}?\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (step4cMatch) {
    extra_withholding = parseFloat(step4cMatch[1].replace(/,/g, ""));
  }

  // Exempt
  const exempt = /\bexempt\b[\s\S]{0,30}(?:\[?\s*[xX✓☑]\s*\]?|:\s*yes|true)/i.test(text)
    || /claim\s+exempt/i.test(text) && /\[?\s*[xX✓☑]\s*\]/i.test(text.match(/claim\s+exempt[\s\S]{0,50}/i)?.[0] ?? "");

  if (exempt) notes.push("Employee claims exempt status — must verify annually");

  // Signed date
  const signed_date = extractDate(
    text,
    /(?:signature|sign|date)[\s\S]{0,30}?(?:employee|sign)/i,
  ) ?? extractDate(text, /(?:Date\s*[:\s])[\s\S]{0,5}/i);

  // Employer EIN
  let employer_ein: string | null = null;
  const einMatch = text.match(/(?:EIN|Employer['']?s?\s+identification\s+number)[\s\S]{0,30}?(\d{2}[-\s]?\d{7})/i);
  if (einMatch) employer_ein = einMatch[1].replace(/\s/g, "");

  // Employer name — value on the line AFTER "Employer's name" header
  let employer_name: string | null = null;
  const empNameMatch = text.match(
    /(?:Employer[''\u2019]?s?\s+name(?:\s+and\s+address)?)[\s\S]*?[\n\r]+\s*([A-Z][^\n\r]{2,60})/i,
  );
  if (empNameMatch) {
    const candidate = empNameMatch[1].trim();
    // Don't match if we captured another label like "Employer identification"
    if (!/employer|identification|EIN|step/i.test(candidate)) {
      employer_name = candidate;
    }
  }

  const fields: W4Fields = {
    employee_name,
    ssn_last_four,
    address,
    filing_status,
    multiple_jobs,
    dependents_amount,
    extra_withholding,
    exempt,
    signed_date,
    employer_ein,
    employer_name,
  };

  const total_fields = Object.keys(fields).length;
  const field_count = countNonNull(fields as unknown as Record<string, unknown>);
  // exempt is boolean, always non-null — but false is still "extracted"
  const completeness = field_count / total_fields;

  return { fields, field_count, total_fields, completeness, extraction_notes: notes };
}

/* ----------------------------- I-9 Extractor -------------------------- */

export function extractI9Fields(text: string): ExtractionResult<I9Fields> {
  const notes: string[] = [];

  // Employee name — Section 1
  let employee_name: string | null = null;
  // Pattern 1: "Last Name: Xxx" and "First Name: Xxx" on separate lines
  const i9LastName = text.match(/(?:Last Name|Family Name)[:\s]+([A-Z][a-zA-Z]+)/i);
  const i9FirstName = text.match(/(?:First Name|Given Name)[:\s]+([A-Z][a-zA-Z]+)/i);
  if (i9FirstName && i9LastName) {
    employee_name = `${i9FirstName[1].trim()} ${i9LastName[1].trim()}`;
  } else if (i9LastName) {
    employee_name = i9LastName[1].trim();
  } else if (i9FirstName) {
    employee_name = i9FirstName[1].trim();
  }
  // Fallback: name on line after "Section 1" + "Employee Information"
  if (!employee_name) {
    const sec1Name = text.match(
      /Section\s+1[\s\S]{0,200}?[\n\r]+\s*([A-Z][a-z]+\s+[A-Z]\.?\s*[A-Z][a-z]+)/i,
    );
    if (sec1Name) employee_name = sec1Name[1].trim();
  }

  // Maiden name / Other last names used
  let maiden_name: string | null = null;
  const maidenMatch = text.match(
    /(?:Other (?:Last )?Names? Used|Maiden Name)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
  );
  if (maidenMatch && !/N\/?A/i.test(maidenMatch[1])) {
    maiden_name = maidenMatch[1].trim();
  }

  // Address — colon-separated on same line OR value on next line
  let address: string | null = null;
  const i9AddrInline = text.match(
    /(?:Address|Street Number and Name)[:\s]+(\d+[^\n\r]{5,80})/i,
  );
  if (i9AddrInline) {
    address = i9AddrInline[1].trim();
  } else {
    const i9AddrNextLine = text.match(
      /(?:Address|Street Number and Name)[\s\S]{0,10}?[\n\r]+\s*(\d+[^\n\r]{5,80})/i,
    );
    if (i9AddrNextLine) address = i9AddrNextLine[1].trim();
  }

  // Date of birth
  let date_of_birth: string | null = null;
  const dobMatch = text.match(
    /(?:Date of Birth|DOB|Birth Date)[\s:]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
  );
  if (dobMatch) date_of_birth = dobMatch[1];

  // SSN — last 4 only
  const ssn_last_four = extractSsnLastFour(text);
  if (ssn_last_four) notes.push("SSN last 4 extracted (full SSN redacted)");

  // Email
  let email: string | null = null;
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  if (emailMatch) email = emailMatch[0];

  // Phone
  let phone: string | null = null;
  const phoneMatch = text.match(
    /(?:Telephone|Phone|Tel)[:\s]*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/i,
  );
  if (phoneMatch) phone = `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}`;

  // Citizenship status
  let citizenship_status: I9Fields["citizenship_status"] = null;
  if (/(?:citizen of the United States|I am a citizen|A citizen)/i.test(text)) {
    citizenship_status = "citizen";
  } else if (/noncitizen national/i.test(text)) {
    citizenship_status = "noncitizen_national";
  } else if (/(?:lawful permanent resident|permanent resident)/i.test(text)) {
    citizenship_status = "permanent_resident";
  } else if (/(?:alien authorized to work|authorized to work|noncitizen.*authorized)/i.test(text)) {
    citizenship_status = "alien_authorized";
  }

  // USCIS / A-Number
  let uscis_number: string | null = null;
  const uscisMatch = text.match(/(?:USCIS|Alien|A)[-\s]?(?:Number|No\.?|#)[:\s]*([A-Z]?\d{7,9})/i);
  if (uscisMatch) uscis_number = uscisMatch[1];

  // I-94 Admission Number
  let i94_number: string | null = null;
  const i94Match = text.match(/(?:I-94|Admission)\s*(?:Number|No\.?|#)[:\s]*(\d{9,11})/i);
  if (i94Match) i94_number = i94Match[1];

  // Passport number
  let passport_number: string | null = null;
  const passMatch = text.match(/(?:Passport|Foreign Passport)\s*(?:Number|No\.?|#)[:\s]*([A-Z0-9]{5,12})/i);
  if (passMatch) passport_number = passMatch[1];

  // Signed date
  const signed_date = extractDate(text, /(?:Employee['']?s?\s+Signature|Signature of Employee|Date\s*\()/i)
    ?? extractDate(text, /(?:sign|date)[:\s]/i);

  // Preparer / Translator
  let preparer_used: boolean | null = null;
  if (/Preparer and\/or Translator/i.test(text)) {
    if (/(?:I did not use|did not use a preparer|Section 1 on my own)/i.test(text)) {
      preparer_used = false;
      notes.push("Employee self-attested (no preparer/translator)");
    } else if (/(?:preparer[\s\S]{0,40}name|translator[\s\S]{0,40}name|prepared by)/i.test(text)) {
      preparer_used = true;
      notes.push("Preparer/translator was used");
    } else {
      preparer_used = false;
    }
  }

  const fields: I9Fields = {
    employee_name,
    maiden_name,
    address,
    date_of_birth,
    ssn_last_four,
    email,
    phone,
    citizenship_status,
    uscis_number,
    i94_number,
    passport_number,
    signed_date,
    preparer_used,
  };

  const total_fields = Object.keys(fields).length;
  const field_count = countNonNull(fields as unknown as Record<string, unknown>);
  const completeness = field_count / total_fields;

  return { fields, field_count, total_fields, completeness, extraction_notes: notes };
}

/* ----------------------------- Dispatcher ----------------------------- */

export function extractFields(
  text: string,
  category: string,
): ExtractionResult<W4Fields | I9Fields> | null {
  if (category === "w4") return extractW4Fields(text);
  if (category === "i9") return extractI9Fields(text);
  return null;
}

/* ----------------------------- Insights ------------------------------- */

import type { HrInsight } from "@/lib/benefits";

export function generateFieldInsights(
  fields: W4Fields | I9Fields,
  category: "w4" | "i9",
  documentId: string,
): HrInsight[] {
  const insights: HrInsight[] = [];

  if (category === "w4") {
    const w4 = fields as W4Fields;

    if (w4.exempt) {
      insights.push({
        category: "compliance",
        severity: "attention",
        title: "W-4 filed with exempt status — verify annually",
        body: "Employee claimed exempt on their W-4. Per IRS rules, exempt status must be renewed each year by February 15. Set a reminder to collect an updated W-4 before the deadline.",
        related_id: documentId,
        source_rule: "w4_exempt_annual_verify",
      });
    }

    if (w4.extra_withholding !== null && w4.extra_withholding > 100) {
      insights.push({
        category: "compliance",
        severity: "attention",
        title: `W-4 has $${w4.extra_withholding} extra withholding — verify intent`,
        body: `Employee requested $${w4.extra_withholding} in additional tax withholding per pay period (Step 4c). This is above typical amounts. Verify the employee intended this and understands the impact on take-home pay.`,
        related_id: documentId,
        source_rule: "w4_high_extra_withholding",
      });
    }

    if (w4.dependents_amount !== null && w4.dependents_amount > 10000) {
      insights.push({
        category: "compliance",
        severity: "info",
        title: `W-4 claims $${w4.dependents_amount.toLocaleString()} in dependent credits`,
        body: `Employee claimed $${w4.dependents_amount.toLocaleString()} in Step 3 dependent credits. Large amounts reduce withholding significantly. Payroll should confirm this is intentional.`,
        related_id: documentId,
        source_rule: "w4_large_dependents",
      });
    }
  }

  if (category === "i9") {
    const i9 = fields as I9Fields;

    if (i9.preparer_used === false) {
      insights.push({
        category: "onboarding",
        severity: "info",
        title: "I-9 has no preparer — employee self-attested",
        body: "Employee completed Section 1 of the I-9 without a preparer or translator. This is the most common scenario and requires no additional action.",
        related_id: documentId,
        source_rule: "i9_no_preparer",
      });
    }

    if (i9.preparer_used === true) {
      insights.push({
        category: "onboarding",
        severity: "attention",
        title: "I-9 used a preparer/translator — verify certification",
        body: "A preparer or translator assisted with Section 1 of the I-9. Ensure the Preparer/Translator Certification section is complete and signed.",
        related_id: documentId,
        source_rule: "i9_preparer_used",
      });
    }

    if (i9.citizenship_status === "alien_authorized") {
      insights.push({
        category: "compliance",
        severity: "attention",
        title: "I-9 indicates work authorization — track expiration",
        body: "Employee indicated they are a noncitizen authorized to work. Work authorization may have an expiration date. Set a reminder to reverify before the authorization expires.",
        related_id: documentId,
        source_rule: "i9_alien_authorized_expiry",
      });
    }
  }

  return insights;
}
