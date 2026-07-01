/**
 * 用 DOMParser 解析静态模板并挂载到 shadow root，替代 `innerHTML` 赋值。
 *
 * 模板均为内置静态字符串（仅含常量与 i18n 文案，无任何用户输入），
 * DOMParser 不会执行脚本，addons-linter/Firefox 也不会对其发出
 * “对 innerHTML 进行不安全赋值” 告警，是 innerHTML 的官方安全替代。
 */
export function setShadowRootTemplate(
  shadowRoot: ShadowRoot,
  template: string,
): void {
  const parsed = new DOMParser().parseFromString(template, "text/html");
  const nodes = [
    ...Array.from(parsed.head.childNodes),
    ...Array.from(parsed.body.childNodes),
  ];
  shadowRoot.replaceChildren(
    ...nodes.map((node) => document.importNode(node, true)),
  );
}
