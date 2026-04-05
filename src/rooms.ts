import { Room } from './types';

export const rooms = new Map<string, Room>();

export function getRoom(lobbyId: string): Room | null {
    return rooms.get(lobbyId) ?? null;
}

export function getSlotIndex(room: Room, userId: string): number {
    return room.players.findIndex((p) => p?.userId === userId);
}

export function clearRoomTimers(room: Room): void {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.placementTimer) { clearTimeout(room.placementTimer); room.placementTimer = null; }
}
