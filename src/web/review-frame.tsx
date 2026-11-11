import { isPlayground } from './playground-mode.ts';
import taskCommitStyles from './task-commit.css?inline';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../shared.ts';
import { useReviewDraft } from './review-draft.ts';
import { ReviewNotes } from './review-notes.tsx';
import { Icon } from './icons.tsx';
import themeStyles from './theme.css?inline';
import { syncAppearance } from './appearance.ts';
import { language, t, useLanguage } from './i18n.ts';
import { NoteReviewControls, NoteReviewScope, useNoteResults } from './note-results.tsx';
import { ReviewNoteConnections } from './review-note-connections.tsx';
import { SHORTCUT_EVENT, useShortcuts } from './shortcuts.ts';
import { connectWorkspaceKeys } from './workspace-switch.ts';
import { installReviewScroll } from './review-scroll.ts';
import { EFFECTS_EVENT, loadIndirectChanges, useIndirectChanges } from './effect-preferences.ts';
import { useTaskReviewView, VIEW_EVENT, type ReviewView } from './review-view.ts';
import { ModeSwitch } from './mode-switch.tsx';
import { PdfContents, PdfPageControls, PdfFind, PdfFindButton } from './pdf-controls.tsx';
import { PDF_READER_COMMAND, PDF_READER_STATE, type PdfReaderCommand, type PdfReaderState } from '../../engine/src/web/pdf-reader.ts';
import { VIEW_CHOSEN_EVENT } from '../../engine/src/web/view-preferences.ts';

// The viewer reads the interface language from its address.
export const reviewUrl = (task: Pick<Task, 'projectId' | 'name'>, round?: number, change?: number) => `${isPlayground ? import.meta.env.BASE_URL + 'src/web/playground/review.html' : `/review/${task.projectId}/`}?task=${task.name}${round ? `&round=${round}${change === undefined ? '&history=1' : `&change=${change}`}` : ''}${language() === 'en' ? '' : `&lang=${language()}`}`;
// The same viewer shows a paper's uncommitted changes against its last commit.
// The manuscript's own PDF / Changes switch chooses its PDF; its review of the
// changes shows them alone.
export const changesUrl = (projectId: string) => `/review/${projectId}/?changes=1&view=changes${language() === 'en' ? '' : `&lang=${language()}`}`;

