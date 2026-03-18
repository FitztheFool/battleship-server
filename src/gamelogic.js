// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_SIZE = 10;

const SHIPS_CONFIG = [
    { name: "Porte-avions", size: 5 },
    { name: "Croiseur", size: 4 },
    { name: "Destroyer", size: 3 },
    { name: "Destroyer 2", size: 3 },
    { name: "Sous-marin", size: 2 },
];

// ── Placement validation ──────────────────────────────────────────────────────

/**
 * @param {Array<{name:string, size:number, row:number, col:number, horizontal:boolean}>} ships
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePlacement(ships) {
    if (!Array.isArray(ships) || ships.length !== SHIPS_CONFIG.length) {
        return { valid: false, error: "Invalid number of ships" };
    }

    // Verify each ship matches the config
    const configNames = SHIPS_CONFIG.map((s) => s.name).sort();
    const givenNames = ships.map((s) => s.name).sort();
    if (JSON.stringify(configNames) !== JSON.stringify(givenNames)) {
        return { valid: false, error: "Ships don't match the required configuration" };
    }

    const occupied = new Set();

    for (const ship of ships) {
        const config = SHIPS_CONFIG.find((s) => s.name === ship.name);
        if (!config) return { valid: false, error: `Unknown ship: ${ship.name}` };
        if (ship.size !== config.size) return { valid: false, error: `Wrong size for ${ship.name}` };

        const cells = getShipCells(ship);

        for (const [r, c] of cells) {
            if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) {
                return { valid: false, error: `Ship "${ship.name}" is out of bounds` };
            }
            const key = `${r},${c}`;
            if (occupied.has(key)) {
                return { valid: false, error: `Ship "${ship.name}" overlaps another ship` };
            }
        }

        // Check adjacency with already-placed ships
        for (const [r, c] of cells) {
            for (let dr = -1;dr <= 1;dr++) {
                for (let dc = -1;dc <= 1;dc++) {
                    const nr = r + dr;
                    const nc = c + dc;
                    if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
                        const nk = `${nr},${nc}`;
                        // Occupied by a *different* ship?
                        if (occupied.has(nk)) {
                            return { valid: false, error: "Ships must have at least 1 cell gap between them" };
                        }
                    }
                }
            }
        }

        // Mark cells as occupied
        for (const [r, c] of cells) occupied.add(`${r},${c}`);
    }

    return { valid: true };
}

// ── Ship cell helpers ─────────────────────────────────────────────────────────

function getShipCells(ship) {
    const cells = [];
    for (let i = 0;i < ship.size;i++) {
        const r = ship.horizontal ? ship.row : ship.row + i;
        const c = ship.horizontal ? ship.col + i : ship.col;
        cells.push([r, c]);
    }
    return cells;
}

// ── Shot processing ───────────────────────────────────────────────────────────

/**
 * Mutates ships (marks sunk) and receivedShots.
 *
 * @param {Array<{name:string,size:number,row:number,col:number,horizontal:boolean,sunk:boolean}>} ships
 * @param {Set<string>} receivedShots
 * @param {number} row
 * @param {number} col
 * @returns {{ hit: boolean, sunkShip: object|null, gameOver: boolean }}
 */
function processShot(ships, receivedShots, row, col) {
    const key = `${row},${col}`;
    receivedShots.add(key);

    // Find hit ship
    const hitShip = ships.find((ship) => {
        const cells = getShipCells(ship);
        return cells.some(([r, c]) => r === row && c === col);
    });

    if (!hitShip) {
        return { hit: false, sunkShip: null, gameOver: false };
    }

    // Check if ship is now sunk
    const cells = getShipCells(hitShip);
    const allSunk = cells.every(([r, c]) => receivedShots.has(`${r},${c}`));

    if (allSunk) {
        hitShip.sunk = true;
    }

    // Game over if all ships sunk
    const gameOver = ships.every((s) => s.sunk);

    return {
        hit: true,
        sunkShip: allSunk ? { ...hitShip } : null,
        gameOver,
    };
}

// ── Auto-placement ────────────────────────────────────────────────────────────

/**
 * Returns a valid random placement for all ships.
 * @returns {Array<{name:string, size:number, row:number, col:number, horizontal:boolean, sunk:boolean}>}
 */
function autoPlaceShips() {
    const occupied = new Set();
    const result = [];

    for (const config of SHIPS_CONFIG) {
        let placed = false;
        let attempts = 0;

        while (!placed && attempts < 500) {
            attempts++;
            const horizontal = Math.random() > 0.5;
            const maxRow = horizontal ? GRID_SIZE - 1 : GRID_SIZE - config.size;
            const maxCol = horizontal ? GRID_SIZE - config.size : GRID_SIZE - 1;
            const row = Math.floor(Math.random() * (maxRow + 1));
            const col = Math.floor(Math.random() * (maxCol + 1));

            const candidate = { name: config.name, size: config.size, row, col, horizontal, sunk: false };
            const cells = getShipCells(candidate);

            let canPlace = true;
            for (const [r, c] of cells) {
                for (let dr = -1;dr <= 1;dr++) {
                    for (let dc = -1;dc <= 1;dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
                            if (occupied.has(`${nr},${nc}`)) {
                                canPlace = false;
                                break;
                            }
                        }
                    }
                    if (!canPlace) break;
                }
                if (!canPlace) break;
            }

            if (canPlace) {
                for (const [r, c] of cells) occupied.add(`${r},${c}`);
                result.push(candidate);
                placed = true;
            }
        }

        if (!placed) {
            // Shouldn't happen, but fallback: restart
            return autoPlaceShips();
        }
    }

    return result;
}

module.exports = { validatePlacement, processShot, autoPlaceShips, SHIPS_CONFIG, GRID_SIZE };
