-- Datacenter/cloud IPv4 prefixes for hosting classification, distributed to every
-- site via the central ruleset (the united rollout: one refresh -> all sites get
-- the full, current coverage, no re-vendor). Stored compactly as "base/bits"
-- (uint32 network + prefix length). Refreshed weekly from the providers' own
-- published lists.
CREATE TABLE IF NOT EXISTS instinct_datacenter_prefixes (
  prefix       TEXT PRIMARY KEY,       -- "base/bits" (uint32/prefixlen)
  provider     TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datacenter_prefixes_refreshed ON instinct_datacenter_prefixes (refreshed_at);
