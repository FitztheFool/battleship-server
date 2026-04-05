import { autoPlaceShips } from './gamelogic';
import { Room, PlayerSlot } from './types';
import { clearRoomTimers } from './rooms';

type HandleShotFn = (room: Room, userId: string, row: number, col: number, isTimeout: boolean) => void;
type StartGameFn = (room: Room) => void;
type EmitToPlayerFn = (room: Room, userId: string, event: string, payload: unknown) => void;

/** Callbacks set by index.ts after all functions are defined. */
export const timerCallbacks: {
    handleShot?: HandleShotFn;
    startGame?: StartGameFn;
    emitToPlayer?: EmitToPlayerFn;
} = {};

export function startTurnTimer(room: Room): void {
    clearRoomTimers(room);
    const duration = room.options.turnDuration * 1000;
    room.turnEndsAt = Date.now() + duration;

    room.turnTimer = setTimeout(() => {
        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer) return;

        const enemyIndex: 0 | 1 = room.currentTurn === 0 ? 1 : 0;
        const enemy = room.players[enemyIndex];
        if (!enemy) return;

        const emptyCells: [number, number][] = [];
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                if (!enemy.receivedShots.has(`${r},${c}`)) emptyCells.push([r, c]);
            }
        }
        if (emptyCells.length === 0) return;

        const [row, col] = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        timerCallbacks.handleShot?.(room, currentPlayer.userId, row, col, true);
    }, duration);
}

export function startPlacementTimer(room: Room): void {
    clearRoomTimers(room);
    const duration = room.options.placementDuration * 1000;
    room.placementEndsAt = Date.now() + duration;

    room.placementTimer = setTimeout(() => {
        room.players.forEach((player: PlayerSlot | null) => {
            if (!player || player.ready) return;
            player.ships = autoPlaceShips();
            player.ready = true;
            timerCallbacks.emitToPlayer?.(room, player.userId, 'battleship:autoPlaced', { ships: player.ships });
        });
        timerCallbacks.startGame?.(room);
    }, duration);
}
