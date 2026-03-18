import { RoomSnapshot } from "../types/protocol";

export interface CreateRoomInput {
  name: string;
  task: string;
  agentIds: string[];
  pythonShellEnabled: boolean;
}

export interface RoomStore {
  createRoom(input: CreateRoomInput): RoomSnapshot;
  getRoom(roomId: string): RoomSnapshot | undefined;
  listRooms(): RoomSnapshot[];
  saveRoom(room: RoomSnapshot): RoomSnapshot;
}
