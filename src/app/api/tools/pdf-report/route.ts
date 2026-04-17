import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { execSync } from "child_process";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const LOCAL_ONLY_MSG =
  "This tool requires the local development server with Python and Vibium installed. Run 'npm run dev' on your machine.";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const outPath = join(tmpdir(), `instinct-report-${Date.now()}.pdf`);

  try {
    execSync(
      `python3 -c "
from agenticqa.client.pdf_exporter import PDFExporter
e = PDFExporter()
e.export_security_report('${outPath}')
"`,
      {
        timeout: 60_000,
        env: {
          ...process.env,
          PYTHONPATH: join(process.cwd(), "..", "AgenticQA", "src"),
        },
      },
    );

    if (!existsSync(outPath)) {
      trackEvent("tools.pdf_generated", user.id, user.role, { success: false });
      return NextResponse.json(
        { error: "Report generation completed but no file was produced" },
        { status: 500 },
      );
    }

    const pdf = readFileSync(outPath);
    unlinkSync(outPath);

    trackEvent("tools.pdf_generated", user.id, user.role, { success: true, bytes: pdf.length });

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="instinct-security-report.pdf"',
      },
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Python not available (Vercel) or Vibium not installed
    if (
      msg.includes("ENOENT") ||
      msg.includes("python3") ||
      msg.includes("ModuleNotFoundError") ||
      msg.includes("No such file")
    ) {
      return NextResponse.json({ available: false, message: LOCAL_ONLY_MSG });
    }

    trackEvent("tools.pdf_generated", user.id, user.role, { success: false, error: msg.slice(0, 200) });
    return NextResponse.json(
      { error: "Report generation failed", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
