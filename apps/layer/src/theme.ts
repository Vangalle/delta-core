export type Theme = "light" | "dark";
const eventName = "delta-theme-change";
export function setupTheme(select: HTMLSelectElement): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("delta:theme");
  } catch {}
  const apply = (theme: Theme) => {
    document.documentElement.dataset.theme = theme;
    select.value = theme;
    window.dispatchEvent(new Event(eventName));
  };
  apply(saved === "light" ? "light" : "dark");
  select.addEventListener("change", () => {
    const theme: Theme = select.value === "light" ? "light" : "dark";
    apply(theme);
    try {
      localStorage.setItem("delta:theme", theme);
    } catch {}
  });
}
export function onThemeChange(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
