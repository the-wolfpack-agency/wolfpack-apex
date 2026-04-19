"use client";

/**
 * AssetLibraryPicker — per-client asset-library picker (Path C Phase 1,
 * Stream P3). Used on the site edit page to let designers pick an
 * already-uploaded logo / hero photo / product shot instead of
 * re-uploading.
 *
 * Props:
 *   - clientSlug: whose library to load
 *   - onPick(asset): fired when the designer clicks a thumbnail
 *   - kindFilter: initial kind to filter by (optional)
 *
 * Contract: every API call uses `fetchWithRefresh` so 401s rotate the
 * JWT instead of silently blanking the UI (CLAUDE.md April-16 rule).
 * The filter + search are purely client-side once the list is loaded;
 * for a real client with hundreds of assets we'd push filter/search to
 * the server, but at v1 this keeps the picker instant.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export type AssetKind = "logo" | "photo" | "illustration" | "icon" | "other";

export interface ClientAssetView {
  id: string;
  clientSlug: string;
  assetKind: AssetKind;
  filename: string;
  url: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  altText: string | null;
  useCount: number;
  lastUsedAt: string | null;
  uploadedAt: string;
}

interface Props {
  clientSlug: string;
  onPick: (asset: ClientAssetView) => void;
  kindFilter?: AssetKind;
  /** Optional — when present, upload fires into this kind. */
  defaultUploadKind?: AssetKind;
}

const KINDS: AssetKind[] = ["logo", "photo", "illustration", "icon", "other"];

