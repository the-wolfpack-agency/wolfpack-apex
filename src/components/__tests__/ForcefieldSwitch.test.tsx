/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ForcefieldSwitch } from "@/components/ForcefieldSwitch";

const agents = [
  { operatorKey: "op_cf802f5b", action: "block" as const },
  { operatorKey: "op_ad845d19", action: "challenge" as const },
];

describe("ForcefieldSwitch", () => {
  it("reads MONITORING and names the agents it would stop when off", () => {
    render(<ForcefieldSwitch mode="monitor" canManage onToggle={jest.fn()} standbyAgents={agents} />);
    expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/monitoring/i);
    expect(screen.getByTestId("edge-policy")).toHaveTextContent(/nothing is blocked/i);
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/2 hostile agents.*turn this on/i);
    // the specific agents are named, not just counted
    expect(screen.getByTestId("forcefield-agent-op_cf802f5b")).toHaveTextContent(/op_cf802f5b/);
    expect(screen.getByTestId("forcefield-agent-op_cf802f5b")).toHaveTextContent(/block/i);
    expect(screen.getByTestId("forcefield-agent-op_ad845d19")).toHaveTextContent(/challenge/i);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("reads PROTECTING and shows the agents it is guarding against when on", () => {
    render(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} standbyAgents={agents} />);
    expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/protecting/i);
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/guarding against 2 hostile agents/i);
    expect(screen.getByTestId("forcefield-agent-op_cf802f5b")).toBeInTheDocument();
  });

  it("caps the named list and shows a +N more", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ operatorKey: `op_${i}`, action: "block" as const }));
    render(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} standbyAgents={many} />);
    expect(screen.getByTestId("forcefield-standby-agents")).toHaveTextContent(/\+2 more/);
  });

  it("toggles monitor -> enforce on click", () => {
    const onToggle = jest.fn();
    render(<ForcefieldSwitch mode="monitor" canManage onToggle={onToggle} standbyAgents={[]} />);
    fireEvent.click(screen.getByTestId("edge-policy-toggle"));
    expect(onToggle).toHaveBeenCalledWith("enforce");
  });

  it("is disabled and does not toggle for a viewer who cannot manage", () => {
    const onToggle = jest.fn();
    render(<ForcefieldSwitch mode="monitor" canManage={false} onToggle={onToggle} standbyAgents={agents} />);
    const sw = screen.getByTestId("edge-policy-toggle");
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("says all clear and lists no agents when nothing hostile is in range", () => {
    render(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} standbyAgents={[]} />);
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/all clear/i);
    expect(screen.queryByTestId("forcefield-standby-agents")).not.toBeInTheDocument();
  });
});

describe("ForcefieldSwitch - auto-block toggle", () => {
  it("shows the auto-block control only when protecting, and toggles it", () => {
    const onAutoBlockToggle = jest.fn();
    const { rerender } = render(<ForcefieldSwitch mode="monitor" canManage onToggle={jest.fn()} standbyAgents={[]} autoBlock={false} onAutoBlockToggle={onAutoBlockToggle} />);
    // monitor: no auto-block control (nothing is blocked in shadow mode)
    expect(screen.queryByTestId("forcefield-autoblock")).not.toBeInTheDocument();
    // enforce: the control appears
    rerender(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} standbyAgents={[]} autoBlock={false} onAutoBlockToggle={onAutoBlockToggle} />);
    fireEvent.click(screen.getByTestId("forcefield-autoblock-toggle"));
    expect(onAutoBlockToggle).toHaveBeenCalledWith(true);
  });
  it("disables the auto-block toggle for a viewer who cannot manage", () => {
    const onAutoBlockToggle = jest.fn();
    render(<ForcefieldSwitch mode="enforce" canManage={false} onToggle={jest.fn()} standbyAgents={[]} autoBlock onAutoBlockToggle={onAutoBlockToggle} />);
    const t = screen.getByTestId("forcefield-autoblock-toggle");
    expect(t).toBeDisabled();
    fireEvent.click(t);
    expect(onAutoBlockToggle).not.toHaveBeenCalled();
  });
});