// The embedded viewer shares our origin. Keep its decision controls, but remove
// navigation and the task title that the workspace already provides. Its bar
// becomes the review toolbar; Papilot's PDF tools sit in the reserved space
// on the right, and anything it leads with on the left.
function compactReviewFrame(doc: Document, reserve: number, lead: number, changes: boolean) {
  if (!doc || doc.getElementById('papilot-embed-style')) return;
  doc.documentElement.style.setProperty('--papilot-tools', `${reserve}px`);
  doc.documentElement.style.setProperty('--papilot-lead', `${lead}px`);
  const style = doc.createElement('style'); style.id = 'papilot-embed-style';
  style.textContent = themeStyles + `
    :root{--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Noto Sans SC",system-ui,sans-serif;--comment:var(--accent);--accept:var(--green);--reject:var(--red);--frame:var(--canvas);--bar:var(--bg);--muted:var(--text-3);--ink:var(--text);--head:var(--bg-subtle);font-size:14px}
    .banner{border-radius:10px}
    .source,.source-code,.unit-actions button,.toast,.change-map-tooltip,.review-mode,.review-mode select,.review-complete,.change.standalone{background:var(--bg);color:var(--text)}
    .banner{background:var(--accent-soft);border-color:var(--accent-line)}.banner .details{background:var(--bg-subtle)}
    .composer{border-color:color-mix(in srgb,var(--line-strong) 65%,transparent);box-shadow:var(--float)}
    .composer-close:hover{background:var(--bg-hover);color:var(--text)}
    .composer-send{background:var(--primary)}.composer-send:hover:not(:disabled){background:var(--primary-hover)}.composer-send:disabled{background:var(--bg-active);color:var(--text-3)}
    .composer-send:focus-visible,.composer-close:focus-visible{outline:none;box-shadow:var(--ring)}
    .source-title{color:var(--text-2)}
    .source-code del{background:var(--red-soft);color:var(--red)}
    .source-code ins{background:var(--green-soft);color:var(--green)}
    .remark{background:var(--accent-soft)}.histories,.caption{background:var(--bg-subtle);color:var(--text-2)}
    /* Bibliography entries and their checks follow the theme. */
    :root{--ok-soft:var(--green-soft);--bad-soft:var(--red-soft);--warn:var(--amber-text);--warn-soft:var(--amber-soft);--warn-line:var(--amber-line)}
    .references,.reference-entry{background:var(--bg);color:var(--text)}
    .reference-fields th,.reference-status,.reference-lines,.reference-cited,.reference-side,.reference-resolved{color:var(--text-3)}
    .toast.error{background:var(--red-soft);color:var(--red)}
    /* Papilot's commit step at the end of the completion card. */
    .review-complete{align-items:center}
    .review-complete-actions{flex-wrap:wrap;justify-content:flex-end;max-width:100%}
    .review-complete-actions .commit-state{font-size:13px;color:var(--text-3)}
    .review-complete-actions .commit-button{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:1px solid var(--line-strong);border-radius:7px;background:var(--bg);color:var(--text);font:500 13px var(--sans);cursor:pointer;box-shadow:0 1px 2px rgb(0 0 0/.06)}
    .review-complete-actions .commit-button:hover{background:var(--bg-subtle);border-color:var(--line-hover)}
    .review-complete-actions .commit-button:focus-visible{outline:none;box-shadow:var(--ring)}
    .review-complete-actions .commit-button{height:auto;min-height:30px;padding:5px 12px;white-space:nowrap}
    .review-complete-actions .commit-button:disabled{opacity:.5;cursor:default}
    :root[data-papilot-phone] .review-complete-actions{justify-content:flex-start;margin-left:0}
    :root[data-papilot-phone] .review-complete-actions .commit-state:not(.task-save-result){flex-basis:100%}
    :root[data-papilot-phone] .review-complete-actions .commit-button{min-height:40px}
    /* Review previews, difference rows and embedded controls share one mode.
       The surrounding toolbar and workspace keep the application's theme. */
    .document{--pdf-filter:var(--review-filter);--pdf-page:var(--review-page);--before:var(--review-before);--after:var(--review-after)}
    .pdf-strip{color-scheme:light}.pdf-strip img{filter:var(--pdf-filter)}.sheet{background:var(--pdf-page)}
    :root[data-theme="dark"][data-review-theme="light"] :is(.sheet,.paper-page,.document .change){
      color-scheme:light;--bg:#ffffff;--bg-subtle:#fafafa;--bg-muted:#f4f4f4;--bg-hover:#efefef;--bg-active:#e7e7e7;--frame:#f3f3f3;
      --text:#171717;--text-2:#525252;--text-3:#8a8a8a;--ink:var(--text);--muted:var(--text-3);--head:var(--bg-subtle);
      --line:#e8e8e8;--line-strong:#d6d6d6;--line-hover:#c4c4c4;
      --accent:#2563eb;--accent-hover:#1d4ed8;--accent-soft:#eff6ff;--accent-line:#bfdbfe;
      --green:#15803d;--green-soft:#f0fdf4;--red:#dc2626;--red-soft:#fef2f2;--red-line:#fecaca;
      --amber-text:#92400e;--amber-soft:#fffbeb;--amber-line:#fde68a;
      --accept:var(--green);--reject:var(--red);--comment:var(--accent);--ok-soft:var(--green-soft);--bad-soft:var(--red-soft);--warn:var(--amber-text);--warn-soft:var(--amber-soft);--warn-line:var(--amber-line);
    }
    .review-body{margin-left:var(--papilot-rail,0px)}
    .bar{display:flex;align-items:center;height:var(--papilot-bar-height,44px);min-height:var(--papilot-bar-height,44px);padding:0 max(14px,calc(var(--papilot-tools,0px) + 4px)) 0 calc(var(--papilot-lead,0px) + 14px);gap:12px;flex-wrap:nowrap;overflow:hidden}
    .bar .overview-link,.bar .identity h1,.bar .identity span{display:none}
    .bar .identity{flex:1;min-width:0;flex-direction:row;gap:6px}
    .bar .identity span{font-size:13px;font-weight:600;color:var(--text-2);overflow:hidden;text-overflow:ellipsis}
    .bar .meter{display:flex;order:initial;width:auto;font-size:13px}
    .bar .bar-end{margin-left:0;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
    .bar .ghost{font-size:13px;font-weight:500;height:28px;padding:0 10px;border-radius:7px}
    .bar .ghost:hover{text-decoration:none;background:var(--bg-hover)}
    .bar .accept-all,.bar .reject-all{display:inline-flex;align-items:center;gap:6px;border-color:var(--line-strong);background:var(--bg);color:var(--ink);box-shadow:0 1px 2px rgb(0 0 0/.06)}
    .bar .accept-all:hover,.bar .reject-all:hover{background:var(--bg-subtle);border-color:var(--line-hover)}
    .bar .ghost.round{display:none}
    .bar .status{font-size:13px}
    .sheet{border-radius:4px;box-shadow:0 1px 2px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.08)}
    .change-head{font-size:13px;background:var(--bg-subtle)}.link{font-size:13px}
    /* Keep the selection cue in the toolbar, clear of the PDF itself. */
    .change.current{box-shadow:none}
    .change.current .change-head{background:var(--bg-muted);box-shadow:inset 2px 0 var(--accent);color:var(--ink)}
    .change-head .link{display:inline-flex;align-items:center;height:28px;padding:0 8px;border-radius:7px;color:var(--text-2);font-weight:500}
    .change-head .link:hover{background:var(--bg-hover);color:var(--ink);text-decoration:none}
    .change-head .link.active{background:var(--accent-soft);color:var(--accent);text-decoration:none}
    /* Decision buttons are plain text actions like the rest of the header
       (Copy reference, LaTeX, Undo): a coloured icon says what each does, and
       hovering tints it green, red or blue. On phones the bar is a solid
       toolbar at the bottom. */
    :root{--icon-copy:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linejoin='round'><rect x='8' y='8' width='12' height='12' rx='2'/><path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'/></svg>");--icon-check:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='M20 6 9 17l-5-5'/></svg>");--icon-cross:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round'><path d='M18 6 6 18M6 6l12 12'/></svg>");--icon-comment:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linejoin='round'><path d='M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z'/></svg>")}
    .change-head .actions .accept::before,.change-head .actions .reject::before,.change-head .actions .comment::before,.bar .accept-all::before,.bar .reject-all::before{content:"";flex:none;width:13px;height:13px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
    .change-head .actions .accept,.bar .accept-all{--icon:var(--icon-check)}.change-head .actions .reject,.bar .reject-all{--icon:var(--icon-cross)}.change-head .actions .comment{--icon:var(--icon-comment)}
    .change-head .actions .accept::before,.bar .accept-all::before{background:var(--accept)}.change-head .actions .reject::before,.bar .reject-all::before{background:var(--reject)}.change-head .actions .comment::before{background:var(--accent)}
    .change-head .actions{gap:3px;padding:4px;background:var(--bg);border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 1px 2px rgb(0 0 0/.06),0 4px 12px rgb(0 0 0/.06)}
    .change-head .actions button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border:1px solid transparent;border-radius:7px;font-size:13px;font-weight:500;line-height:1;transition:background-color .15s,border-color .15s}
    .change-head .actions .nav{width:28px;padding:0;font-size:19px;font-weight:400;color:var(--text-2)}
    .change-head .actions .nav:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .nav:disabled{color:var(--text-3);opacity:1}
    .change-head .position{min-width:38px;font-size:12.5px;color:var(--text-2);font-variant-numeric:tabular-nums}
    .change-head .actions .accept,.change-head .actions .reject,.change-head .actions .comment,.change-head .actions .skip{background:transparent;color:var(--ink)}
    .change-head .actions .accept:hover:not(:disabled){background:var(--green-soft);color:var(--accept)}
    .change-head .actions .reject:hover:not(:disabled){background:var(--red-soft);color:var(--reject)}
    .change-head .actions .comment:hover:not(:disabled){background:var(--accent-soft);color:var(--accent)}
    .change-head .actions .skip:hover{background:var(--bg-hover)}
    .change-head .actions button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .change-head .complete{display:inline-flex;align-items:center;gap:6px;padding:0 8px;font-size:13px;font-weight:500;color:var(--accept)}
    .change-head .complete::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
    .change-head .actions .undo{margin-left:3px;padding:0 9px;font-weight:400;color:var(--text-2)}
    .change-head .actions .undo:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .undo:disabled{color:var(--text-3);opacity:1}
    .change-head .actions .accept:disabled,.change-head .actions .reject:disabled,.change-head .actions .comment:disabled{opacity:.4}
    /* Uncommitted changes: Stage is the check, Unstage a minus and Revert an
       arrow back. The last revert is undone from the bar. */
    :root{--icon-minus:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round'><path d='M5 12h14'/></svg>");--icon-revert:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M9 14 4 9l5-5'/><path d='M4 9h10.5a5.5 5.5 0 0 1 0 11H11'/></svg>")}
    .change-head .actions .unstage::before{content:"";flex:none;width:13px;height:13px;background:var(--text-2);-webkit-mask:var(--icon-minus) center/contain no-repeat;mask:var(--icon-minus) center/contain no-repeat}
    [data-mode=changes] .change-head .actions .reject{--icon:var(--icon-revert)}
    .change-head .actions .unstage{background:transparent;color:var(--ink)}
    .change-head .actions .unstage:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .unstage:disabled{opacity:.4}
    .unit-actions .unstage{color:var(--text-2)}
    /* Each edit's own decisions in the LaTeX view use the change bar's icons. */
    .unit-actions button:is(.accept,.reject,.comment,.unstage){display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--ink);font-size:0;flex:none;transition:background-color .15s}
    .unit-actions button:is(.accept,.reject,.comment,.unstage)::before{content:"";flex:none;width:15px;height:15px;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
    .unit-actions .accept{--icon:var(--icon-check)}.unit-actions .reject{--icon:var(--icon-cross)}.unit-actions .comment{--icon:var(--icon-comment)}.unit-actions .unstage{--icon:var(--icon-minus)}
    [data-mode=changes] .unit-actions .reject{--icon:var(--icon-revert)}
    .unit-actions .accept::before{background:var(--accept)}.unit-actions .reject::before{background:var(--reject)}.unit-actions .comment::before{background:var(--accent)}.unit-actions .unstage::before{background:var(--text-2)}
    .unit-actions .accept:hover:not(:disabled){background:var(--green-soft)}.unit-actions .reject:hover:not(:disabled){background:var(--red-soft)}.unit-actions .comment:hover:not(:disabled){background:var(--accent-soft)}.unit-actions .unstage:hover:not(:disabled){background:var(--bg-hover)}
    .unit-actions button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .unit-actions button:is(.accept,.reject,.comment,.unstage):disabled{opacity:.4}
    :root[data-papilot-phone] .unit-actions button:is(.accept,.reject,.comment,.unstage){width:40px;height:36px}
    :root[data-papilot-phone] .unit-actions button:is(.accept,.reject,.comment,.unstage)::before{width:18px;height:18px}
    .bar .ghost.undo{flex-shrink:0;white-space:nowrap}
    /* A single compact row: location yields space to the change's controls. */
    .change-head{flex-wrap:nowrap;align-items:center;gap:4px;padding:4px 8px;min-height:36px}
    :root:not([data-papilot-phone]) .change{container:change-tools/inline-size}
    .change-head .dock,.change-head .actions{display:contents}
    .change-head .actions>.nav:first-child{order:1}.change-head .change-number{order:2}.change-head .actions>.nav:not(:first-child){order:3}
    .change-head .change-number{flex:0 0 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .change-head .change-where{order:4;flex:1 1 0;min-width:0;margin-left:4px;color:var(--text-3);font-size:10px}
    .change-head .change-kind,.change-head .badge{order:5;font-size:11px;color:var(--text-3)}
    .change-head .change-kind,.change-head .badge{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
    .change-head .actions>*{order:6}
    .change-head .link{order:7}
    :root:not([data-papilot-phone]) .change-head .position,:root:not([data-papilot-phone]) .change-head .complete{display:none}
    .change-head .actions .undo:disabled{display:none}
    .change-head .actions .nav{flex:none;width:28px;height:28px;font-size:18px}
    .change-head .copy-reference{flex:none;width:28px;padding:0;justify-content:center;font-size:0}
    .change-head .copy-reference::before{content:"";width:15px;height:15px;background:currentColor;-webkit-mask:var(--icon-copy) center/contain no-repeat;mask:var(--icon-copy) center/contain no-repeat}
    @container change-tools (max-width:360px){
      .change-number-full{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      .change-number-short{display:inline}
    }
    @container change-tools (max-width:280px){
      .change-head{gap:1px;padding-inline:2px}
      .change-head .change-where,.change-head .change-kind,.change-head .badge{display:none}
      .change-head .change-number{flex:1 1 auto;font-size:12px}
    }
    #paper{--paper-top:14px;padding-top:14px}
    .review-body>#paper{padding-right:34px;overscroll-behavior:contain}
    .change-map{top:10px;bottom:10px;right:8px;width:14px;border:0;border-radius:0;background:none;box-shadow:none}
    .change-map::before{content:"";position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;border-radius:2px;background:var(--line)}
    .change-map-viewport{left:50%;right:auto;width:4px;margin-left:-2px;border:0;border-radius:999px;background:var(--scroll-thumb);transition:width .15s,margin .15s,background-color .15s}
    .change-map:hover .change-map-viewport,.change-map-viewport:active{width:6px;margin-left:-3px;background:var(--scroll-hover)}
    .change-map-mark{--mark:var(--text-3);left:50%;width:4px;min-height:3px;margin-left:-2px;border-radius:999px;transition:width .15s,margin .15s}
    .change-map-mark[aria-current]{outline:0;width:6px;margin-left:-3px;box-shadow:0 0 0 2px var(--frame)}
    .change-map:hover .change-map-mark{width:6px;margin-left:-3px}
    .change-map .change-map-mark:hover{outline:0;width:8px;margin-left:-4px;box-shadow:0 0 0 2px var(--frame)}
    .change-map-mark:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
    ::-webkit-scrollbar-thumb{background-color:var(--scroll-thumb);border:3px solid transparent;border-radius:999px;background-clip:padding-box}
    ::-webkit-scrollbar-thumb:hover{background-color:var(--scroll-active);border-width:2px}
    @supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--scroll-hover) transparent}}
    .part-title{font-size:15px;margin:6px 0 10px}
    .side .pdf-strip,.context .pdf-strip{max-width:none}
    /* Only the host window, never an iframe's width, selects the phone
       layout. Navigation and position stay alongside the decisions. */
    :root[data-papilot-phone]{
      .bar{gap:6px;min-height:var(--papilot-bar-height,42px);padding:0 max(8px,calc(var(--papilot-tools,0px) + 4px)) 0 calc(var(--papilot-lead,0px) + 10px);background:color-mix(in srgb,var(--bg) 90%,transparent);-webkit-backdrop-filter:saturate(180%) blur(18px);backdrop-filter:saturate(180%) blur(18px);border-bottom:.5px solid color-mix(in srgb,var(--line-strong) 75%,transparent)}
      .bar .meter{font-size:12.5px;font-weight:500;color:var(--text-2);font-variant-numeric:tabular-nums}
      .bar .ghost:not(.history){min-height:30px;height:30px;padding:0 9px;border-radius:999px;font-size:12px}
      .review-body>#paper{--paper-top:12px;padding:12px 18px calc(136px + var(--papilot-bottom-rail,0px)) 10px}
      .sheet{border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.07)}
      .change-map{right:3px;width:10px}
      .side.before::after,.side.after::after{content:none}
      .change-head{padding:5px 8px 5px 12px;min-height:38px;gap:6px}
      .change-head .change-number{margin-right:auto;font-size:13px;font-weight:600}
      .change-head .change-where{position:absolute;width:1px;height:1px;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      .change-head .copy-reference{display:none}
      .change-head .link{min-height:32px;height:32px;padding:0 6px;border-radius:8px}
      .change-head .source-toggle{width:32px}
      .change-head .dock{display:flex;position:fixed;z-index:6;left:50%;right:auto;transform:translateX(-50%);width:min(352px,calc(100% - 20px));bottom:calc(max(10px,env(safe-area-inset-bottom)) + var(--papilot-bottom-rail,0px));margin:0;transition:bottom .16s cubic-bezier(.2,0,0,1)}
      .change-head .actions{display:flex;width:100%;flex-wrap:nowrap;align-items:center;justify-content:space-between;gap:5px;padding:5px 6px;border-radius:999px;background:color-mix(in srgb,var(--bg) 82%,transparent);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);border:.5px solid color-mix(in srgb,var(--line-strong) 85%,transparent);box-shadow:0 4px 14px rgb(0 0 0/.08),0 12px 32px rgb(0 0 0/.14)}
      .change-head .actions>*{order:initial!important}
      .change-head .actions button{flex:1 1 auto;min-width:0;height:40px;gap:5px;padding:0 8px;border-radius:999px;font-size:13px}
      .change-head .actions .nav{flex:0 0 36px;width:36px;min-width:36px;height:40px;padding:0;border-radius:999px}
      .change-head .actions .accept:not(:disabled){background:var(--green-soft)}
      .change-head .actions .reject:not(:disabled){background:var(--red-soft)}
      .change-head .actions .comment:not(:disabled){background:var(--accent-soft)}
      .change-head .position{flex:0 0 auto;min-width:32px;text-align:center;font-size:12px;font-weight:600}
      .change-head .actions .undo{flex:0 0 auto;margin-left:0;padding:0 10px;font-size:13px;background:var(--bg-muted)}
      @media(max-width:350px){
        .change-head .dock{left:8px;right:8px;width:auto;transform:none}
        .change-head .actions{border-radius:20px;flex-wrap:wrap}
        .change-head .actions:has(.nav){display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
        .change-head .actions .nav{width:100%;min-width:0;grid-row:1}
        .change-head .actions>.nav:first-child{grid-column:1}
        .change-head .actions>.nav:not(:first-child){grid-column:3}
        .change-head .position{grid-row:1;grid-column:2;justify-self:center}
        .change-head .actions button:not(.nav){grid-row:2}
      }
      .composer{left:8px!important;right:8px!important;width:auto!important;max-width:none;top:calc(var(--papilot-review-bar-height,42px) + 8px);bottom:auto;transform:none;max-height:calc(100% - var(--papilot-review-bar-height,42px) - var(--keyboard,0px) - 16px);overflow:auto;border-width:1px;border-radius:18px;box-shadow:0 8px 30px rgb(0 0 0/.16)}
      #root:has(>.composer) .change-head .dock{display:none}
      .composer textarea{font-size:16px;min-height:76px;max-height:min(140px,30vh)}.composer-head{padding:12px 10px 0 16px}.composer-close{width:40px;height:40px;border-radius:999px}.composer-send{width:40px;height:40px;border-radius:999px}
      .composer-row{justify-content:flex-end;padding:4px 12px 12px 16px}.composer-row .muted{display:none}
      .side .pdf-strip,.context .pdf-strip{width:calc(100% * var(--pdf-crop-scale,1));margin-left:calc(-100% * var(--pdf-crop-scale,1) * var(--pdf-crop-shift,0))}
      .side,.context{overflow-x:clip}
    }
    /* Keep readable names and shortcut hints while drawing only the icons. */
    :root{--icon-source:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16'/></svg>")}
    :root .change-head .actions button:is(.accept,.reject,.comment,.unstage,.skip){width:28px;padding:0;gap:0;font-size:0;flex:none}
    .change-head .actions button:is(.accept,.reject,.comment,.unstage,.skip)::before{width:15px;height:15px}
    .change-head .actions .skip::before{content:"";background:currentColor;--skip-icon:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m5 5 7 7-7 7M19 5v14'/></svg>");-webkit-mask:var(--skip-icon) center/contain no-repeat;mask:var(--skip-icon) center/contain no-repeat}
    .change-head .source-toggle{width:28px;padding:0;flex:none;justify-content:center;font-size:0}
    .change-head .source-toggle::before{content:"";width:16px;height:16px;background:currentColor;-webkit-mask:var(--icon-source) center/contain no-repeat;mask:var(--icon-source) center/contain no-repeat}
    :root[data-papilot-phone] .change-head .actions button:is(.accept,.reject,.comment,.unstage,.skip){width:44px;flex:1 1 auto}
    :root[data-papilot-phone] .change-head .actions button:is(.accept,.reject,.comment,.unstage,.skip)::before{width:18px;height:18px}
    /* History shares the PDF tools' size. Shortcut settings live in Papilot. */
    /* Papilot shows the full paper switch with its own controls. */
    .view-switch{display:none}
    .bar .ghost.history{display:inline-flex;align-items:center;justify-content:center;width:var(--papilot-button-size,30px);height:var(--papilot-button-size,30px);min-height:0;padding:0;font-size:0}
    .bar .history::before{content:"";width:16px;height:16px;background:currentColor;-webkit-mask:var(--icon-history) center/contain no-repeat;mask:var(--icon-history) center/contain no-repeat}
    /* Reserve the outer tools' row when there is too little room. Keep
       progress, batch counts and history; shorten only the batch labels. */
    .bar{container:review-bar/inline-size;height:auto;gap:8px}
    /* The host's compile button already shows build activity. Keep the phase
       available to screen readers without pushing decisions into another row. */
    :root[data-papilot-build-indicator] .bar .status[data-state="building"]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%)}
    .bar .accept-all,.bar .reject-all{flex-shrink:0;white-space:nowrap}
    .bar .batch-count{margin-left:0;background:var(--bg-muted);color:var(--text-2)}
    :root[data-papilot-toolbar-stacked] .bar{padding:calc(var(--papilot-bar-height,44px) + 4px) 8px 4px;min-height:calc(var(--papilot-bar-height,44px) + 44px)}
    :root[data-papilot-toolbar-stacked] .bar .identity{display:none}
    :root[data-papilot-toolbar-stacked] .bar .bar-end{margin-left:auto}
    /* The common PDF toolbar owns the first row; review decisions keep a
       separate row below it. Full pages use the manuscript's fit and margins. */
    :root[data-papilot-reader] .bar{margin-top:var(--papilot-bar-height,46px);padding:0 8px;min-height:44px}
    :root[data-papilot-reader] .change-map{display:none}
    :root[data-papilot-reader] .review-body>#paper{--paper-top:20px;padding:20px 0 56px}
    :root[data-papilot-reader] .paper-page{margin-bottom:20px;border-radius:2px;box-shadow:0 1px 2px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.08)}
    :root[data-papilot-reader] .paper{--pdf-crop-scale:1;--pdf-crop-shift:0}
    :root[data-papilot-reader][data-papilot-phone] .review-body>#paper{--paper-top:10px;padding:10px 0 132px}
    :root[data-papilot-reader][data-papilot-phone] .paper-page{margin-bottom:10px}
    /* Extra scroll room keeps even the final edit above the note drawer.
       The PDF width, pages and line geometry remain untouched. */
    :root[data-papilot-note-drawer] .review-body>#paper{padding-bottom:calc(90px + var(--papilot-note-inset));scroll-padding-bottom:calc(16px + var(--papilot-note-inset))}
    @container review-bar (max-width:340px){.bar .batch-label{display:none}.bar .accept-all,.bar .reject-all{padding:0 8px}.bar .bar-end{gap:4px}}
    :root{--icon-history:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 12a9 9 0 1 0 2.6-6.4L3 8'/><path d='M3 3v5h5M12 7v5l3 2'/></svg>")}
  `;
  syncAppearance(window.document.documentElement, doc.documentElement);
  style.textContent += taskCommitStyles;
  doc.head.append(style);
}

