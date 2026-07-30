import { useEffect, useRef, useState } from "react";

import {
  chapterPagePath,
  isSettingsSearch,
  resolveTheme,
  resolveThemePreference,
  responseJson,
  seriesWorkspaceFromSearch,
  seriesWorkspacePath,
  type ThemePreference,
  withSettingsSearch,
  withoutSettingsSearch,
} from "./client-logic";
import { ProductionWorkspace } from "./ProductionWorkspace";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { ModelSettingsPage } from "./settings/ModelSettingsPage";

interface Book {
  id: string;
  title: string;
  author: string | null;
  encoding: string;
  import_status: string;
  chapter_count: number;
}

interface Chapter {
  id: string;
  title: string;
  chapter_index: number;
  char_count: number;
}

interface SeriesProject {
  id: string;
  bookId: string;
  title: string;
}

export function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    resolveThemePreference(localStorage.getItem("yingshu-theme")),
  );
  const [books, setBooks] = useState<Book[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [selectedBook, setSelectedBook] = useState<string>();
  const [activeSeries, setActiveSeries] = useState<SeriesProject>();
  const [showSettings, setShowSettings] = useState(() => isSettingsSearch(window.location.search));
  const [chapterText, setChapterText] = useState("");
  const [selectedChapterId, setSelectedChapterId] = useState<string>();
  const [pendingBookDelete, setPendingBookDelete] = useState<Book>();
  const [pendingChapterDelete, setPendingChapterDelete] = useState<Chapter>();
  const [status, setStatus] = useState("正在加载书库…");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function loadBooks(announce = true) {
    const body = await responseJson<{ items: Book[] }>(await fetch("/api/books"));
    setBooks(body.items);
    if (announce) setStatus(body.items.length ? `已加载 ${body.items.length} 本书` : "书库为空，请导入 TXT");
    return body.items;
  }

  useEffect(() => {
    async function initialize() {
      const loadedBooks = await loadBooks(false);
      const location = seriesWorkspaceFromSearch(window.location.search);
      if (!location) {
        setStatus(loadedBooks.length ? `已加载 ${loadedBooks.length} 本书` : "书库为空，请导入 TXT");
        return;
      }
      if (!loadedBooks.some((book) => book.id === location.bookId)) throw new Error("工作台关联书籍不存在");
      const body = await responseJson<{ items: SeriesProject[] }>(
        await fetch(`/api/books/${encodeURIComponent(location.bookId)}/series`),
      );
      const series = body.items.find((item) => item.id === location.seriesId);
      if (!series) throw new Error("系列项目不存在");
      setActiveSeries(series);
      setStatus(`已恢复系列项目：${series.title}`);
    }
    initialize().catch((error: Error) => setStatus(`加载失败：${error.message}`));
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = resolveTheme(themePreference, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    if (themePreference === "system") localStorage.removeItem("yingshu-theme");
    else localStorage.setItem("yingshu-theme", themePreference);
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  async function importFile(file: File) {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStatus("正在导入并索引 TXT，请稍候…");
    try {
      const body = await responseJson<{ message: string; chapter_count: number }>(
        await fetch("/api/books/import", {
          method: "POST",
          headers: { "Content-Type": file.type || "text/plain", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
          signal: controller.signal,
        }),
      );
      abortRef.current = null;
      const successMessage = `${body.message}，共 ${body.chapter_count} 章`;
      try {
        await loadBooks(false);
        setStatus(successMessage);
      } catch (error) {
        setStatus(`${successMessage}；书库刷新失败：${(error as Error).message}`);
      }
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "导入已中断" : `导入失败：${(error as Error).message}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function openBook(bookId: string) {
    if (busy) return;
    setBusy(true);
    setSelectedBook(bookId);
    setChapterText("");
    setSelectedChapterId(undefined);
    setChapters([]);
    setChapterTotal(0);
    setStatus("正在加载章节…");
    try {
      const body = await responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, 0)));
      setChapters(body.items);
      setChapterTotal(body.total);
      setStatus(`已加载 ${body.items.length}/${body.total} 章`);
    } catch (error) {
      setStatus(`章节加载失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreChapters() {
    if (!selectedBook || busy || chapters.length >= chapterTotal) return;
    setBusy(true);
    setStatus(`正在加载更多章节（${chapters.length}/${chapterTotal}）…`);
    try {
      const body = await responseJson<{ items: Chapter[]; total: number }>(
        await fetch(chapterPagePath(selectedBook, chapters.length)),
      );
      setChapters((current) => [...current, ...body.items]);
      setChapterTotal(body.total);
      setStatus(`已加载 ${chapters.length + body.items.length}/${body.total} 章`);
    } catch (error) {
      setStatus(`更多章节加载失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openChapter(chapterId: string) {
    if (!selectedBook || busy) return;
    setBusy(true);
    setStatus("正在读取原文…");
    try {
      const body = await responseJson<{ text: string }>(await fetch(`/api/books/${selectedBook}/chapters/${chapterId}/text`));
      setChapterText(body.text);
      setSelectedChapterId(chapterId);
      setStatus("原文已加载");
    } catch (error) {
      setStatus(`原文读取失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteChapter(chapter: Chapter) {
    if (!selectedBook || busy) return;
    setPendingChapterDelete(undefined);
    setBusy(true);
    setStatus(`正在删除章节“${chapter.title}”…`);
    try {
      const body = await responseJson<{ message: string }>(await fetch(
        `/api/books/${encodeURIComponent(selectedBook)}/chapters/${encodeURIComponent(chapter.id)}`,
        { method: "DELETE" },
      ));
      setChapters((current) => current.filter((item) => item.id !== chapter.id));
      setChapterTotal((current) => Math.max(0, current - 1));
      if (selectedChapterId === chapter.id) {
        setChapterText("");
        setSelectedChapterId(undefined);
      }
      try {
        await loadBooks(false);
        setStatus(body.message);
      } catch (error) {
        setStatus(`${body.message}；书库计数刷新失败：${(error as Error).message}`);
      }
    } catch (error) {
      setStatus(`章节删除失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteBook(book: Book) {
    if (busy) return;
    setPendingBookDelete(undefined);
    setBusy(true);
    setStatus(`正在删除小说“${book.title}”及其全部项目数据…`);
    try {
      const body = await responseJson<{ message: string }>(await fetch(
        `/api/books/${encodeURIComponent(book.id)}`,
        { method: "DELETE" },
      ));
      setBooks((current) => current.filter((item) => item.id !== book.id));
      if (selectedBook === book.id) {
        setSelectedBook(undefined);
        setChapters([]);
        setChapterTotal(0);
        setChapterText("");
        setSelectedChapterId(undefined);
      }
      setStatus(body.message);
    } catch (error) {
      setStatus(`小说删除失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function enterSeriesWorkspace() {
    if (!selectedBook || busy) return;
    const book = books.find((item) => item.id === selectedBook);
    if (!book) return;
    setBusy(true);
    setStatus("正在准备系列项目…");
    try {
      const existing = await responseJson<{ items: SeriesProject[] }>(
        await fetch(`/api/books/${encodeURIComponent(book.id)}/series`),
      );
      const series = existing.items[0] ?? (await responseJson<{ series: SeriesProject }>(
        await fetch(`/api/books/${encodeURIComponent(book.id)}/series`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `${book.title}视觉说书` }),
        }),
      )).series;
      setActiveSeries(series);
      window.history.pushState(null, "", seriesWorkspacePath(book.id, series.id));
      setStatus(existing.items.length ? `已进入系列项目：${series.title}` : `系列项目已创建：${series.title}`);
    } catch (error) {
      setStatus(`进入下一步失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function leaveSeriesWorkspace() {
    setActiveSeries(undefined);
    window.history.pushState(null, "", window.location.pathname);
    setStatus("已返回书库");
  }

  function openSettings() {
    setShowSettings(true);
    window.history.pushState(null, "", `${window.location.pathname}${withSettingsSearch(window.location.search)}`);
    setStatus("已打开设置");
  }

  function closeSettings() {
    setShowSettings(false);
    window.history.pushState(null, "", `${window.location.pathname}${withoutSettingsSearch(window.location.search)}`);
    setStatus(activeSeries ? `已返回系列项目：${activeSeries.title}` : "已返回书库");
  }

  if (showSettings) return <ModelSettingsPage onBack={closeSettings} />;

  if (activeSeries) return <ProductionWorkspace
    bookId={activeSeries.bookId}
    series={activeSeries}
    initialStatus={status}
    onLeave={leaveSeriesWorkspace}
    onOpenSettings={openSettings}
  />;

  return (
    <main className="workspace-shell">
      <div className="workspace-frame">
        <header className="topbar">
          <div className="brand-block">
            <p className="eyebrow">映述 / YINGSHU</p>
            <div className="title-row">
              <h1>长篇故事书库</h1>
              <span className="phase-tag">PHASE 01</span>
            </div>
            <p className="subtitle">导入真实 TXT，核对编码、章节和原文证据。</p>
          </div>
          <div className="toolbar">
            <div className="theme-control" role="group" aria-label="页面主题">
              {(["system", "light", "dark"] as const).map((preference) => (
                <button
                  className="theme-option"
                  type="button"
                  key={preference}
                  aria-pressed={themePreference === preference}
                  onClick={() => setThemePreference(preference)}
                >
                  {preference === "system" ? "系统" : preference === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
            <label className={`button-primary ${busy ? "is-disabled" : ""}`}>
              {busy ? "正在处理…" : "导入 TXT"}
              <input
                className="sr-only"
                type="file"
                accept=".txt,text/plain"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button className="button-secondary" type="button" onClick={openSettings}>
              设置
            </button>
            <button
              className="button-primary"
              type="button"
              disabled={!selectedBook || busy}
              onClick={() => void enterSeriesWorkspace()}
            >
              {busy && selectedBook ? "正在准备…" : "下一步：系列工作台"}
            </button>
            {busy && abortRef.current ? (
              <button className="button-secondary" type="button" onClick={() => abortRef.current?.abort()}>
                中断导入
              </button>
            ) : null}
          </div>
        </header>

        <div className="status-strip" role="status" aria-live="polite">
          <span className={busy ? "status-dot is-active" : "status-dot"} aria-hidden="true" />
          <span>{status}</span>
        </div>

        <div className="workspace-grid">
          <section className="panel" aria-labelledby="books-heading">
            <div className="panel-heading">
              <h2 id="books-heading">书籍</h2>
              <span>{books.length}</span>
            </div>
            <div className="panel-list">
              {books.map((book) => <div key={book.id} className="group relative">
                <button
                  disabled={busy}
                  onClick={() => void openBook(book.id)}
                  className={`list-item pr-16 ${selectedBook === book.id ? "is-selected" : ""}`}
                >
                  <span className="item-title" title={book.title}>{book.title}</span>
                  <span className="item-meta">{book.encoding} / {book.chapter_count} 章</span>
                </button>
                <button type="button" disabled={busy} onClick={() => setPendingBookDelete(book)} aria-label={`删除小说“${book.title}”`} title={`删除小说“${book.title}”`} className="absolute right-1 top-0 min-h-11 px-3 text-xs font-semibold text-[var(--danger)] opacity-100 transition-colors hover:bg-[var(--danger-soft)] focus-visible:opacity-100 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">删除</button>
              </div>)}
              {!books.length ? <p className="empty-state">尚未导入书籍</p> : null}
            </div>
          </section>

          <section className="panel" aria-labelledby="chapters-heading">
            <div className="panel-heading">
              <h2 id="chapters-heading">章节索引</h2>
              <span>{chapters.length}</span>
            </div>
            <div className="panel-list scroll-region">
              {chapters.map((chapter) => <div key={chapter.id} className="group relative">
                <button disabled={busy} onClick={() => void openChapter(chapter.id)} className="list-item chapter-item pr-16">
                  <span className="chapter-index">{String(chapter.chapter_index + 1).padStart(3, "0")}</span>
                  <span className="item-title" title={chapter.title}>{chapter.title}</span>
                </button>
                <button type="button" disabled={busy} onClick={() => setPendingChapterDelete(chapter)} aria-label={`删除章节“${chapter.title}”`} title={`删除章节“${chapter.title}”`} className="absolute right-1 top-0 min-h-11 px-3 text-xs font-semibold text-[var(--danger)] opacity-100 transition-colors hover:bg-[var(--danger-soft)] focus-visible:opacity-100 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">删除</button>
              </div>)}
              {chapters.length < chapterTotal ? (
                <button className="load-more" type="button" disabled={busy} onClick={() => void loadMoreChapters()}>
                  加载更多（{chapters.length}/{chapterTotal}）
                </button>
              ) : null}
              {!chapters.length ? <p className="empty-state">选择书籍后查看章节</p> : null}
            </div>
          </section>

          <section className="panel evidence-panel" aria-labelledby="evidence-heading">
            <div className="panel-heading">
              <h2 id="evidence-heading">原文证据</h2>
              <span>READ ONLY</span>
            </div>
            <pre className="evidence-text">
              {chapterText || "选择章节后在此查看原文。"}
            </pre>
          </section>
        </div>
        <AlertDialog open={!!pendingBookDelete} onOpenChange={(open) => { if (!open) setPendingBookDelete(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>永久删除这部小说及全部项目？</AlertDialogTitle>
              <AlertDialogDescription>
                删除后无法恢复小说“{pendingBookDelete?.title}”的本地副本、全部章节与事件、系列分集、稿件与审批、资产候选、配音字幕、视觉段、渲染文件和任务记录。你电脑上原来导入的 TXT 文件不会被修改。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => { if (pendingBookDelete) void deleteBook(pendingBookDelete); }}>永久删除全部内容</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={!!pendingChapterDelete} onOpenChange={(open) => { if (!open) setPendingChapterDelete(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>永久删除这一章？</AlertDialogTitle>
              <AlertDialogDescription>
                删除后无法恢复章节“{pendingChapterDelete?.title}”的本地索引、事件分析和任务记录。原始 TXT 不会被改写；已被分集引用的章节不会删除。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => { if (pendingChapterDelete) void deleteChapter(pendingChapterDelete); }}>永久删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </main>
  );
}
