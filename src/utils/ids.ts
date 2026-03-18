import { v4 as uuidv4 } from "uuid";

export function newId(): string {
  return uuidv4();
}

export function nowIso(): string {
  return new Date().toISOString();
}
