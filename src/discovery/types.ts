export type DiscoveryProtocol = "a2a" | "mcp" | "openapi" | "webhook" | "rest";
export type DiscoveryJoinability = "connectable" | "manual" | "unknown";
export type DiscoveryCandidateStatus = "new" | "qualified" | "approved" | "rejected" | "connected";
export type DiscoveryHandshakeStatus = "queued" | "ok" | "failed";

export interface DiscoveryCandidate {
  id: string;
  title: string;
  description: string;
  homepageUrl: string;
  endpointUrl: string;
  protocols: DiscoveryProtocol[];
  capabilities: string[];
  auth: string;
  joinability: DiscoveryJoinability;
  trustScore: number;
  status: DiscoveryCandidateStatus;
  sourceKinds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  nextHandshakeAt?: string;
  lastHandshakeAt?: string;
  handshakeAttempts: number;
  lastHandshakeStatus?: DiscoveryHandshakeStatus;
  lastHandshakeCode?: number;
  lastHandshakeError?: string;
}

export interface DiscoveryRunResult {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  upserted: number;
  errors: string[];
}

export interface DiscoveryLogEntry {
  id: string;
  timestamp: string;
  type: string;
  level: "info" | "warn" | "error";
  summary: string;
  candidateId?: string;
  source?: string;
}

export interface DiscoveryHandshakeRunResult {
  startedAt: string;
  finishedAt: string;
  considered: number;
  attempted: number;
  connected: number;
  failed: number;
}
