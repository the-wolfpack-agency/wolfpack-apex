/**
 * dark_data: "what's in the legacy database that nobody uses?"
 *
 * The question a client cannot answer about their own system, because
 * answering it means holding the schema and every statement the system
 * has run in one place, and nobody has ever had both halves at once.
 *
 * Reads catalog and planner statistics only. No row of anybody's data
 * is touched, which is what makes it a question we are allowed to ask
 * of a production database at all.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { findDarkData, renderDarkData } from "@/lib/insights/dark-data";
import {
  legacyDatabaseName,
  scanLegacyDatabase,
} from "@/lib/sources/legacy-postgres";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface DarkDataToolData {
  darkColumns: number;
  statementsExamined: number;
  excludedTables: number;
}

const INTENT_RE =
  /\bwhat(?:'s| is|s)?\s+(?:in\s+)?(?:the\s+)?(?:legacy\s+)?(?:database|db|system)\s+(?:that\s+)?(?:nobody|no\s+one|we\s+don'?t|noone)\s+(?:uses?|reads?|touches?|looks?\s+at)\b|\b(?:dark|unused|unread|forgotten)\s+(?:data|columns?|fields?)\b|\bwhat\s+(?:data\s+)?are\s+we\s+not\s+using\b|\bwhat\s+(?:else\s+)?is\s+(?:in\s+)?there\s+that\s+(?:we|nobody)\s+(?:have\s+)?never\s+(?:used|looked\s+at|asked\s+for)\b/i;

function matchIntent(message: string): Params | null {
  return INTENT_RE.test(message.trim()) ? {} : null;
}

export const darkDataTool: ToolDef<Params, DarkDataToolData> = {
  name: "dark_data",
  description:
    "Diff a connected legacy database's schema against every statement it has run, to find populated columns no query names. Catalog and planner statistics only; reads no rows.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent,
  async handler(_params, ctx): Promise<ToolResult<DarkDataToolData>> {
    let scan: Awaited<ReturnType<typeof scanLegacyDatabase>>;
    try {
      scan = await scanLegacyDatabase();
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `Could not read ${legacyDatabaseName()}: ${(err as Error)?.message ?? "unknown error"}`,
      };
    }

    if (!scan) {
      return {
        ok: true,
        data: { darkColumns: 0, statementsExamined: 0, excludedTables: 0 },
        answer:
          "No legacy database is connected yet. Once one is, this compares its schema against every statement it has run and reports the populated columns nothing reads.",
      };
    }

    const report = findDarkData(scan);

    /* Counts only. Column names are the client's schema, which is
       theirs to see and not ours to accumulate. */
    trackEvent("assistant.dark_data_scanned", ctx.userId, ctx.userRole, {
      dark_columns: report.dark.length,
      statements_examined: report.statementsExamined,
      excluded_star_tables: report.starSelectTables.length,
      unanalyzed_columns: report.unanalyzed,
    });

    return {
      ok: true,
      data: {
        darkColumns: report.dark.length,
        statementsExamined: report.statementsExamined,
        excludedTables: report.starSelectTables.length,
      },
      answer: renderDarkData(report, legacyDatabaseName()),
    };
  },
};

registerTool(darkDataTool);
