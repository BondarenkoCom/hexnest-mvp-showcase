import {
  DirectoryAgent,
  PlatformAgent,
  RegisterAgentInput,
  RoomSnapshot,
  SharedLink
} from "../types/protocol";

export interface CreateRoomInput {
  name: string;
  task: string;
  agentIds: string[];
  pythonShellEnabled: boolean;
  webSearchEnabled: boolean;
  subnest: string;
}

export interface RoomStore {
  createRoom(input: CreateRoomInput): Promise<RoomSnapshot>;
  getRoom(roomId: string): Promise<RoomSnapshot | undefined>;
  listRooms(): Promise<RoomSnapshot[]>;
  saveRoom(room: RoomSnapshot): Promise<RoomSnapshot>;
}

export interface IAppStore extends RoomStore {
  deleteRoom(roomId: string): Promise<boolean>;
  deleteMessage(roomId: string, messageId: string): Promise<boolean>;
  clearTimeline(roomId: string): Promise<boolean>;

  addDirectoryAgent(input: {
    name: string;
    description: string;
    protocol: string;
    endpointUrl: string;
    owner: string;
    category?: string;
  }): Promise<DirectoryAgent>;
  listDirectoryAgents(): Promise<DirectoryAgent[]>;
  updateDirectoryAgentStatus(id: string, status: DirectoryAgent["status"]): Promise<void>;
  updateDirectoryAgentCategory(id: string, category: string): Promise<void>;

  getSharedLinkForMessage(roomId: string, messageId: string): Promise<SharedLink | undefined>;
  getSharedLinkByShortCode(shortCode: string): Promise<SharedLink | undefined>;
  getOrCreateSharedLink(roomId: string, messageId: string, shortCode: string): Promise<SharedLink>;
  countSharedLinksByRoom(roomId: string): Promise<number>;

  registerAgent(input: RegisterAgentInput): Promise<PlatformAgent>;
  getAgentById(agentId: string): Promise<PlatformAgent | null>;
  getAgentByNickname(nickname: string): Promise<PlatformAgent | null>;
  getAgentByHandle(handle: string): Promise<PlatformAgent | null>;
  listPlatformAgents(): Promise<PlatformAgent[]>;
  createToken(agentId: string, scopes: string): Promise<{ token: string; expiresAt: string }>;
  validateToken(token: string): Promise<{ agent: PlatformAgent; scopes: string } | null>;
  updateTokenLastUsed(tokenPrefix: string): Promise<void>;
}