// Phones read the text block rather than the page. Measure the text layer's
// shared left and right edges across all strips and crop the page margins
// (used only by the narrow-screen strip rule above).
function cropMargins(doc: Document) {
  let min = 1, max = 0;
  for (const strip of doc.querySelectorAll<HTMLElement>('.pdf-strip')) {
    // The renderer knows these edges before any text is laid out. Reading
    // them also includes the compact text layers outside the viewport.
    if (strip.dataset.textLeft !== undefined && strip.dataset.textRight !== undefined) {
      min = Math.min(min, Number(strip.dataset.textLeft)); max = Math.max(max, Number(strip.dataset.textRight)); continue;
    }
    // Older engines do not expose normalized edges.
    const box = strip.getBoundingClientRect(); if (!box.width) continue;
    for (const line of strip.querySelectorAll('.pdf-text-line')) {
      const first = line.firstElementChild?.getBoundingClientRect(), last = line.lastElementChild?.getBoundingClientRect();
      if (!first?.width || !last?.width) continue;
      min = Math.min(min, (first.left - box.left) / box.width); max = Math.max(max, (last.right - box.left) / box.width);
    }
  }
  const root = doc.documentElement.style, span = max - min + 0.04;
  if (max <= min || span >= 0.95) { root.removeProperty('--pdf-crop-scale'); root.removeProperty('--pdf-crop-shift'); return; }
  root.setProperty('--pdf-crop-scale', (1 / span).toFixed(4)); root.setProperty('--pdf-crop-shift', Math.max(0, min - 0.02).toFixed(4));
}


