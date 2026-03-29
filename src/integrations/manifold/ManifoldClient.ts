export interface ManifoldLiteMarket {
  id: string;
  question: string;
  url: string;
  creatorName?: string;
  creatorUsername?: string;
  probability?: number;
  volume?: number;
  volume24Hours?: number;
  totalLiquidity?: number;
  closeTime?: number;
  createdTime?: number;
  lastUpdatedTime?: number;
  lastCommentTime?: number;
  lastBetTime?: number;
  isResolved?: boolean;
  resolution?: string;
  mechanism?: string;
  outcomeType?: string;
}

export interface ManifoldComment {
  id: string;
  userId?: string;
  userName?: string;
  userUsername?: string;
  contractId?: string;
  createdTime?: number;
  text: string;
  html?: string;
  url?: string;
}

interface ManifoldClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManifoldClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ManifoldClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.MANIFOLD_API_BASE_URL || "https://api.manifold.markets");
    this.apiKey = String(options.apiKey || process.env.MANIFOLD_API_KEY || "").trim();
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.MANIFOLD_TIMEOUT_MS || 8000));
  }

  public hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  public async listMarkets(input: {
    limit: number;
    sort?: "created-time" | "updated-time" | "last-bet-time" | "last-comment-time";
    order?: "asc" | "desc";
  }): Promise<ManifoldLiteMarket[]> {
    const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
    const sort = input.sort || "last-comment-time";
    const order = input.order || "desc";
    const result = await this.getJson<unknown[]>("/v0/markets", {
      limit: String(limit),
      sort,
      order
    });
    return Array.isArray(result) ? result.map(mapMarket) : [];
  }

  public async getMarket(marketId: string): Promise<ManifoldLiteMarket> {
    const cleanMarketId = String(marketId || "").trim();
    if (!cleanMarketId) {
      throw new Error("marketId is required");
    }
    const result = await this.getJson<unknown>(`/v0/market/${encodeURIComponent(cleanMarketId)}`);
    return mapMarket(result);
  }

  public async getComments(marketId: string, limit: number): Promise<ManifoldComment[]> {
    const cleanMarketId = String(marketId || "").trim();
    if (!cleanMarketId) {
      throw new Error("marketId is required");
    }
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));

    try {
      const primary = await this.getJson<unknown[]>("/v0/comments", {
        contractId: cleanMarketId,
        limit: String(safeLimit)
      });
      return Array.isArray(primary) ? primary.map(mapComment) : [];
    } catch {
      const fallback = await this.getJson<unknown[]>("/v0/comments", {
        marketId: cleanMarketId,
        limit: String(safeLimit)
      });
      return Array.isArray(fallback) ? fallback.map(mapComment) : [];
    }
  }

  private async getJson<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (!value) continue;
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json"
      };
      if (this.apiKey) {
        headers.Authorization = `Key ${this.apiKey}`;
      }

      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`manifold_http_${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "https://api.manifold.markets";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function mapMarket(raw: unknown): ManifoldLiteMarket {
  const value = asRecord(raw);
  return {
    id: stringField(value.id),
    question: stringField(value.question),
    url: stringField(value.url),
    creatorName: optionalStringField(value.creatorName),
    creatorUsername: optionalStringField(value.creatorUsername),
    probability: optionalNumberField(value.probability),
    volume: optionalNumberField(value.volume),
    volume24Hours: optionalNumberField(value.volume24Hours),
    totalLiquidity: optionalNumberField(value.totalLiquidity),
    closeTime: optionalNumberField(value.closeTime),
    createdTime: optionalNumberField(value.createdTime),
    lastUpdatedTime: optionalNumberField(value.lastUpdatedTime),
    lastCommentTime: optionalNumberField(value.lastCommentTime),
    lastBetTime: optionalNumberField(value.lastBetTime),
    isResolved: optionalBooleanField(value.isResolved),
    resolution: optionalStringField(value.resolution),
    mechanism: optionalStringField(value.mechanism),
    outcomeType: optionalStringField(value.outcomeType)
  };
}

function mapComment(raw: unknown): ManifoldComment {
  const value = asRecord(raw);
  const html = optionalStringField(value.contentHtml) || optionalStringField(value.html);
  const markdown = optionalStringField(value.contentMarkdown) || optionalStringField(value.markdown);
  const text = optionalStringField(value.text) || markdown || stripHtml(html || "");
  return {
    id: stringField(value.id),
    userId: optionalStringField(value.userId),
    userName: optionalStringField(value.userName) || optionalStringField(value.user?.name),
    userUsername: optionalStringField(value.userUsername) || optionalStringField(value.user?.username),
    contractId: optionalStringField(value.contractId),
    createdTime: optionalNumberField(value.createdTime),
    text,
    html,
    url: optionalStringField(value.url)
  };
}

function stripHtml(value: string): string {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, any> {
  if (value && typeof value === "object") {
    return value as Record<string, any>;
  }
  return {};
}

function stringField(value: unknown): string {
  return String(value || "").trim();
}

function optionalStringField(value: unknown): string | undefined {
  const clean = String(value || "").trim();
  return clean ? clean : undefined;
}

function optionalNumberField(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function optionalBooleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
