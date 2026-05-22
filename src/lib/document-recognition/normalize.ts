/**
 * Document Recognition — normalization helpers.
 *
 * Pure functions that map Azure Document Intelligence's `DocumentField`
 * shape into our canonical `ExtractedField` and bundle an
 * `ExtractedDocument`. No I/O. No env reads. Trivially testable.
 *
 * Azure's prebuilt models each return a slightly different field
 * schema (Receipt has `MerchantName`, Invoice has `VendorName`, W-2
 * has `Employee_Name`, etc.). Rather than tax every extractor with
 * its own ExtractedField mapper, we centralize the value-extraction
 * here so every Azure prebuilt model produces `ExtractedField[]` the
 * same way.
 */

import type { ExtractedDocument, ExtractedField, ExtractorKey } from "./types";

/**
 * The Azure DocumentField shape. Mirrors the private type in
 * src/lib/azure/form-recognizer.ts. Exported here so extractors that
 * already typed their responses can pass them straight through.
 */
export interface AzureDocumentField {
  type?: string;
  valueString?: string;
  valueNumber?: number;
  valueInteger?: number;
  valueDate?: string;
  valueTime?: string;
  valueBoolean?: boolean;
  valueCurrency?: { amount?: number; currencyCode?: string };
  valueAddress?: Record<string, unknown> & { streetAddress?: string };
  content?: string;
  confidence?: number;
  valueArray?: AzureDocumentField[];
  valueObject?: Record<string, AzureDocumentField>;
}

/**
 * Pick the best human-readable string from an Azure DocumentField.
 * Preference order is: valueString > content > stringified primitive.
 * Currency is rendered as "<amount> <code>" so downstream code can
 * keep parsing simple. Date / time stay ISO. Returns empty string if
 * the field carries no representable value (caller decides whether
 * to omit it from the output array).
 */
export function azureFieldToString(field: AzureDocumentField | undefined): string {
  if (!field) return "";
  if (typeof field.valueString === "string" && field.valueString.length > 0) {
    return field.valueString;
  }
  if (typeof field.valueDate === "string" && field.valueDate.length > 0) {
    return field.valueDate;
  }
  if (typeof field.valueTime === "string" && field.valueTime.length > 0) {
    return field.valueTime;
  }
  if (typeof field.valueNumber === "number") return String(field.valueNumber);
  if (typeof field.valueInteger === "number") return String(field.valueInteger);
  if (typeof field.valueBoolean === "boolean") return String(field.valueBoolean);
  if (field.valueCurrency && typeof field.valueCurrency.amount === "number") {
    const code = field.valueCurrency.currencyCode ?? "";
    return code ? `${field.valueCurrency.amount} ${code}` : String(field.valueCurrency.amount);
  }
  if (field.valueAddress && typeof field.valueAddress.streetAddress === "string") {
    return String(field.valueAddress.streetAddress);
  }
  if (typeof field.content === "string" && field.content.length > 0) return field.content;
  return "";
}

/**
 * Extract the most-specific native value from an Azure DocumentField.
 * Preserves the original primitive (number / boolean / null) rather
 * than stringifying, so downstream consumers that need a number for
 * math don't have to re-parse. Returns null when the field has no
 * representable value.
 */
export function azureFieldToRaw(
  field: AzureDocumentField | undefined,
): string | number | boolean | null {
  if (!field) return null;
  if (typeof field.valueNumber === "number") return field.valueNumber;
  if (typeof field.valueInteger === "number") return field.valueInteger;
  if (typeof field.valueBoolean === "boolean") return field.valueBoolean;
  if (field.valueCurrency && typeof field.valueCurrency.amount === "number") {
    return field.valueCurrency.amount;
  }
  if (typeof field.valueString === "string" && field.valueString.length > 0) {
    return field.valueString;
  }
  if (typeof field.valueDate === "string") return field.valueDate;
  if (typeof field.valueTime === "string") return field.valueTime;
  if (typeof field.content === "string" && field.content.length > 0) return field.content;
  return null;
}

/**
 * Map a single Azure DocumentField into an `ExtractedField`. The
 * canonical name is passed in by the caller — extractor-specific
 * mappers know which Azure key maps to which canonical name.
 */
export function azureDocumentFieldToExtractedField(
  name: string,
  field: AzureDocumentField,
): ExtractedField {
  const value = azureFieldToString(field);
  const rawValue = azureFieldToRaw(field);
  return {
    name,
    value,
    rawValue,
    confidence: typeof field.confidence === "number" ? field.confidence : 0,
  };
}

/**
 * Convert an entire Azure fields-object into ExtractedField[]. Skips
 * fields with neither a value nor a raw value so the output array
 * doesn't carry empty entries.
 */
export function azureFieldsToExtractedFields(
  fields: Record<string, AzureDocumentField> | undefined,
): ExtractedField[] {
  if (!fields) return [];
  const out: ExtractedField[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (!field) continue;
    const ef = azureDocumentFieldToExtractedField(name, field);
    if (ef.value === "" && ef.rawValue === null) continue;
    out.push(ef);
  }
  return out;
}

/**
 * Build a fully-formed ExtractedDocument. Centralized so the router
 * doesn't have to know the field order or remember to zero-default
 * costCents on a free-tier call.
 */
export function buildExtractedDocument(args: {
  extractor: ExtractorKey;
  model: string;
  fields: ExtractedField[];
  rawText: string;
  latencyMs: number;
  costCents: number;
}): ExtractedDocument {
  return {
    extractor: args.extractor,
    model: args.model,
    fields: args.fields,
    rawText: args.rawText,
    latencyMs: args.latencyMs,
    costCents: args.costCents,
  };
}