// The iframe can finish loading an HTTP error or an empty document. Wait for the
// actual viewer, keep watching slow startup, and let the user retry safely.
// completion is the next step shown in the viewer's card once every change is decided.
// Without a task the frame shows the paper's uncommitted changes (changesOf),
// and the viewer's own waiting message shows while they are compared.
export function ReviewFrame({ task, changesOf, tools, lead, completion, onComment, onDecided, onReadyChange, onFullPaperChange, view: controlledView, onViewChange, keepPdf }: { task?: Task; changesOf?: string; tools?: ReactNode; lead?: ReactNode; completion?: ReactNode; onComment?: () => void; onDecided?: () => void; onReadyChange?: (ready: boolean, round?: number) => void; onFullPaperChange?: (available: boolean) => void; view?: ReviewView; onViewChange?: (value: ReviewView) => void; keepPdf?: boolean }) {
  const draft = useReviewDraft(task?.id || '');
  const quoteFocus = draft.reveal;
  const shortcuts = useShortcuts();
  const expandedEffects = useIndirectChanges();
  useEffect(loadIndirectChanges, []);
  const [uncontrolledView, setUncontrolledView] = useTaskReviewView(task?.id);
  const view = controlledView ?? uncontrolledView, chooseView = onViewChange ?? setUncontrolledView;
  const [fullPaper, setFullPaper] = useState(false);
  // A task's review offers the whole paper as PDF, where the manuscript has its PDF.
  const modes = task && fullPaper ? <ModeSwitch mode={view === 'paper' ? 'pdf' : 'changes'} onMode={mode => chooseView(mode === 'pdf' ? 'paper' : 'changes')} changesTitle={t('Changes')}/> : null;
  const noteLinks = useNoteResults(), linksRef = useRef(noteLinks); linksRef.current = noteLinks;
  // Current changes open in the usual review; only older results need history.
  const linkedRound = quoteFocus?.note.round ?? (task && noteLinks?.focus?.historical ? noteLinks.focus.change.round : undefined);
  const linkedChange = quoteFocus?.note.stop ?? (linkedRound === task?.review?.round ? noteLinks?.focus?.change.stop : undefined);
  const focusSequence = quoteFocus ? `quote:${quoteFocus.sequence}` : undefined;
  const [document, setDocument] = useState<Document | null>(null);
  const [reader, setReader] = useState<PdfReaderState | null>(null);
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState('');
  const findInput = useRef<HTMLInputElement>(null);
  const currentFind = useRef({ open: findOpen, query }); currentFind.current = { open: findOpen, query };
  const readingPdf = fullPaper && view === 'paper';
  const readerCommand = (detail: PdfReaderCommand) => document?.defaultView?.dispatchEvent(new CustomEvent(PDF_READER_COMMAND, { detail }));
  const closeFind = () => { setFindOpen(false); setQuery(''); readerCommand({ type: 'closeFind' }); };
  useEffect(() => { if (!readingPdf) { setFindOpen(false); setQuery(''); } }, [readingPdf]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'slow' | 'error'>('loading');
  const ready = phase === 'ready';
  useEffect(() => {
    if (!readingPdf || !ready) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented || !frame.current?.clientHeight) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault(); if (findInput.current) findInput.current.select(); else setFindOpen(true);
      } else if (event.view === window) {
        if (event.key === '0') { event.preventDefault(); readerCommand({ type: 'zoom', value: 'page-width' }); }
        else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); readerCommand({ type: 'zoomBy', factor: event.key === '-' ? 1 / 1.1 : 1.1 }); }
      }
    };
    window.addEventListener('keydown', key); document?.defaultView?.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document?.defaultView?.removeEventListener('keydown', key); };
  }, [document, readingPdf, ready]);
  useEffect(() => {
    setReader(null);
    const target = document?.defaultView;
    if (!target) return;
    let active = false;
    const update = (event: Event) => {
      const next = (event as CustomEvent<PdfReaderState | null>).detail, starting = Boolean(next) && !active;
      active = Boolean(next); setReader(next);
      // A new round or compilation pass replaces the search controller while
      // the host's search field stays open. Replay its query once per reader.
      const find = currentFind.current;
      if (starting && find.open && find.query) target.dispatchEvent(new CustomEvent(PDF_READER_COMMAND, { detail: { type: 'find', query: find.query, again: false, previous: false } }));
    };
    target.addEventListener(PDF_READER_STATE, update);
    target.dispatchEvent(new CustomEvent(PDF_READER_COMMAND, { detail: { type: 'state' } }));
    return () => target.removeEventListener(PDF_READER_STATE, update);
  }, [document]);
  const [railSlot, setRailSlot] = useState<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const toolbar = useRef<HTMLDivElement>(null), leading = useRef<HTMLDivElement>(null), hostBar = useRef<HTMLDivElement>(null);
  const [reserve, setReserve] = useState(0), [leadWidth, setLeadWidth] = useState(0);
  const decided = useRef(onDecided); decided.current = onDecided;
  const observer = useRef<MutationObserver | null>(null);
  const cropper = useRef<MutationObserver | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [displayedRound, setDisplayedRound] = useState<number>();
  // A new language reloads the viewer in that language.
  const shown = useLanguage().language;
  useEffect(() => {
    if (document && frame.current) return installReviewScroll(frame.current, document);
  }, [document]);
  useEffect(() => { if (document) return connectWorkspaceKeys(document); }, [document]);
  useEffect(() => {
    const view = document?.defaultView;
    if (!view) return;
    view.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: shortcuts }));
  }, [document, shortcuts]);
  useEffect(() => {
    document?.defaultView?.dispatchEvent(new CustomEvent(EFFECTS_EVENT, { detail: expandedEffects }));
  }, [document, expandedEffects]);
  useEffect(() => {
    document?.defaultView?.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: view }));
  }, [document, view]);
  useEffect(() => {
    // Manuscript comparisons have their own build. Hide the duplicate phase
    // only while the task's host toolbar is showing its compilation spinner.
    document?.documentElement.toggleAttribute('data-papilot-build-indicator', task?.status === 'building');
  }, [document, task?.status]);
  useEffect(() => {
    const target = document?.defaultView;
    if (!target) return;
    const chosen = (event: Event) => chooseView((event as CustomEvent).detail === 'paper' ? 'paper' : 'changes');
    target.addEventListener(VIEW_CHOSEN_EVENT, chosen);
    return () => target.removeEventListener(VIEW_CHOSEN_EVENT, chosen);
  }, [document, chooseView]);
  // The review marks when its round can be shown in the whole paper.
  useEffect(() => {
    if (!document) { setFullPaper(false); return; }
    const root = document.documentElement, update = () => setFullPaper(root.dataset.fullPaper === 'available');
    update();
    const watcher = new MutationObserver(update);
    watcher.observe(root, { attributes: true, attributeFilter: ['data-full-paper'] });
    return () => watcher.disconnect();
  }, [document]);
  const fullPaperCallback = useRef(onFullPaperChange); fullPaperCallback.current = onFullPaperChange;
  useEffect(() => { onFullPaperChange?.(fullPaper); }, [fullPaper, onFullPaperChange]);
  useEffect(() => () => { fullPaperCallback.current?.(false); }, []);
  useEffect(() => {
    const view = document?.defaultView;
    if (!view) return;
    const open = (event: Event) => { event.preventDefault(); window.dispatchEvent(new Event('papilot:open-shortcuts')); };
    view.addEventListener('latex-review:help', open);
    return () => view.removeEventListener('latex-review:help', open);
  }, [document]);
  const taskBuilding = Boolean(task && (task.status === 'building' || task.pendingBuild || task.review?.state === 'building'));
  useEffect(() => {
    setPhase('loading'); setDisplayedRound(undefined);
    return () => { observer.current?.disconnect(); cropper.current?.disconnect(); };
  }, [attempt, shown, linkedRound, focusSequence]);
  useEffect(() => {
    if (phase === 'slow' && taskBuilding) { setPhase('loading'); return; }
    if (phase !== 'loading' || taskBuilding) return;
    const timer = setTimeout(() => setPhase(value => value === 'loading' ? 'slow' : value), 15000);
    return () => clearTimeout(timer);
  }, [phase, taskBuilding]);
  useEffect(() => {
    const element = toolbar.current; if (!element) return;
    const observer = new ResizeObserver(() => setReserve(Math.ceil(element.offsetWidth)));
    observer.observe(element); return () => observer.disconnect();
  }, [Boolean(tools)]);
  useEffect(() => {
    const element = leading.current; if (!element) { setLeadWidth(0); return; }
    const observer = new ResizeObserver(() => setLeadWidth(Math.ceil(element.offsetWidth)));
    observer.observe(element); return () => observer.disconnect();
  }, [Boolean(lead || modes)]);
  useEffect(() => {
    if (!document || !frame.current || !hostBar.current) return;
    const root = document.documentElement, bar = document.querySelector<HTMLElement>('.bar');
    const phone = window.matchMedia('(max-width: 680px)');
    // React clears refs on unmount before this effect's cleanup runs, and a
    // resize can be delivered in between; keep the elements this effect measures.
    const box = frame.current, host = hostBar.current;
    const sync = () => {
      if (!box.isConnected || !host.isConnected) return;
      root.toggleAttribute('data-papilot-phone', phone.matches);
      root.toggleAttribute('data-papilot-reader', readingPdf);
      root.style.setProperty('--papilot-tools', `${reserve}px`);
      root.style.setProperty('--papilot-rail', `${phone.matches ? 0 : railSlot?.offsetWidth || 0}px`);
      const mobileRail = phone.matches ? railSlot?.querySelector<HTMLElement>('.pdf-rail') : null;
      root.style.setProperty('--papilot-bottom-rail', `${mobileRail && mobileRail.offsetHeight > 0 ? mobileRail.offsetHeight + 8 : 0}px`);
      root.style.setProperty('--papilot-lead', `${leadWidth}px`);
      root.style.setProperty('--papilot-bar-height', `${host.offsetHeight}px`);
      root.toggleAttribute('data-papilot-toolbar-stacked', box.clientWidth - reserve - leadWidth < (phone.matches ? 185 : 220));
      const button = toolbar.current?.querySelector<HTMLElement>('.icon-button');
      if (button) root.style.setProperty('--papilot-button-size', `${button.offsetWidth}px`);
      if (bar) {
        root.style.setProperty('--papilot-review-bar-height', `${bar.offsetHeight}px`);
        if (phone.matches) railSlot?.style.removeProperty('top');
        else railSlot?.style.setProperty('top', `${bar.offsetHeight + (readingPdf ? host.offsetHeight : 0)}px`);
      }
    };
    const observer = new ResizeObserver(sync);
    observer.observe(box); observer.observe(host);
    if (bar) observer.observe(bar);
    let observedRail: HTMLElement | null = null;
    const watchRail = () => {
      const next = railSlot?.querySelector<HTMLElement>('.pdf-rail') || null;
      if (next !== observedRail) {
        if (observedRail) observer.unobserve(observedRail);
        observedRail = next;
        if (observedRail) observer.observe(observedRail);
      }
      sync();
    };
    let railWatcher: MutationObserver | null = null;
    if (railSlot) {
      observer.observe(railSlot);
      railWatcher = new MutationObserver(watchRail);
      railWatcher.observe(railSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-collapsed', 'data-suspended'] });
    }
    phone.addEventListener('change', sync); watchRail();
    return () => { observer.disconnect(); railWatcher?.disconnect(); phone.removeEventListener('change', sync); };
  }, [reserve, leadWidth, document, railSlot, readingPdf]);
  function loaded() {
    observer.current?.disconnect();
    try {
      const doc = frame.current?.contentDocument;
      if (!doc || (!doc.getElementById('root') && !doc.getElementById('paper'))) { setPhase('error'); return; }
      compactReviewFrame(doc, reserve, leadWidth, Boolean(changesOf));
      setDocument(doc);
      frame.current?.contentWindow?.addEventListener('latex-review:decided', () => { decided.current?.(); linksRef.current?.reload(); });
      // The viewer scrolls only its paper. Revealing or focusing something can
      // scroll its document or #root too, overflow hidden or not, which slides
      // the viewer's bar out from under our tools and the paper in; put them back.
      const root = doc.getElementById('root');
      doc.addEventListener('scroll', event => {
        const scrolled = event.target === doc ? doc.scrollingElement : event.target === root ? root : null;
        if (scrolled && (scrolled.scrollTop || scrolled.scrollLeft)) scrolled.scrollTo(0, 0);
      }, true);
      // Strips render after the viewer starts; re-measure the text edges when they change.
      let pending: ReturnType<typeof setTimeout> | undefined;
      cropper.current?.disconnect();
      cropper.current = new MutationObserver(records => {
        // Moving the current toolbar, adding notes and updating the minimap do
        // not change PDF text edges. Do not measure every glyph while scrolling.
        const contentChanged = records.some(record => record.type === 'attributes'
          ? (record.target as Element).matches('.pdf-strip img')
          : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
            ((node as Element).matches('.pdf-strip,.pdf-text') || (node as Element).querySelector('.pdf-strip,.pdf-text'))));
        if (!contentChanged) return;
        clearTimeout(pending); pending = setTimeout(() => cropMargins(doc), 150);
      });
      cropper.current.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      const inspect = () => {
        const paper = doc.getElementById('paper');
        if (!paper) return;
        setDisplayedRound(Number(doc.documentElement.dataset.papilotRound) || undefined);
        if (!changesOf && paper.querySelector('.comparison-waiting[data-state="failed"]') && !paper.querySelector('.pdf-strip img[src],.paper-page,.applied-page')) {
          setPhase('error'); return;
        }
        // An inline edit/annotation error must not hide an otherwise usable
        // review. Only the viewer's unavailable-document states need fallback.
        if (paper.querySelector('.empty[role="alert"],.paper-status[role="alert"]')) { setPhase('error'); return; }
        if (changesOf || !paper.querySelector('.waiting,.paper-status[role="status"]')) { setPhase('ready'); if (!onReadyChange) observer.current?.disconnect(); }
        else setPhase(value => value === 'error' || value === 'ready' ? 'loading' : value);
      };
      observer.current = new MutationObserver(records => {
        const relevant = records.some(record => record.type === 'attributes'
          ? record.target === doc.documentElement || (record.target as Element).matches('.comparison-waiting,.pdf-strip img')
          : !(record.target as Element).closest?.('.pdf-text,.change-map,.latex-highlight'));
        if (relevant) inspect();
      });
      observer.current.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-papilot-round', 'data-state', 'src'] });
      inspect();
      cropMargins(doc);
    } catch { setPhase('error'); }
  }
  useEffect(() => {
    if (!document) return;
    const root = window.document.documentElement;
    const sync = () => syncAppearance(root, document.documentElement);
    sync();
    const themeObserver = new MutationObserver(sync);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => themeObserver.disconnect();
  }, [document]);
  // The viewer's cards for writing stay above the keyboard. The workspace fits
  // itself above the keyboard, but not while the page is zoomed; the cards
  // then shorten by the part of the viewer the keyboard covers.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!document || !viewport) return;
    const sync = () => {
      const box = frame.current?.getBoundingClientRect(); if (!box) return;
      document.documentElement.style.setProperty('--keyboard', `${Math.max(0, Math.round(box.bottom - viewport.offsetTop - viewport.height))}px`);
    };
    sync(); viewport.addEventListener('resize', sync); viewport.addEventListener('scroll', sync); window.addEventListener('resize', sync);
    return () => { viewport.removeEventListener('resize', sync); viewport.removeEventListener('scroll', sync); window.removeEventListener('resize', sync); };
  }, [document]);
  const readiness = useRef(onReadyChange); readiness.current = onReadyChange;
  useEffect(() => { onReadyChange?.(ready, displayedRound); }, [ready, displayedRound, onReadyChange]);
  useEffect(() => () => { readiness.current?.(false); }, []);
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => {
    if (!document || !ready) { setSlot(null); return; }
    const find = () => setSlot(document.querySelector('.review-complete-actions'));
    find();
    const watch = new MutationObserver(find);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [document, ready]);
  // The card with Papilot's next step stays at the top of the review while the
  // author reads on, and lifts with a shadow once the paper scrolls under it.
  useEffect(() => {
    const paper = document?.getElementById('paper'), root = document?.documentElement;
    if (!paper || !root || !slot) return;
    const sync = () => root.toggleAttribute('data-papilot-scrolled', paper.scrollTop > 0);
    sync(); paper.addEventListener('scroll', sync, { passive: true });
    return () => { paper.removeEventListener('scroll', sync); root.removeAttribute('data-papilot-scrolled'); };
  }, [document, slot]);
  return <div className={'review-viewport' + (ready ? '' : ' review-pending') + (keepPdf ? ' keeps-pdf' : '')} aria-busy={!ready} aria-hidden={!ready && keepPdf && phase === 'loading' ? true : undefined}>
    <iframe ref={frame} key={`${attempt}:${shown}:${linkedRound || ''}:${focusSequence || ''}`} title={task ? t('{title} PDF change review', { title: task.title }) : t('Uncommitted changes in the PDF')} src={task ? reviewUrl(task, linkedRound, linkedChange) : changesUrl(changesOf!)} onLoad={loaded} onError={() => setPhase('error')} className="review-frame" aria-hidden={!ready} tabIndex={ready ? 0 : -1}/>
    {task && ready && <ReviewNoteConnections doc={document} round={linkedRound || task.review?.round || 0}/>}
    {task && ready && <NoteReviewControls doc={document}/>}
    <div ref={hostBar} className={'review-host-bar' + (readingPdf ? ' pdf-toolbar' : '')} role={readingPdf ? 'toolbar' : undefined} aria-label={readingPdf ? t('PDF controls') : undefined}>
      {(lead || modes || noteLinks?.focus) && <div ref={leading} className="review-lead">{lead}{modes}{task && ready && <NoteReviewScope/>}{readingPdf && <PdfContents outline={reader?.outline || []} section={reader?.section ?? -1} ready={Boolean(reader)} onSelect={item => readerCommand({ type: 'outline', index: reader!.outline.indexOf(item) })}/>}</div>}
      {readingPdf && <><div className="pdf-toolbar-spacer"/><PdfPageControls page={reader?.page || 1} pages={reader?.pages || 0} zoom={reader?.zoom || { value: 'page-width', scale: 1 }} onPage={page => readerCommand({ type: 'page', page })} onZoom={value => readerCommand({ type: 'zoom', value })} onZoomBy={factor => readerCommand({ type: 'zoomBy', factor })}/></>}
      {readingPdf && <PdfFindButton open={findOpen} onClick={() => findOpen ? closeFind() : setFindOpen(true)}/>}
      <div ref={toolbar} className="review-tools">{task && onComment && <ReviewNotes railSlot={railSlot} doc={ready && !noteLinks?.preview ? document : null} task={task} onComment={onComment}/>}{tools}</div>
      {readingPdf && findOpen && <PdfFind inputRef={findInput} query={query} matches={reader?.find || { current: 0, total: 0 }} notFound={reader?.find?.notFound || false} onQuery={value => { setQuery(value); readerCommand({ type: 'find', query: value, again: false, previous: false }); }} onNext={previous => readerCommand({ type: 'find', query, again: true, previous })} onClose={closeFind}/>}
    </div>
    {task && onComment && <div ref={setRailSlot} className="review-marking-rail"/>}
    {slot && completion ? createPortal(completion, slot) : null}
    {!ready && (!keepPdf || phase !== 'loading') && <div className="review-loading"><p role={phase === 'error' ? 'alert' : 'status'}>{phase === 'error' ? t('The PDF review could not be loaded.') : phase === 'slow' ? t('The PDF review is taking longer than expected.') : t('Loading PDF review…')}</p>{keepPdf && readingPdf && <button className="button secondary" onClick={() => chooseView('changes')}>{t('Changes')}</button>}{phase !== 'loading' && <button className="button secondary" onClick={() => { setPhase('loading'); setAttempt(value => value + 1); }}>{t('Reload review')}</button>}</div>}
  </div>;
}
