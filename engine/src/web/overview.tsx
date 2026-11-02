import { useEffect, useState } from "react";
import type { Summary } from "../types.ts";
import { t, tn, withLanguage } from "./i18n.ts";
export const STATUS: Record<string, string> = {
  editing: "Editing",
  reviewing: "In review",
  revise: "Awaiting revision",
  done: "All decided",
  build_failed: "Publish failed",
  building: "Publishing",
};
export function Overview() {
  const [tasks, setTasks] = useState<(Summary & { url: string })[]>([]),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/tasks");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!cancelled) {
          setTasks(data.tasks);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  const visible = tasks.filter(
    (t) =>
      `${t.title} ${t.task}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || t.state === filter),
  );
  return (
    <>
      <header className="bar">
        <a className="brand" href={withLanguage("/")}>
          LaTeX Review
        </a>
        <span className="status">
          {tn(tasks.length, "{n} open review", "{n} open reviews")}
        </span>
      </header>
      <main id="paper" className="index">
        <div className="document">
          <div className="overview-heading">
            <h1>{t("All reviews")}</h1>
          </div>
          <div className="task-tools">
            <input
              type="search"
              aria-label={t("Search reviews")}
              placeholder={t("Search by title or task name")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label={t("Filter reviews")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t("All tasks")}</option>
              <option value="reviewing">{t("Awaiting your review")}</option>
              <option value="building">{t("Publishing")}</option>
              <option value="revise">{t("Awaiting revision")}</option>
              <option value="done">{t("All decided")}</option>
            </select>
          </div>
          {error && <p role="alert">{error}</p>}
          <ul className="task-list">
            {visible.map((task) => {
              const total = Object.values(task.counts).reduce(
                  (a, b) => a + b,
                  0,
                ),
                decided = total - task.counts.pending;
              return (
                <li key={task.task}>
                  <a
                    className="task-card"
                    href={withLanguage(`/?task=${encodeURIComponent(task.task)}`)}
                  >
                    <div className="task-heading">
                      <h2>{task.title}</h2>
                      <span className="status" data-state={task.state}>
                        {t(STATUS[task.state])}
                      </span>
                    </div>
                    <div className="task-meta">
                      <span className="task-name">{task.task}</span>
                      {!task.round && <span>{t("Not published yet")}</span>}
                    </div>
                    {total > 0 && (
                      <div className="task-progress">
                        <span className="track">
                          <i style={{ width: `${(100 * decided) / total}%` }} />
                        </span>
                        <span>
                          {t("{decided} of {total} decided", { decided, total })}
                        </span>
                      </div>
                    )}
                    <div className="task-footer">
                      <div className="task-counts">
                        {Object.entries(task.counts)
                          .filter(([, n]) => n)
                          .map(([kind, n]) => (
                            <span key={kind} data-kind={kind}>
                              {t(`{n} ${kind}`, { n })}
                            </span>
                          ))}
                      </div>
                      <span className="task-open">
                        {task.counts.pending ? t("Review →") : t("Open →")}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
          {!visible.length && (
            <p className="empty">
              {tasks.length
                ? t("No reviews match this filter.")
                : t(
                    "No open reviews yet. Start a task from your document repository.",
                  )}
            </p>
          )}
        </div>
      </main>
    </>
  );
}
