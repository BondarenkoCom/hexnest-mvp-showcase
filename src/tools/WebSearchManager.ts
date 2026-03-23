import { newId, nowIso } from "../utils/ids";

export type WebSearchJobStatus = "queued" | "running" | "done" | "failed" | "timeout";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchJob {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  status: WebSearchJobStatus;
  query: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results?: SearchResult[];
  error?: string;
}

export type WebSearchJobUpdateKind = "queued" | "started" | "finished";

export interface WebSearchJobUpdate {
  kind: WebSearchJobUpdateKind;
  job: WebSearchJob;
}

export interface WebSearchManagerOptions {
  concurrency: number;
  maxResults: number;
  timeoutMs: number;
  onUpdate?: (update: WebSearchJobUpdate) => void;
}

export class WebSearchManager {
  private readonly jobs = new Map<string, WebSearchJob>();
  private readonly roomJobs = new Map<string, string[]>();
  private readonly queue: string[] = [];
  private activeCount = 0;

  constructor(private readonly options: WebSearchManagerOptions) {}

  public static defaultOptions(
    onUpdate?: (update: WebSearchJobUpdate) => void
  ): WebSearchManagerOptions {
    return {
      concurrency: 3,
      maxResults: 8,
      timeoutMs: 15_000,
      onUpdate
    };
  }

  public submit(input: {
    roomId: string;
    agentId: string;
    agentName: string;
    query: string;
  }): WebSearchJob {
    const query = (input.query || "").trim();
    if (!query) throw new Error("query is required");
    if (query.length > 500) throw new Error("query too long (max 500 chars)");

    const job: WebSearchJob = {
      id: newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      agentName: input.agentName,
      status: "queued",
      query,
      createdAt: nowIso()
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);

    const roomList = this.roomJobs.get(job.roomId) || [];
    roomList.unshift(job.id);
    this.roomJobs.set(job.roomId, roomList);

    this.emit("queued", job);
    this.drain();
    return cloneJob(job);
  }

  public listByRoom(roomId: string): WebSearchJob[] {
    const ids = this.roomJobs.get(roomId) || [];
    return ids
      .map((id) => this.jobs.get(id))
      .filter((item): item is WebSearchJob => Boolean(item))
      .map((job) => cloneJob(job));
  }

  public get(jobId: string): WebSearchJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  private drain(): void {
    while (this.activeCount < this.options.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      void this.runJob(jobId);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.activeCount += 1;
    job.status = "running";
    job.startedAt = nowIso();
    this.emit("started", job);

    try {
      const results = await this.searchDuckDuckGo(job.query);
      job.status = "done";
      job.results = results;
      job.finishedAt = nowIso();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = nowIso();
    } finally {
      this.emit("finished", job);
      this.activeCount -= 1;
      this.drain();
    }
  }

  private async searchDuckDuckGo(query: string): Promise<SearchResult[]> {
    const encoded = encodeURIComponent(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Referer": "https://html.duckduckgo.com/"
    };

    try {
      // Try html.duckduckgo.com first
      let res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: `q=${encoded}&b=`,
        signal: controller.signal
      });
      let html = await res.text();
      let results = this.parseResults(html);

      // Fallback to lite version if empty
      if (results.length === 0) {
        res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
          headers,
          signal: controller.signal
        });
        html = await res.text();
        results = this.parseLiteResults(html);
      }

      return results;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    // DuckDuckGo HTML results are in <div class="result"> blocks
    // Each has <a class="result__a"> for title/url and <a class="result__snippet"> for snippet
    const resultBlocks = html.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < this.options.maxResults; i++) {
      const block = resultBlocks[i];

      // Extract URL and title from result__a
      const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;

      let rawUrl = linkMatch[1];
      const title = stripHtml(linkMatch[2]).trim();

      // DuckDuckGo wraps URLs through a redirect — extract the actual URL
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      }

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";

      if (title && rawUrl.startsWith("http")) {
        results.push({ title, url: rawUrl, snippet });
      }
    }

    return results;
  }

  private parseLiteResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    // Lite version has results in table rows with class "result-link" and "result-snippet"
    const rows = html.split(/<tr>/);
    let currentTitle = "";
    let currentUrl = "";

    for (const row of rows) {
      const linkMatch = row.match(/class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (linkMatch) {
        currentUrl = linkMatch[1];
        currentTitle = stripHtml(linkMatch[2]).trim();
        // DuckDuckGo lite also wraps URLs
        const uddgMatch = currentUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) currentUrl = decodeURIComponent(uddgMatch[1]);
      }

      const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
      if (snippetMatch && currentTitle && currentUrl.startsWith("http")) {
        results.push({
          title: currentTitle,
          url: currentUrl,
          snippet: stripHtml(snippetMatch[1]).trim()
        });
        currentTitle = "";
        currentUrl = "";
        if (results.length >= this.options.maxResults) break;
      }
    }
    return results;
  }

  private emit(kind: WebSearchJobUpdateKind, job: WebSearchJob): void {
    if (!this.options.onUpdate) return;
    this.options.onUpdate({ kind, job: cloneJob(job) });
  }
}

function cloneJob(job: WebSearchJob): WebSearchJob {
  return JSON.parse(JSON.stringify(job)) as WebSearchJob;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}
