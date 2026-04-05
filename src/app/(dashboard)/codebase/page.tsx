"use client";

import { useState, useEffect, FormEvent } from "react";

interface FileEntry {
  path: string;
  type: string;
  size: number;
  lastModified: string;
}

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

interface CodebaseStats {
  totalFiles: number;
  linesByLanguage: Record<string, number>;
  apiRoutes: number;
  tests: number;
  migrations: number;
}

interface FileExplanation {
  filePath: string;
  imports: string[];
  exports: string[];
  functions: { name: string; params: string; returnType: string; description: string }[];
  summary: string;
}

export default function CodebasePage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [stats, setStats] = useState<CodebaseStats | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<FileExplanation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [explainLoading, setExplainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  useEffect(() => {
    loadStructureAndStats();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "codebase" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadStructureAndStats() {
    setLoading(true);
    setError(null);
    try {
      const [structRes, statsRes] = await Promise.all([
        fetch("/api/codebase?action=structure", { headers: authHeaders() }),
        fetch("/api/codebase?action=stats", { headers: authHeaders() }),
      ]);

      if (!structRes.ok) {
        const data = await structRes.json();
        setError(data.error || "Failed to load codebase");
        setLoading(false);
        return;
      }

      const structData = await structRes.json();
      const statsData = await statsRes.json();
      setFiles(structData.entries || []);
      setStats(statsData.stats || null);
    } catch {
      setError("Failed to connect to codebase API");
    }
    setLoading(false);
  }

  async function loadFile(filePath: string) {
    setSelectedFile(filePath);
    setFileContent(null);
    setExplanation(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/codebase/${encodeURIComponent(filePath)}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setFileContent(data.content || null);
    } catch {
      setFileContent("Failed to load file");
    }
    setFileLoading(false);
  }

  async function handleExplain() {
    if (!selectedFile) return;
    setExplainLoading(true);
    setExplanation(null);
    try {
      const res = await fetch(`/api/codebase/${encodeURIComponent(selectedFile)}?action=explain`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setExplanation(data.explanation || null);
    } catch {
      setExplanation(null);
    }
    setExplainLoading(false);
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const res = await fetch(
        `/api/codebase?action=search&query=${encodeURIComponent(searchQuery)}`,
        { headers: authHeaders() },
      );
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    }
    setSearchLoading(false);
  }

  // Build directory tree from flat file list
  function buildTree(entries: FileEntry[]): Map<string, FileEntry[]> {
    const dirs = new Map<string, FileEntry[]>();
    for (const entry of entries) {
      const dir = entry.path.includes("/")
        ? entry.path.substring(0, entry.path.lastIndexOf("/"))
        : ".";
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push(entry);
    }
    return dirs;
  }

  function getTopDirs(entries: FileEntry[]): string[] {
    const topDirs = new Set<string>();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      if (parts.length > 1) {
        topDirs.add(parts[0]);
      }
    }
    return Array.from(topDirs).sort();
  }

  function getFilesInDir(dirPath: string): FileEntry[] {
    return files
      .filter((f) => {
        if (dirPath === ".") return !f.path.includes("/");
        return f.path.startsWith(dirPath + "/");
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function toggleDir(dir: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1048576).toFixed(1)}MB`;
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Codebase Explorer
      </h1>

      {/* Stats Summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Files", value: stats.totalFiles },
            {
              label: "Lines of Code",
              value: Object.values(stats.linesByLanguage).reduce((a, b) => a + b, 0).toLocaleString(),
            },
            { label: "API Routes", value: stats.apiRoutes },
            { label: "Tests", value: stats.tests },
            { label: "Migrations", value: stats.migrations },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border p-3 text-center"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <p className="text-lg font-bold" style={{ color: "var(--wp-gold)" }}>
                {stat.value}
              </p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                {stat.label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search the codebase..."
          className="flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none"
          style={{
            background: "var(--wp-dark-surface)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <button
          type="submit"
          disabled={searchLoading}
          className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {searchLoading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div
          className="rounded-lg border p-4"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
            Search Results ({searchResults.length})
          </h3>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {searchResults.map((r, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs cursor-pointer rounded px-2 py-1 hover:bg-[var(--wp-dark-surface2)]"
                onClick={() => loadFile(r.file)}
              >
                <span className="shrink-0 font-mono" style={{ color: "var(--wp-info)" }}>
                  {r.file}:{r.line}
                </span>
                <span className="truncate font-mono" style={{ color: "var(--wp-text-dim)" }}>
                  {r.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="rounded-lg border p-4"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-error)" }}
        >
          <p className="text-sm" style={{ color: "var(--wp-error)" }}>
            {error}
          </p>
        </div>
      )}

      {/* Main: File Tree + Content Viewer */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading codebase...</p>
      ) : (
        <div className="flex flex-col lg:flex-row gap-4">
          {/* File Tree (Left) */}
          <div
            className="lg:w-72 shrink-0 rounded-lg border overflow-y-auto max-h-[600px]"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <div
              className="px-3 py-2 border-b text-xs font-semibold"
              style={{ borderColor: "var(--wp-dark-border)", color: "var(--wp-text-dim)" }}
            >
              Files
            </div>

            {/* Root files */}
            {getFilesInDir(".").filter((f) => !f.path.includes("/")).map((f) => (
              <div
                key={f.path}
                className={`px-3 py-1.5 text-xs cursor-pointer truncate ${
                  selectedFile === f.path ? "bg-[var(--wp-dark-surface2)]" : ""
                } hover:bg-[var(--wp-dark-surface2)]`}
                style={{ color: selectedFile === f.path ? "var(--wp-gold)" : "var(--wp-text-dim)" }}
                onClick={() => loadFile(f.path)}
                title={`${f.path} (${formatSize(f.size)})`}
              >
                {f.path}
              </div>
            ))}

            {/* Directories */}
            {getTopDirs(files).map((dir) => (
              <div key={dir}>
                <div
                  className="px-3 py-1.5 text-xs cursor-pointer font-medium hover:bg-[var(--wp-dark-surface2)]"
                  style={{ color: "var(--wp-text)" }}
                  onClick={() => toggleDir(dir)}
                >
                  {expandedDirs.has(dir) ? "v " : "> "}
                  {dir}/
                </div>
                {expandedDirs.has(dir) &&
                  getFilesInDir(dir).map((f) => (
                    <div
                      key={f.path}
                      className={`pl-6 pr-3 py-1 text-xs cursor-pointer truncate ${
                        selectedFile === f.path ? "bg-[var(--wp-dark-surface2)]" : ""
                      } hover:bg-[var(--wp-dark-surface2)]`}
                      style={{
                        color: selectedFile === f.path ? "var(--wp-gold)" : "var(--wp-text-dim)",
                      }}
                      onClick={() => loadFile(f.path)}
                      title={`${f.path} (${formatSize(f.size)})`}
                    >
                      {f.path.replace(dir + "/", "")}
                    </div>
                  ))}
              </div>
            ))}
          </div>

          {/* Content Viewer (Right) */}
          <div
            className="flex-1 rounded-lg border min-h-[400px]"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            {selectedFile ? (
              <>
                <div
                  className="flex items-center justify-between px-4 py-2 border-b flex-wrap gap-2"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <span className="text-xs font-mono" style={{ color: "var(--wp-text)" }}>
                    {selectedFile}
                  </span>
                  {(selectedFile.endsWith(".ts") || selectedFile.endsWith(".tsx")) && (
                    <button
                      onClick={handleExplain}
                      disabled={explainLoading}
                      className="px-3 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50"
                      style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                    >
                      {explainLoading ? "Analyzing..." : "Explain This File"}
                    </button>
                  )}
                </div>

                {/* Explanation Panel */}
                {explanation && (
                  <div
                    className="px-4 py-3 border-b"
                    style={{ borderColor: "var(--wp-dark-border)", background: "var(--wp-dark-surface2)" }}
                  >
                    <p className="text-xs font-semibold mb-2" style={{ color: "var(--wp-gold)" }}>
                      File Explanation (zero-token analysis)
                    </p>
                    <p className="text-xs mb-2" style={{ color: "var(--wp-text-dim)" }}>
                      {explanation.summary}
                    </p>
                    {explanation.imports.length > 0 && (
                      <div className="mb-2">
                        <span className="text-xs font-medium" style={{ color: "var(--wp-text)" }}>
                          Imports:
                        </span>
                        <span className="text-xs ml-1" style={{ color: "var(--wp-text-dim)" }}>
                          {explanation.imports.join(", ")}
                        </span>
                      </div>
                    )}
                    {explanation.exports.length > 0 && (
                      <div className="mb-2">
                        <span className="text-xs font-medium" style={{ color: "var(--wp-text)" }}>
                          Exports:
                        </span>
                        <span className="text-xs ml-1" style={{ color: "var(--wp-text-dim)" }}>
                          {explanation.exports.join(", ")}
                        </span>
                      </div>
                    )}
                    {explanation.functions.length > 0 && (
                      <div>
                        <span className="text-xs font-medium" style={{ color: "var(--wp-text)" }}>
                          Functions:
                        </span>
                        <div className="mt-1 space-y-1">
                          {explanation.functions.map((fn) => (
                            <div key={fn.name} className="text-xs font-mono" style={{ color: "var(--wp-text-dim)" }}>
                              <span style={{ color: "var(--wp-info)" }}>{fn.name}</span>
                              ({fn.params}): {fn.returnType}
                              {fn.description !== `Function ${fn.name}` &&
                                fn.description !== `Arrow function ${fn.name}` && (
                                  <span className="ml-2" style={{ color: "var(--wp-text-muted)" }}>
                                    — {fn.description}
                                  </span>
                                )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* File Content */}
                <div className="p-4 overflow-auto max-h-[500px]">
                  {fileLoading ? (
                    <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      Loading...
                    </p>
                  ) : (
                    <pre
                      className="text-xs font-mono whitespace-pre-wrap"
                      style={{ color: "var(--wp-text-dim)" }}
                    >
                      {fileContent}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full min-h-[400px]">
                <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                  Select a file from the tree or search to view its contents
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
