"use client";

/**
 * PeopleAutocomplete — input + suggestion list powered by
 * `/api/people/suggest`. 150 ms debounce. Returns selected suggestion
 * via onPick.
 *
 * Props:
 *   onPick(person)  — called when user selects a suggestion.
 *   placeholder     — input placeholder.
 *   initialValue    — pre-filled value.
 *   disabled        — disables input.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, fetchWithRefresh } from "@/lib/client-auth";

export interface PickedPerson {
  personId: string;
  displayName: string;
  email: string;
  score: number;
  source: string;
}

interface Props {
  onPick: (p: PickedPerson) => void;
  placeholder?: string;
  initialValue?: string;
  disabled?: boolean;
}

const DEBOUNCE_MS = 150;

export default function PeopleAutocomplete({
  onPick,
  placeholder = "Search people...",
  initialValue = "",
  disabled = false,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<PickedPerson[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("top", "8");
      const res = await fetchWithRefresh(`/api/people/suggest?${params.toString()}`, {
        headers: authHeaders(),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        setSuggestions([]);
        return;
      }
      const data = (await res.json()) as { suggestions?: PickedPerson[] };
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch {
      // Aborted or network error — drop silently.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open) return;
    debounceRef.current = setTimeout(() => {
      doSearch(value);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, open, doSearch]);

  const handlePick = (p: PickedPerson) => {
    setValue(p.displayName);
    setOpen(false);
    onPick(p);
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        style={{ width: "100%", padding: 8, border: "1px solid #d1d5db", borderRadius: 6 }}
      />
      {open && (
        <ul
          role="listbox"
          style={{
            position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
            background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6,
            marginTop: 4, maxHeight: 260, overflowY: "auto",
            listStyle: "none", padding: 0,
          }}
        >
          {loading && <li style={{ padding: 8, color: "#6b7280" }}>Loading...</li>}
          {!loading && suggestions.length === 0 && (
            <li style={{ padding: 8, color: "#6b7280" }}>No matches</li>
          )}
          {suggestions.map((p) => (
            <li key={p.personId}>
              <button
                type="button"
                role="option"
                onClick={() => handlePick(p)}
                style={{
                  width: "100%", padding: 8, textAlign: "left",
                  background: "transparent", border: 0, cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 500 }}>{p.displayName || p.email}</div>
                {p.email && <div style={{ fontSize: 12, color: "#6b7280" }}>{p.email}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
