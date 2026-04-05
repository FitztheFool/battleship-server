import { Room, PlayerSlot } from './types';

type HandleShotFn = (room: Room, userId: string, row: number, col: number, isTimeout: boolean) => void;

/** Callback set by index.ts after handleShot is defined. */
export const botCallbacks: { handleShot?: HandleShotFn } = {};

export function chooseBotShot(room: Room, target: PlayerSlot): [number, number] {
    const queue = room.botHitQueue;

    // Remove already-shot cells from queue
    const validQueue = queue.filter(([r, c]) => !target.receivedShots.has(`${r},${c}`));
    room.botHitQueue = validQueue;

    if (validQueue.length > 0) {
        return validQueue.shift()!;
    }

    // Hunt mode: checkerboard parity (ships span ≥2 cells, halves search space)
    const emptyCells: [number, number][] = [];
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
            if (!target.receivedShots.has(`${r},${c}`) && (r + c) % 2 === 0) emptyCells.push([r, c]);
        }
    }
    // Fallback if checkerboard exhausted
    if (emptyCells.length === 0) {
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                if (!target.receivedShots.has(`${r},${c}`)) emptyCells.push([r, c]);
            }
        }
    }

    return emptyCells[Math.floor(Math.random() * emptyCells.length)];
}

export function botShoot(room: Room): void {
    if (room.phase !== 'playing') return;
    const botIndex = room.players.findIndex((p) => p?.userId.startsWith('bot-'));
    if (botIndex === -1 || room.currentTurn !== botIndex) return;
    const bot = room.players[botIndex]!;
    const targetIndex: 0 | 1 = botIndex === 0 ? 1 : 0;
    const target = room.players[targetIndex];
    if (!target) return;
    const [row, col] = chooseBotShot(room, target);
    botCallbacks.handleShot?.(room, bot.userId, row, col, false);
}

export function updateBotHitQueue(
    room: Room,
    shooterIsBot: boolean,
    row: number,
    col: number,
    hit: boolean,
    sunkShip: unknown,
    target: PlayerSlot,
): void {
    if (!shooterIsBot) return;
    if (hit && sunkShip) {
        room.botHitQueue = [];
    } else if (hit) {
        const adj: [number, number][] = (
            [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]] as [number, number][]
        ).filter(([r, c]) => r >= 0 && r < 10 && c >= 0 && c < 10 && !target.receivedShots.has(`${r},${c}`));
        room.botHitQueue = [...room.botHitQueue, ...adj];
    }
}
