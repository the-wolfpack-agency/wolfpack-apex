/** Forcefield-web alerting: dedupe (alert once per fingerprint) + dispatch shape. */
import { scanForcefieldWebAlerts, type ForcefieldAlertDeps, type HostileSignal } from "../alerts";

function deps(signals: HostileSignal[], seen = new Set<string>()): { deps: ForcefieldAlertDeps; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    deps: {
      listHostileSignals: async () => signals,
      insertAlert: async (kind, fingerprint) => { const k = `${kind}:${fingerprint}`; if (seen.has(k)) return false; seen.add(k); return true; },
      fanout: async (input) => { sent.push(input); },
    },
  };
}

it("dispatches once per new hostile signal, and fans out via the notifications layer", async () => {
  const sig: HostileSignal[] = [
    { kind: "honeytoken_trip", fp: "abc:python-requests", site: "weekendwithporsche", samplePath: "/_ff/records", count: 5 },
    { kind: "payload_attack", fp: "def:curl", site: "ogiam.com", samplePath: "/wp-login.php", count: 2 },
  ];
  const { deps: d, sent } = deps(sig);
  const r = await scanForcefieldWebAlerts(d);
  expect(r).toEqual({ detected: 2, dispatched: 2 });
  expect(sent).toHaveLength(2);
  expect((sent[0] as { analyticsEvent: string }).analyticsEvent).toBe("forcefield.web_alert_dispatched");
  expect((sent[0] as { category: string }).category).toBe("security");
});

it("does not re-alert an already-seen fingerprint (dedupe)", async () => {
  const sig: HostileSignal[] = [{ kind: "honeytoken_trip", fp: "abc", site: "s", samplePath: "/_ff", count: 1 }];
  const seen = new Set<string>();
  const first = deps(sig, seen);
  await scanForcefieldWebAlerts(first.deps);
  const second = deps(sig, seen);
  const r2 = await scanForcefieldWebAlerts(second.deps);
  expect(r2.dispatched).toBe(0);
  expect(second.sent).toHaveLength(0);
});