export default function AssetLibraryPicker({
  clientSlug,
  onPick,
  kindFilter,
  defaultUploadKind = "photo",
}: Props) {
  const [assets, setAssets] = useState<ClientAssetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [kind, setKind] = useState<AssetKind | "all">(kindFilter ?? "all");
  const [search, setSearch] = useState("");
  const [uploadKind, setUploadKind] = useState<AssetKind>(defaultUploadKind);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = kind !== "all" ? `?kind=${encodeURIComponent(kind)}` : "";
      const r = await fetchWithRefresh(
        `/api/clients/${encodeURIComponent(clientSlug)}/assets${qs}`,
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? `Failed to load assets (HTTP ${r.status}).`);
        setAssets([]);
      } else {
        setAssets((data.assets ?? []) as ClientAssetView[]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [clientSlug, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => a.filename.toLowerCase().includes(q));
  }, [assets, search]);

  async function handleFileSelect(file: File) {
    if (!file) return;
    setUploading(true);
    setError(null);
    setMessage(null);
    try {
      const base64 = await fileToBase64(file);
      const r = await fetchWithRefresh(
        `/api/clients/${encodeURIComponent(clientSlug)}/assets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            content_base64: base64,
            mime: file.type,
            kind: uploadKind,
          }),
        },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? `Upload failed (HTTP ${r.status}).`);
      } else {
        setMessage(
          data.asset?.useCount > 1
            ? `Already in library — reused ${data.asset.filename}.`
            : `Uploaded ${data.asset?.filename ?? file.name}.`,
        );
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(asset: ClientAssetView) {
    if (!confirm(`Delete ${asset.filename}?\n\nSoft-delete — sites already using this asset won't break, but it won't appear in the picker anymore.`)) return;
    setBusyAssetId(asset.id);
    setError(null);
    try {
      const r = await fetchWithRefresh(
        `/api/clients/${encodeURIComponent(clientSlug)}/assets/${encodeURIComponent(asset.id)}`,
        { method: "DELETE" },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? `Delete failed (HTTP ${r.status}).`);
      } else {
        setMessage(`${asset.filename} removed.`);
        setAssets((prev) => prev.filter((a) => a.id !== asset.id));
      }
    } finally {
      setBusyAssetId(null);
    }
  }

  return (
    <section data-testid="asset-library-picker" style={wrapperStyle}>
      <header style={headerStyle}>
        <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Client asset library</h3>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
          Logos, hero photos, and product shots uploaded once per client. Pick any to drop it into the site.
        </p>
      </header>

      <div style={toolbarStyle}>
        <label style={labelStyle}>
          <span style={srOnly}>Filter by kind</span>
          <select
            data-testid="asset-kind-filter"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind | "all")}
            style={selectStyle}
          >
            <option value="all">All kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, flex: "1 1 160px" }}>
          <span style={srOnly}>Search by filename</span>
          <input
            data-testid="asset-search"
            type="search"
            placeholder="Search filename…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={srOnly}>Upload kind</span>
          <select
            data-testid="asset-upload-kind"
            value={uploadKind}
            onChange={(e) => setUploadKind(e.target.value as AssetKind)}
            style={selectStyle}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                Upload as {k}
              </option>
            ))}
          </select>
        </label>
        <label
          data-testid="asset-upload-label"
          style={{
            ...buttonStyle(),
            display: "inline-flex",
            alignItems: "center",
            cursor: uploading ? "wait" : "pointer",
          }}
        >
          {uploading ? "Uploading…" : "Upload file"}
          <input
            data-testid="asset-upload-input"
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFileSelect(f);
              e.target.value = "";
            }}
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
          />
        </label>
      </div>

      {error && (
        <div data-testid="asset-error" role="alert" style={errorStyle}>
          {error}
        </div>
      )}
      {message && (
        <div data-testid="asset-message" role="status" style={messageStyle}>
          {message}
        </div>
      )}

      {loading ? (
        <div data-testid="asset-loading" style={{ fontSize: "0.82rem", color: "var(--wp-text-dim)" }}>
          Loading assets…
        </div>
      ) : filtered.length === 0 ? (
        <div data-testid="asset-empty-state" role="status" style={emptyStateStyle}>
          {assets.length === 0
            ? "No assets yet — upload a logo or hero photo to start the library."
            : "No assets match your filter."}
        </div>
      ) : (
        <ul data-testid="asset-grid" style={gridStyle}>
          {filtered.map((a) => (
            <li
              key={a.id}
              data-testid={`asset-card-${a.id}`}
              style={cardStyle}
            >
              <button
                type="button"
                data-testid={`asset-pick-${a.id}`}
                onClick={() => onPick(a)}
                style={pickButtonStyle}
                aria-label={`Use ${a.filename}`}
              >
                {a.mime.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.url}
                    alt={a.altText ?? a.filename}
                    style={thumbStyle}
                    loading="lazy"
                  />
                ) : (
                  <div style={{ ...thumbStyle, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--wp-text-dim)" }}>
                    {a.mime}
                  </div>
                )}
                <div style={cardMetaStyle}>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.filename}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)", display: "flex", gap: 6 }}>
                    <span data-testid={`asset-kind-${a.id}`}>{a.assetKind}</span>
                    <span data-testid={`asset-use-count-${a.id}`} style={badgeStyle}>
                      used {a.useCount}×
                    </span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                data-testid={`asset-delete-${a.id}`}
                onClick={() => void handleDelete(a)}
                disabled={busyAssetId === a.id}
                aria-label={`Delete ${a.filename}`}
                style={deleteButtonStyle}
              >
                {busyAssetId === a.id ? "…" : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Use Uint8Array → base64. Works in all modern browsers + jsdom.
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

// ----- styles -----
const wrapperStyle: React.CSSProperties = {
  padding: "1rem",
  background: "var(--wp-card)",
  border: "1px solid var(--wp-border)",
  borderRadius: "8px",
  color: "var(--wp-text)",
};
const headerStyle: React.CSSProperties = { marginBottom: "0.75rem" };
const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
  marginBottom: "0.75rem",
  alignItems: "center",
};
const labelStyle: React.CSSProperties = { position: "relative" };
const selectStyle: React.CSSProperties = {
  padding: "0.45rem 0.65rem",
  background: "var(--wp-dark, #1b1b1b)",
  color: "var(--wp-text)",
  border: "1px solid var(--wp-border)",
  borderRadius: "6px",
  fontSize: "0.82rem",
};
const inputStyle: React.CSSProperties = {
  ...selectStyle,
  minWidth: 180,
};
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};
const errorStyle: React.CSSProperties = {
  padding: "0.6rem 0.8rem",
  marginBottom: "0.6rem",
  background: "rgba(220, 80, 80, 0.08)",
  border: "1px solid rgba(220, 80, 80, 0.4)",
  color: "#e07070",
  borderRadius: "6px",
  fontSize: "0.82rem",
};
const messageStyle: React.CSSProperties = {
  padding: "0.6rem 0.8rem",
  marginBottom: "0.6rem",
  background: "rgba(80, 200, 120, 0.08)",
  border: "1px solid rgba(80, 200, 120, 0.4)",
  color: "var(--wp-success, #6dcf85)",
  borderRadius: "6px",
  fontSize: "0.82rem",
};
const emptyStateStyle: React.CSSProperties = {
  padding: "0.9rem 1rem",
  background: "rgba(80, 140, 220, 0.06)",
  border: "1px dashed var(--wp-border)",
  borderRadius: "6px",
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
};
const gridStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: "0.75rem",
};
const cardStyle: React.CSSProperties = {
  position: "relative",
  background: "var(--wp-dark, #1b1b1b)",
  border: "1px solid var(--wp-border)",
  borderRadius: "6px",
  overflow: "hidden",
};
const pickButtonStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: 0,
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  color: "inherit",
};
const thumbStyle: React.CSSProperties = {
  width: "100%",
  height: 120,
  objectFit: "cover",
  display: "block",
  background: "var(--wp-card, #2a2a2a)",
};
const cardMetaStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};
const badgeStyle: React.CSSProperties = {
  padding: "0.05rem 0.4rem",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid var(--wp-border)",
  borderRadius: "999px",
  fontSize: "0.65rem",
};
const deleteButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 6,
  width: 24,
  height: 24,
  padding: 0,
  background: "rgba(0,0,0,0.55)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: "999px",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: "20px",
};

function buttonStyle(): React.CSSProperties {
  return {
    padding: "0.45rem 0.85rem",
    background: "var(--wp-gold, #e6b84d)",
    color: "var(--wp-dark, #1b1b1b)",
    border: "1px solid var(--wp-border)",
    borderRadius: "6px",
    fontWeight: 600,
    fontSize: "0.82rem",
    position: "relative",
  };
}
