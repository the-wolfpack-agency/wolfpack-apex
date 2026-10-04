"use client";
/**
 * /admin/ai-code/factory - the chat-centric Code Factory surface. Coexists with the
 * classic dashboard at /admin/ai-code while it matures; designed as a self-contained
 * module (src/components/ai-code/factory-chat/*) so it lifts cleanly into the
 * standalone Code Factory repo. Auth-redirects an unauthenticated visitor, never a
 * blank page.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser } from "@/lib/client-auth";
import FactoryChat from "@/components/ai-code/factory-chat/FactoryChat";
import { NEON, BRAND_BACKGROUND } from "@/components/ai-code/factory-chat/neon";

export default function CodeFactoryChatPage(): React.ReactElement | null {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/ai-code/factory");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: BRAND_BACKGROUND,
        backgroundAttachment: "fixed",
        color: NEON.text,
        fontFamily: NEON.fontSans,
        padding: "2rem 1rem 3rem",
      }}
    >
      <FactoryChat defaultRepo="the-wolfpack-agency/wolfpack-apex" />
    </main>
  );
}
