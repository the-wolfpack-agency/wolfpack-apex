/** @jest-environment node */
import { ipv4ToInt, parseCidr, ipInPrefix, classifyHosting } from "../datacenter-ranges";

describe("ipv4ToInt", () => {
  it("parses dotted-quad and rejects junk / out-of-range / IPv6", () => {
    expect(ipv4ToInt("0.0.0.0")).toBe(0);
    expect(ipv4ToInt("255.255.255.255")).toBe(0xffffffff);
    expect(ipv4ToInt("34.64.4.1")).toBe(((34 << 24) | (64 << 16) | (4 << 8) | 1) >>> 0);
    expect(ipv4ToInt("256.0.0.1")).toBeNull();
    expect(ipv4ToInt("not-an-ip")).toBeNull();
    expect(ipv4ToInt("2001:db8::1")).toBeNull();
  });
});

describe("parseCidr + ipInPrefix", () => {
  it("normalizes a CIDR and matches addresses inside it", () => {
    const p = parseCidr("34.64.0.0/10", "gcp")!;
    expect(p.bits).toBe(10);
    expect(ipInPrefix(ipv4ToInt("34.64.4.1")!, p)).toBe(true);
    expect(ipInPrefix(ipv4ToInt("34.128.0.1")!, p)).toBe(false);
  });
  it("rejects malformed CIDRs", () => {
    expect(parseCidr("nope/8")).toBeNull();
    expect(parseCidr("1.2.3.4/40")).toBeNull();
  });
});

describe("classifyHosting", () => {
  const prefixes = [parseCidr("52.94.0.0/16", "aws")!, parseCidr("34.64.0.0/10", "gcp")!];
  it("labels an IP inside a datacenter prefix as datacenter", () => {
    expect(classifyHosting("52.94.236.248", prefixes)).toBe("datacenter");
    expect(classifyHosting("34.64.4.1", prefixes)).toBe("datacenter");
  });
  it("labels a valid IP outside every prefix as residential", () => {
    expect(classifyHosting("24.60.1.1", prefixes)).toBe("residential");
  });
  it("never guesses: missing / malformed / IPv6 is unknown", () => {
    expect(classifyHosting(null, prefixes)).toBe("unknown");
    expect(classifyHosting("garbage", prefixes)).toBe("unknown");
    expect(classifyHosting("2001:db8::1", prefixes)).toBe("unknown");
  });
});
