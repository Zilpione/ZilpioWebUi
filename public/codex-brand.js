export function codexInterfaceMark(className = "") {
  return `<span class="codex-interface-mark${className ? ` ${className}` : ""}" data-codex-interface-mark><img src="/zilpio-logo.png" alt="" /></span>`;
}
