import "./legacy-storage.ts";
import { createRoot } from "react-dom/client";
import { ReviewApp } from "./review.tsx";
import { language } from "./i18n.ts";
import "./style.css";
// Shared viewer components can be mounted in another application's document.
// Only this entrypoint owns the standalone viewer's document language.
document.documentElement.lang = language();
const params = new URLSearchParams(location.search),
  task = params.get("task"),
  round = Number(params.get("round")) || null;
// Papilot opens a task's review, or with ?changes its uncommitted changes.
createRoot(document.getElementById("root")!).render(
  params.has("changes") ? (
    <ReviewApp task="changes" pinned={null} changes />
  ) : task ? (
    <ReviewApp task={task} pinned={round} />
  ) : null,
);
