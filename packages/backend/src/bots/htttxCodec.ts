import {
    type BotMoveErrorCode,
    type GameState,
    type HexCoordinate,
    type HtttxCoord,
    type HtttxMoveRequest,
    type HtttxSide,
    zHtttxMoveResponse,
} from '@ih3t/shared';

/**
 * Translation between HeXO's game state and the htttx stateless v1-alpha engine
 * exchange. Pure: no DI, no repositories, no clock reads. HeXO axial `x,y` maps to
 * htttx axial `q,r` as `q = x + y`, `r = -y`, and back as `x = q + r`, `y = -r`.
 */

/** Rejections the codec can make on its own, before any session is consulted. */
export class HtttxCodecError extends Error {
    constructor(
        message: string,
        readonly code: BotMoveErrorCode | null = null,
    ) {
        super(message);
        this.name = `HtttxCodecError`;
    }
}

export type DecodedMove = {
    cells: [HexCoordinate, HexCoordinate];
    requestId: number | null;
};

/* Subtracting from zero rather than negating: `-0` is a distinct value, and it
 * would travel through JSON and into cell keys as a second spelling of zero. */
export function toHtttxCoord(cell: HexCoordinate): HtttxCoord {
    return { q: cell.x + cell.y, r: 0 - cell.y };
}

export function fromHtttxCoord(coord: HtttxCoord): HexCoordinate {
    return { x: coord.q + coord.r, y: 0 - coord.r };
}

/** `x` is whoever placed the origin stone, or whoever is about to. */
function resolveFirstMoverId(gameState: GameState): string | null {
    return gameState.cells[0]?.occupiedBy ?? gameState.currentTurnPlayerId;
}

export function sideOf(gameState: GameState, playerId: string): HtttxSide {
    return playerId === resolveFirstMoverId(gameState) ? `x` : `o`;
}

export function toMoveRequest(
    gameState: GameState,
    timeLimitMs: number | null,
    requestId: number,
): HtttxMoveRequest {
    const toMove = gameState.currentTurnPlayerId;
    if (!toMove) {
        throw new HtttxCodecError(`The game has nobody to move.`);
    }

    const request: HtttxMoveRequest = {
        board: {
            to_move: sideOf(gameState, toMove),
            cells: gameState.cells.map((cell) => ({
                ...toHtttxCoord(cell),
                p: sideOf(gameState, cell.occupiedBy),
            })),
        },
        request_id: requestId,
    };

    /* htttx reads an absent time_limit as unlimited thinking time. */
    if (timeLimitMs !== null) {
        request.time_limit = timeLimitMs / 1000;
    }

    return request;
}

export function fromMoveResponse(body: unknown): DecodedMove {
    const parsed = zHtttxMoveResponse.safeParse(body);
    if (!parsed.success) {
        throw new HtttxCodecError(`A move is exactly two placements of integer q,r.`);
    }

    const [first, second] = parsed.data.move.pieces.map(fromHtttxCoord);
    if (!first || !second) {
        throw new HtttxCodecError(`A move is exactly two placements of integer q,r.`);
    }

    if (first.x === second.x && first.y === second.y) {
        throw new HtttxCodecError(`Both placements are on the same cell.`, `occupied`);
    }

    return { cells: [first, second], requestId: parsed.data.request_id ?? null };
}
