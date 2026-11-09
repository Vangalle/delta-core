import { node } from "./ui.ts";

export class AuthorIdentity {
  element = node("div", "author-rail");
  private signature = "";
  update(id: string, name: string, agent = false): void {
    const signature = JSON.stringify([id, name, agent]);
    if (signature === this.signature) return;
    this.signature = signature;
    const avatar = node("span", "author-avatar");
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", `${name} avatar`);
    avatar.title = name;
    const words = name.trim().split(/\s+/);
    const characters = [...name.trim()];
    avatar.textContent = agent
      ? "AI"
      : /\p{Script=Han}/u.test(name)
        ? (characters[0] ?? "?")
        : words.length > 1
          ? `${words[0][0]}${words.at(-1)![0]}`.toUpperCase()
          : characters.slice(0, 2).join("").toUpperCase();
    if (agent) avatar.classList.add("agent-avatar");
    const label = node("span", "author-name", name);
    label.title = name;
    this.element.replaceChildren(avatar, label);
  }
}
