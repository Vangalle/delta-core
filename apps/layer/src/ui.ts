export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
export function button(
  label: string,
  action: () => void,
  className = "subtle",
): HTMLButtonElement {
  const el = node("button", className, label);
  el.type = "button";
  el.addEventListener("click", action);
  return el;
}
export function grow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.max(72, el.scrollHeight)}px`;
}
export function placeDocumentChildren(
  parent: HTMLElement,
  desired: HTMLElement[],
): void {
  for (const [index, element] of desired.entries()) {
    const current = parent.children[index] ?? null;
    if (element === current) continue;
    if (
      element.parentElement === parent &&
      element.contains(document.activeElement)
    ) {
      const displaced: Element[] = [];
      for (
        let sibling: Element | null = current;
        sibling && sibling !== element;
        sibling = sibling.nextElementSibling
      )
        displaced.push(sibling);
      const reference = element.nextSibling;
      for (const sibling of displaced) parent.insertBefore(sibling, reference);
    } else parent.insertBefore(element, current);
  }
}
export function get<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element ${id}`);
  return el as T;
}
