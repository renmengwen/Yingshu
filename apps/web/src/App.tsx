import { useCallback, useEffect, useState } from "react";

import { isSettingsSearch, resolveTheme, resolveThemePreference, type ThemePreference, withoutSettingsSearch, withSettingsSearch } from "./client-logic";
import { ProjectHomePage } from "./projects/ProjectHomePage";
import { ProjectPage } from "./projects/ProjectPage";
import { parseAppRoute } from "./projects/logic";
import { VideoWorkspacePage } from "./projects/VideoWorkspacePage";
import { ModelSettingsPage } from "./settings/ModelSettingsPage";

export function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    resolveThemePreference(localStorage.getItem("yingshu-theme")),
  );
  const [locationKey, setLocationKey] = useState(0);

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

  useEffect(() => {
    const syncLocation = () => setLocationKey((current) => current + 1);
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setLocationKey((current) => current + 1);
  }, []);

  const openSettings = useCallback(() => {
    navigate(`${window.location.pathname}${withSettingsSearch(window.location.search)}`);
  }, [navigate]);

  const closeSettings = useCallback(() => {
    navigate(`${window.location.pathname}${withoutSettingsSearch(window.location.search)}`);
  }, [navigate]);

  if (isSettingsSearch(window.location.search)) return <ModelSettingsPage onBack={closeSettings} />;

  const route = parseAppRoute(window.location.pathname);
  const common = { navigate, onOpenSettings: openSettings, themePreference, onThemeChange: setThemePreference };
  if (route.page === "home") return <ProjectHomePage {...common} />;
  if (route.page === "project") return <ProjectPage {...common} projectId={route.projectId} />;
  if (route.page === "video") return <VideoWorkspacePage navigate={navigate} projectId={route.projectId} videoId={route.videoId} onOpenSettings={openSettings} />;

  return <main key={locationKey} className="grid min-h-screen place-items-center bg-[var(--bg-canvas)] p-6 text-[var(--fg-primary)]">
    <section className="w-full max-w-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6" role="alert">
      <p className="font-mono text-xs text-[var(--accent)]">映述 / 页面不存在</p>
      <h1 className="mt-3 text-2xl font-semibold">无法打开这个地址</h1>
      <p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">请返回首页重新选择项目。</p>
      <button className="mt-5 min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" onClick={() => navigate("/")}>返回首页</button>
    </section>
  </main>;
}
