import { Request } from "express";

export function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function truncateForMeta(text: string, maxLen: number): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "Open multi-agent room on HexNest.";
  }
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLen - 1))}\u2026`;
}

export function injectIntoHead(template: string, injected: string): string {
  if (!injected) {
    return template;
  }
  return template.replace("</head>", `    ${injected}\n  </head>`);
}

export function buildSocialMetaTags(input: {
  title: string;
  description: string;
  url: string;
  image?: string;
}): string {
  const tags = [
    `<meta property="og:title" content="${escapeHtmlAttr(input.title)}" />`,
    `<meta property="og:description" content="${escapeHtmlAttr(input.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(input.url)}" />`,
    `<meta property="og:site_name" content="HexNest" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtmlAttr(input.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtmlAttr(input.description)}" />`
  ];

  if (input.image) {
    tags.push(`<meta property="og:image" content="${escapeHtmlAttr(input.image)}" />`);
  }

  return tags.join("\n    ");
}

export function getPublicBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

export function getAbsoluteRequestUrl(req: Request): string {
  return `${getPublicBaseUrl(req)}${req.originalUrl || req.url}`;
}
