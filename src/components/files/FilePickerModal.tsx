"use client";

/**
 * FilePickerModal — browse OneDrive, pick items, search, breadcrumbs,
 * upload-new. Backed by /api/files, /api/files/upload, /api/files/upload-session.
 *
 * Props:
 *   open         — controls visibility.
 *   onClose()    — fires on dismiss.
 *   onPick(item) — fires when user picks an item. Parent decides what to do next.
 *   allowUpload  — shows the upload button.
 *   rootLabel    — breadcrumb label for root (default "OneDrive").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

export interface PickerDriveItem {
  id: string;
  msDriveItemId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  parentPath: string | null;
  modifiedAt: string | null;
  isFolder: boolean;
}

interface Breadcrumb {
  id: string | null; // null = root
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (item: PickerDriveItem) => void;
  allowUpload?: boolean;
  rootLabel?: string;
}

function formatSize(n: number | null): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function FilePickerModal({ open, onClose, onPick, allowUpload = true, rootLabel = "OneDrive" }: Props) {
  const [items, setItems] = useState<PickerDriveItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Breadcrumb[]>([{ id: null, label: rootLabel }]);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentFolderId = crumbs[crumbs.length - 1].id;

  const load = useCallback(async (parentId: string | null, searchTerm?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (parentId) params.set("parentId", parentId);
      if (searchTerm) params.set("search", searchTerm);
      params.set("limit", "100");
      const res = await fetchWithRefresh(`/api/files?${params.toString()}`, { headers: authHeaders() });
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        setError(data.scope ? `Missing Microsoft permission: ${data.scope}` : "Permission denied");
        setItems([]);
        return;
      }
      if (!res.ok) {
        setError("Failed to load files");
        setItems([]);
        return;
      }
      const data = (await res.json()) as { items?: PickerDriveItem[] };
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setError("Network error");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load(currentFolderId);
  }, [open, currentFolderId, load]);

  const handleRowClick = (item: PickerDriveItem) => {
    if (item.isFolder) {
      setCrumbs([...crumbs, { id: item.msDriveItemId, label: item.name }]);
    } else {
      onPick(item);
    }
  };

  const handleBreadcrumb = (idx: number) => {
    setCrumbs(crumbs.slice(0, idx + 1));
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    load(currentFolderId, search || undefined);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const SMALL = 4 * 1024 * 1024;
      if (file.size <= SMALL) {
        const form = new FormData();
        form.append("file", file);
        form.append("parentId", currentFolderId ?? "root");
        form.append("filename", file.name);
        const res = await fetchWithRefresh("/api/files/upload", {
          method: "POST",
          headers: authHeaders(),
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Upload failed");
          return;
        }
      } else {
        // Large file — upload session path (client PUTs chunks directly to Graph)
        const sessionRes = await fetchWithRefresh("/api/files/upload-session", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ parentId: currentFolderId ?? "root", filename: file.name }),
        });
        if (!sessionRes.ok) {
          const data = await sessionRes.json().catch(() => ({}));
          setError(data.error ?? "Could not start upload session");
          return;
        }
        const session = (await sessionRes.json()) as { uploadUrl: string };
        await chunkUploadToGraph(session.uploadUrl, file);
      }
      await load(currentFolderId);
    } catch (err) {
      setError((err as Error).message ?? "Upload error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="File picker"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 8, width: "min(720px, 92vw)",
          maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        <div style={{ padding: 16, borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, flex: 1 }}>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  type="button"
                  onClick={() => handleBreadcrumb(i)}
                  style={{ background: "transparent", border: 0, color: "#2563eb", cursor: "pointer", padding: 0 }}
                >
                  {c.label}
                </button>
                {i < crumbs.length - 1 && <span aria-hidden="true">/</span>}
              </span>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 20, cursor: "pointer" }}
          >×</button>
        </div>

        <form onSubmit={handleSearchSubmit} style={{ padding: 12, borderBottom: "1px solid #e5e7eb", display: "flex", gap: 8 }}>
          <input
            aria-label="Search files"
            type="search"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, padding: 8, border: "1px solid #d1d5db", borderRadius: 6 }}
          />
          <button type="submit" style={{ padding: "8px 12px" }}>Search</button>
          {allowUpload && (
            <>
              <input ref={fileInputRef} type="file" onChange={handleUpload} hidden aria-label="Upload file" />
              <button type="button" onClick={handleUploadClick} disabled={uploading} style={{ padding: "8px 12px" }}>
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </>
          )}
        </form>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <div style={{ padding: 16 }}>Loading...</div>}
          {error && <div role="alert" style={{ padding: 16, color: "#b91c1c" }}>{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div style={{ padding: 16, color: "#6b7280" }}>No files in this folder.</div>
          )}
          {!loading && !error && items.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((item) => (
                <li key={item.msDriveItemId}>
                  <button
                    type="button"
                    onClick={() => handleRowClick(item)}
                    style={{
                      width: "100%", padding: "10px 16px", textAlign: "left",
                      background: "transparent", border: 0, borderBottom: "1px solid #f3f4f6",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                    }}
                  >
                    <span aria-hidden="true">{item.isFolder ? "📁" : "📄"}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.name}
                    </span>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{formatSize(item.sizeBytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * PUT the file in 5 MB chunks to Graph's upload session URL. Not a full
 * production chunker — retries, exp backoff, and pause/resume would be
 * added before large-file use. For MVP we accept that failure means the
 * user clicks upload again.
 */
async function chunkUploadToGraph(uploadUrl: string, file: File): Promise<void> {
  const CHUNK = 5 * 1024 * 1024;
  const total = file.size;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total) - 1;
    const slice = file.slice(offset, end + 1);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(slice.size),
        "Content-Range": `bytes ${offset}-${end}/${total}`,
      },
      body: slice,
    });
    if (res.status !== 202 && res.status !== 200 && res.status !== 201) {
      throw new Error(`Upload chunk failed: ${res.status}`);
    }
    offset = end + 1;
  }
}
