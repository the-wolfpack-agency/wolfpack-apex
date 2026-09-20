/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ProbeIntelPanel } from "@/components/forcefield/ProbeIntelPanel";
import { PayloadIntelPanel } from "@/components/forcefield/PayloadIntelPanel";
import { GlowNode, SEVERITY_COLOR } from "@/components/forcefield/intel-visuals";

describe("ProbeIntelPanel", () => {
  const intel = [
    { label: "Cloud metadata endpoint (SSRF / credential theft)", cwe: "CWE-918", severity: "critical" as const, category: "ssrf", count: 2 },
    { label: "Admin surface probe", cwe: "CWE-200", severity: "medium" as const, category: "admin-surface", count: 5 },
  ];
  it("renders each probe with its label, CWE, plain-language severity, and count", () => {
    render(<ProbeIntelPanel intel={intel} />);
    const panel = screen.getByTestId("ff-probe-intel");
    expect(panel).toHaveTextContent("Cloud metadata endpoint (SSRF / credential theft)");
    expect(panel).toHaveTextContent("CWE-918");
    expect(panel).toHaveTextContent(/critical exposure/i);
    expect(screen.getByTestId("probe-intel-CWE-918")).toHaveTextContent("2");
  });
  it("renders nothing when empty", () => {
    const { container } = render(<ProbeIntelPanel intel={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PayloadIntelPanel", () => {
  it("humanizes the attack kind and marks it hostile", () => {
    render(<PayloadIntelPanel intel={[{ attack: "sql_injection", count: 3 }]} />);
    const panel = screen.getByTestId("ff-payload-intel");
    expect(panel).toHaveTextContent(/sql injection/i);
    expect(screen.getByTestId("payload-intel-sql_injection")).toHaveTextContent("3");
  });
  it("renders nothing when empty", () => {
    const { container } = render(<PayloadIntelPanel intel={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("shared visuals", () => {
  it("GlowNode pulses only when asked", () => {
    const { rerender, container } = render(<GlowNode color="#ef4444" pulse />);
    expect(container.querySelector(".ff-glow-node--pulse")).toBeInTheDocument();
    rerender(<GlowNode color="#ef4444" />);
    expect(container.querySelector(".ff-glow-node--pulse")).not.toBeInTheDocument();
  });
  it("uses one palette: critical/hostile are red, good is green", () => {
    expect(SEVERITY_COLOR.critical).toBe(SEVERITY_COLOR.hostile);
    expect(SEVERITY_COLOR.good).toBe("#30a46c");
  });
});
