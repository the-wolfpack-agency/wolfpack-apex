"use client";

/**
 * /people → /hr redirect. The People page was renamed to HR for
 * sidebar consistency. Any existing bookmark or in-app link still
 * lands on the right page without breaking.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PeopleRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/hr");
  }, [router]);
  return null;
}
