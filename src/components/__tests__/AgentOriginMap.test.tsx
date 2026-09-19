/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AgentOriginMap } from "@/components/AgentOriginMap";

const origins = [
  { country: "US", total: 40, welcomed: 6, welcomedVerified: 0, flagged: 20, hostile: 14 },
  { country: "DE", total: 12, welcomed: 2, welcomedVerified: 2, flagged: 10, hostile: 0 },
  { country: "ZZ", total: 3, welcomed: 0, welcomedVerified: 0, flagged: 0, hostile: 3 }, // no centroid
];

describe("AgentOriginMap", () => {
  it("renders a node for countries with a centroid and lists all origins with exact counts", () => {
    render(<AgentOriginMap origins={origins} />);
    expect(screen.getByTestId("agent-origin-map")).toBeInTheDocument();
    // US + DE have centroids -> map nodes; ZZ has none -> no node but still listed.
    expect(screen.getByTestId("origin-node-US")).toBeInTheDocument();
    expect(screen.getByTestId("origin-node-DE")).toBeInTheDocument();
    expect(screen.queryByTestId("origin-node-ZZ")).not.toBeInTheDocument();
    const list = screen.getByTestId("agent-origin-list");
    expect(list).toHaveTextContent("US");
    expect(list).toHaveTextContent("ZZ"); // uncharted origin still surfaced
    expect(list).toHaveTextContent("14 hostile");
  });

  it("states the honest network-origin caveat, not a confirmed operator location", () => {
    render(<AgentOriginMap origins={origins} />);
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/network origin/i);
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/not a confirmed operator location/i);
  });

  it("renders an explicit empty state with no origins", () => {
    render(<AgentOriginMap origins={[]} />);
    expect(screen.getByTestId("agent-origin-map-empty")).toBeInTheDocument();
  });

  it("does not grant trusted-green to a UA-claimed but unverified welcome (only Web-Bot-Auth-verified)", () => {
    render(<AgentOriginMap origins={[{ country: "CN", total: 18, welcomed: 18, welcomedVerified: 0, flagged: 0, hostile: 0 }]} />);
    // CN is welcomed-by-UA but 0 verified -> its node is the unverified amber, not green.
    const node = screen.getByTestId("origin-node-CN");
    const dot = node.querySelector("circle:last-of-type") as SVGCircleElement;
    expect(dot.getAttribute("fill")).toBe("#f5a623"); // amber, not #30a46c green
    // legend now names the honest categories.
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/verified good agent/i);
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/unverified/i);
  });

  it("grants green only when verified welcomes dominate", () => {
    render(<AgentOriginMap origins={[{ country: "US", total: 10, welcomed: 8, welcomedVerified: 8, flagged: 1, hostile: 0 }]} />);
    const dot = screen.getByTestId("origin-node-US").querySelector("circle:last-of-type") as SVGCircleElement;
    expect(dot.getAttribute("fill")).toBe("#30a46c"); // verified-dominant -> green
  });
});
