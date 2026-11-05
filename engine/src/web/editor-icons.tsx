import React from "react";

// Shared with the workspace's Icon component, so source editing uses the
// same glyphs and stroke weight as the surrounding Papilot controls.
export const editorIcons = {
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>,
  pencil: <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>,
  check: <path d="M20 6 9 17l-5-5"/>,
  close: <path d="M18 6 6 18M6 6l12 12"/>,
  undo: <><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>,
};
export function EditorIcon({ name }: { name: keyof typeof editorIcons }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{editorIcons[name]}</svg>;
}
