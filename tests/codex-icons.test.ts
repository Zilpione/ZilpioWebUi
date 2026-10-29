import { describe, expect, test } from "bun:test";
import { codexInterfaceMark } from "../public/codex-brand.js";
import { codexIcon, codexIconNodes, hydrateCodexIcons } from "../public/codex-icons.js";

describe("Codex icon assets", () => {
  test("renders the Workspace logo", () => {
    const html = codexInterfaceMark("assistant-mark");
    expect(html).toContain('data-codex-interface-mark');
    expect(html).toContain('src="/zilpio-logo.png"');
    expect(html).toContain('alt=""');
  });

  test("renders a standard icon slot", () => {
    const html = codexIcon("arrowUp", "send-icon");
    expect(html).toContain('class="icon-slot send-icon"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("↑");
  });

  test("renders the filled stop square used by the active composer", () => {
    const html = codexIcon("square", "stop-icon");
    expect(html).toContain('class="icon-slot stop-icon"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('stroke="none"');
  });

  test("hydrates static placeholders", () => {
    const nodes = [{ dataset: { icon: "plus" }, innerHTML: "" }];
    hydrateCodexIcons({ querySelectorAll: () => nodes });
    expect(nodes[0].innerHTML).toContain(">+</text>");
  });
});
