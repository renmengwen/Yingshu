(() => {
  const root = document.documentElement;
  const themeButtons = [...document.querySelectorAll("[data-theme-value]")];
  const storedTheme = sessionStorage.getItem("yingshu-mockup-theme") || "light";

  function setTheme(theme) {
    root.dataset.theme = theme;
    sessionStorage.setItem("yingshu-mockup-theme", theme);
    themeButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.themeValue === theme)));
  }
  themeButtons.forEach((button) => button.addEventListener("click", () => setTheme(button.dataset.themeValue)));
  setTheme(storedTheme);

  let returnFocus = null;
  let activeDialog = null;
  const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

  function closeDialog(dialog, force = false) {
    if (!dialog) return;
    const dirty = dialog.dataset.dirty === "true";
    const warning = dialog.querySelector("[data-unsaved-warning]");
    if (dirty && !force && warning) {
      warning.hidden = false;
      warning.querySelector("button")?.focus();
      return;
    }
    dialog.hidden = true;
    dialog.dataset.dirty = "false";
    if (warning) warning.hidden = true;
    activeDialog = null;
    returnFocus?.focus();
  }

  document.querySelectorAll("[data-dialog-open]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const dialog = document.getElementById(trigger.dataset.dialogOpen);
      if (!dialog) return;
      returnFocus = trigger;
      activeDialog = dialog;
      dialog.hidden = false;
      const initialFocus = dialog.querySelector("[autofocus]") || dialog.querySelector(focusableSelector);
      initialFocus?.focus();
    });
  });
  document.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest(".dialog-backdrop"))));
  document.querySelectorAll("[data-dialog-discard]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest(".dialog-backdrop"), true)));
  document.querySelectorAll(".dialog-backdrop input, .dialog-backdrop textarea, .dialog-backdrop select").forEach((control) => control.addEventListener("input", () => {
    const dialog = control.closest(".dialog-backdrop");
    if (dialog) dialog.dataset.dirty = "true";
  }));

  document.addEventListener("keydown", (event) => {
    if (!activeDialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog(activeDialog);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...activeDialog.querySelectorAll(focusableSelector)].filter((item) => item.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  document.querySelectorAll("[data-apply-dialog]").forEach((button) => button.addEventListener("click", () => {
    const dialog = button.closest(".dialog-backdrop");
    dialog.dataset.dirty = "false";
    closeDialog(dialog, true);
    showToast(button.dataset.message || "修改已应用到当前草稿，尚未保存。", "status");
  }));

  document.querySelectorAll("[data-paginated]").forEach((region) => {
    let page = 1;
    const rows = [...region.querySelectorAll("tbody tr")];
    const cards = [...region.querySelectorAll(".mobile-card")];
    const sizeSelect = region.querySelector("[data-page-size]");
    const count = region.querySelector("[data-page-count]");
    const prev = region.querySelector("[data-page-prev]");
    const next = region.querySelector("[data-page-next]");
    const current = region.querySelector("[data-page-current]");
    const render = () => {
      const size = Number(sizeSelect?.value || 10);
      const pages = Math.max(1, Math.ceil(rows.length / size));
      page = Math.min(page, pages);
      rows.forEach((row, index) => row.hidden = index < (page - 1) * size || index >= page * size);
      cards.forEach((card, index) => card.hidden = index < (page - 1) * size || index >= page * size);
      if (count) count.textContent = `共 ${rows.length} 条`;
      if (current) current.textContent = `${page} / ${pages}`;
      if (prev) prev.disabled = page === 1;
      if (next) next.disabled = page === pages;
    };
    sizeSelect?.addEventListener("change", () => { page = 1; render(); });
    prev?.addEventListener("click", () => { page -= 1; render(); });
    next?.addEventListener("click", () => { page += 1; render(); });
    render();
  });

  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
    const group = tab.closest("[data-tabs]");
    group.querySelectorAll("[data-tab]").forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
    group.parentElement.querySelectorAll("[data-tab-panel]").forEach((panel) => panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab);
  }));

  document.querySelectorAll("[data-candidate]").forEach((candidate) => candidate.addEventListener("click", () => {
    candidate.closest("[data-candidate-group]").querySelectorAll("[data-candidate]").forEach((item) => item.classList.remove("is-selected"));
    candidate.classList.add("is-selected");
    const approve = candidate.closest(".dialog").querySelector("[data-approve-candidate]");
    approve.disabled = false;
    approve.textContent = `批准候选 ${candidate.dataset.candidate}`;
  }));

  document.querySelectorAll("[data-approve-candidate]").forEach((button) => button.addEventListener("click", () => {
    closeDialog(button.closest(".dialog-backdrop"), true);
    showToast("画面 07 已批准候选，其他候选继续保留为历史记录。", "status");
  }));

  document.querySelectorAll("[data-async]").forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = button.dataset.loading || "正在处理…";
    window.setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
      showToast(button.dataset.success || "操作已完成。", "status");
    }, 900);
  }));

  function showToast(message) {
    const toast = document.querySelector("[data-toast]");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.hidden = true, 3600);
  }
})();
