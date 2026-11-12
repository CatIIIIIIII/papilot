import { useRef, useState, type ReactNode } from "react";
import type { PageState, SourceExcerpt, SourceEditRequest } from "../types.ts";
import { t } from "./i18n.ts";
import { EditorIcon } from "./editor-icons.tsx";
import { LatexInput } from "./LatexInput.tsx";

type Draft = { source: SourceExcerpt; text: string; id: string };
export function SourceEditor({ task, round, change, locked, building, editable, title, actions, children, api, onSaving, onSaved, onOpen }: {
  task: string; round: number; change: string; locked: string | null; building: boolean;
  editable: boolean; title: ReactNode; actions?: ReactNode; children: ReactNode;
  api: <T>(route: string, body?: unknown) => Promise<T>;
  onSaving: (saving: boolean) => void; onSaved: (state: PageState) => void;
  /** Offers the source to an editor outside the viewer: true when one opened it. */
  onOpen?: () => boolean;
}) {
  const key = `papilot:review:source:${location.pathname}:${task}:${round}:${change}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  function keep(value: Draft) {
    setDraft(value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the draft in this tab. */ }
  }
  async function open(fresh = false) {
    if (loading || saving) return;
    if (!fresh && onOpen?.()) return;
    setLoading(true); setError(""); setSaved(false);
    try {
      if (!fresh) {
        try {
          const kept = JSON.parse(localStorage.getItem(key) || "null") as Draft | null;
          if (kept?.source?.round === round && kept.source.change === change && typeof kept.text === "string" && typeof kept.id === "string") {
            setDraft(kept); return;
          }
        } catch { /* A damaged draft cannot prevent editing. */ }
      }
      const source = await api<SourceExcerpt>(`/source?round=${round}&change=${encodeURIComponent(change)}`);
      keep({ source, text: source.text, id: crypto.randomUUID() });
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); requestAnimationFrame(() => editor.current?.focus({ preventScroll: true })); }
  }
  async function save() {
    if (!draft || locked || inFlight.current || draft.text === draft.source.text) return;
    inFlight.current = true; setSaving(true); onSaving(true); setError("");
    try {
      const input: SourceEditRequest = { id: draft.id, round, change, revision: draft.source.revision, text: draft.text };
      const state = await api<PageState>("/source", input);
      onSaved(state); setSaved(true);
      // Keep the submitted draft until the new PDF is ready. If compilation
      // fails, reopening loads the saved source and lets the author repair it.
      try { localStorage.removeItem(key); } catch { /* Optional storage. */ }
      setDraft(null);
    } catch (error) { setError((error as Error).message); }
    finally { inFlight.current = false; setSaving(false); onSaving(false); }
  }
  const editLabel = t(loading ? "Loading source…" : "Edit"), saveLabel = t(saving ? "Saving…" : "Save and update PDF");
  return <div className="source-editor" data-dirty={Boolean(draft && draft.text !== draft.source.text)}>
    <div className="source-title">
      {title}{actions}
      {editable && <div className="source-editor-actions">
        {!draft ? <button className="source-icon" disabled={Boolean(locked) || loading} title={locked || editLabel} aria-label={editLabel} aria-busy={loading} onClick={() => void open()}><EditorIcon name={loading ? "refresh" : "pencil"}/></button> : <>
          <button className="source-icon" disabled={saving || loading || Boolean(locked)} title={t("Reset to saved source")} aria-label={t("Reset to saved source")} onClick={() => void open(true)}><EditorIcon name="undo"/></button>
          <button className="source-icon source-save" disabled={Boolean(locked) || saving || draft.text === draft.source.text} title={locked || `${saveLabel} · ${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"}Enter`} aria-label={saveLabel} aria-busy={saving} onClick={() => void save()}><EditorIcon name={saving ? "refresh" : "check"}/></button>
          <button className="source-icon" disabled={saving} title={t("Close")} aria-label={t("Close")} onClick={() => { setDraft(null); setError(""); }}><EditorIcon name="close"/></button>
        </>}
      </div>}
    </div>
    {draft ? <>
        <LatexInput inputRef={editor} aria-label={t("Edit LaTeX source")} value={draft.text} readOnly={saving} spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={200000}
          rows={Math.max(1, Math.min(18, draft.text.split("\n").length))}
          onChange={event => { keep({ ...draft, text: event.target.value, id: crypto.randomUUID() }); setSaved(false); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
            if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); setDraft(null); }
          }}/>
      {locked && <p className="caption">{locked}</p>}
    </> : children}
    {saved && building && <p className="caption" role="status">{t("Source saved. Updating the PDF…")}</p>}
    {error && <p className="source-editor-error" role="alert">{t(error)}</p>}
  </div>;
}
