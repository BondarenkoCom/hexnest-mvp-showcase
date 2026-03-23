import { RoomSnapshot } from "../types/protocol";

export interface CreateRoomInput {
  name: string;
  task: string;
  agentIds: string[];
  pythonShellEnabled: boolean;
  webSearchEnabled: boolean;
  subnest: string;
}

export interface RoomStore {
  createRoom(input: CreateRoomInput): RoomSnapshot;
  getRoom(roomId: string): RoomSnapshot | undefined;
  listRooms(): RoomSnapshot[];
  saveRoom(room: RoomSnapshot): RoomSnapshot;
}
