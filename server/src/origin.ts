// 共享的 Origin 解析/校验。
//
// 叶子模块：除标准库外无任何业务依赖，供「配置期 ALLOWED_ORIGINS 白名单
// 校验」与「运行期 Firefox 扩展 Origin 放行」复用同一份裸 origin 规则，
// 避免与 app/security/config 形成循环导入。
//
// 「裸 origin」定义：`scheme://host`，无路径/查询/片段/userinfo/尾斜杠/
// 混合大小写 host —— 与 HTTP `Origin` 头被精确匹配的形态一致。

export type BareOriginCheck =
  | { ok: true; canonical: string; scheme: string; host: string }
  | { ok: false; reason: "empty" | "wildcard" | "invalid_url" | "no_host" }
  | { ok: false; reason: "unsupported_scheme"; scheme: string }
  | { ok: false; reason: "not_bare"; canonical: string };

export function checkBareOrigin(
  origin: unknown,
  allowedSchemes: ReadonlySet<string>,
): BareOriginCheck {
  if (typeof origin !== "string" || origin.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (origin.includes("*")) {
    return { ok: false, reason: "wildcard" };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (!allowedSchemes.has(parsed.protocol)) {
    return { ok: false, reason: "unsupported_scheme", scheme: parsed.protocol };
  }
  if (parsed.host.length === 0) {
    return { ok: false, reason: "no_host" };
  }

  const canonical = `${parsed.protocol}//${parsed.host}`;
  if (origin !== canonical) {
    return { ok: false, reason: "not_bare", canonical };
  }
  return { ok: true, canonical, scheme: parsed.protocol, host: parsed.host };
}

const MOZ_EXTENSION_ONLY: ReadonlySet<string> = new Set(["moz-extension:"]);

// Firefox 为每个安装分配的内部 UUID 是标准 UUID 文本形态：小写
// 8-4-4-4-12 hex（实测如 `2b83faf4-40af-4e98-a9aa-e63c93821add`）。
// 不强制 version/variant 半字节，避免跨 Firefox 版本生成方式差异时误伤。
const FIREFOX_EXTENSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 运行期判定：origin 是否为格式正确的裸 `moz-extension://<uuid>`。
//
// 除裸 origin 规则外，额外要求 host 为 Firefox UUID 形态——使代码与
// 文档「accept any well-formed moz-extension://<uuid>」精确一致，并剔除
// `moz-extension://not-a-uuid`、`moz-extension://foo:99` 等真实 Firefox
// 永不产生的串。注意：这不是鉴权——非浏览器客户端可伪造任意 Origin
// （含 UUID 形状串），真实边界是 room/member token；此处仅收窄到“看起来
// 确实是 Firefox 扩展源”的纵深防御粒度，并保持与文档一致。
export function isBareMozExtensionOrigin(origin: string | null): boolean {
  if (origin === null) {
    return false;
  }
  const result = checkBareOrigin(origin, MOZ_EXTENSION_ONLY);
  return result.ok && FIREFOX_EXTENSION_UUID.test(result.host);
}
