import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyGameState, type GameState, initializeGameState, zCellOccupant } from '@ih3t/shared';

import {
    fromHtttxCoord,
    fromMoveResponse,
    HtttxCodecError,
    sideOf,
    toHtttxCoord,
    toMoveRequest,
} from './htttxCodec';

const FIRST_MOVER = `player-one`;
const SECOND_MOVER = `player-two`;

function stateWithCells(cells: { x: number, y: number, playerId: string }[]): GameState {
    const gameState = createEmptyGameState();
    initializeGameState(gameState, [FIRST_MOVER, SECOND_MOVER], FIRST_MOVER);
    for (const cell of cells) {
        gameState.cells.push({ x: cell.x, y: cell.y, occupiedBy: zCellOccupant.parse(cell.playerId) });
    }

    return gameState;
}

test(`coordinates round-trip through the htttx axial map`, () => {
    for (const cell of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -3, y: 2 }, { x: 4, y: -7 }]) {
        const coord = toHtttxCoord(cell);
        assert.deepEqual(coord, { q: cell.x + cell.y, r: 0 - cell.y });
        assert.deepEqual(fromHtttxCoord(coord), cell);
        assert.ok(!Object.is(coord.r, -0), `a zero coordinate must not be negative zero`);
    }
});

test(`the side is the order of play, not the seat order`, () => {
    const gameState = stateWithCells([{ x: 0, y: 0, playerId: SECOND_MOVER }]);

    /* The origin stone identifies `x` even when the seats say otherwise. */
    assert.equal(sideOf(gameState, SECOND_MOVER), `x`);
    assert.equal(sideOf(gameState, FIRST_MOVER), `o`);
});

test(`an empty board takes the side from whoever is to move`, () => {
    const gameState = stateWithCells([]);

    assert.equal(sideOf(gameState, FIRST_MOVER), `x`);
    assert.equal(sideOf(gameState, SECOND_MOVER), `o`);
});

test(`a move request matches the vendored htttx example`, () => {
    /* openapi.yaml, MoveRequest example: the origin placed by x, o to move, 5 s. */
    const gameState = stateWithCells([{ x: 0, y: 0, playerId: FIRST_MOVER }]);
    gameState.currentTurnPlayerId = SECOND_MOVER;

    assert.deepEqual(toMoveRequest(gameState, 5_000, 1), {
        board: { to_move: `o`, cells: [{ q: 0, r: 0, p: `x` }] },
        request_id: 1,
        time_limit: 5,
    });
});

test(`the clock is milliseconds on the wire and seconds inside the request`, () => {
    const gameState = stateWithCells([{ x: 0, y: 0, playerId: FIRST_MOVER }]);
    gameState.currentTurnPlayerId = SECOND_MOVER;

    assert.equal(toMoveRequest(gameState, 45_000, 2).time_limit, 45);
    assert.equal(toMoveRequest(gameState, 1_500, 3).time_limit, 1.5);
    assert.equal(toMoveRequest(gameState, 0, 4).time_limit, 0);
});

test(`an unlimited clock omits time_limit rather than sending zero`, () => {
    const gameState = stateWithCells([{ x: 0, y: 0, playerId: FIRST_MOVER }]);
    gameState.currentTurnPlayerId = SECOND_MOVER;

    const request = toMoveRequest(gameState, null, 7);
    assert.equal(`time_limit` in request, false);
    assert.equal(request.request_id, 7);
});

test(`a board carries every stone with the side that placed it`, () => {
    const gameState = stateWithCells([
        { x: 0, y: 0, playerId: FIRST_MOVER },
        { x: 1, y: 0, playerId: SECOND_MOVER },
        { x: 0, y: 1, playerId: SECOND_MOVER },
    ]);
    gameState.currentTurnPlayerId = FIRST_MOVER;

    assert.deepEqual(toMoveRequest(gameState, null, 1).board, {
        to_move: `x`,
        cells: [
            { q: 0, r: 0, p: `x` },
            { q: 1, r: 0, p: `o` },
            { q: 1, r: -1, p: `o` },
        ],
    });
});

test(`a move response decodes to two HeXO cells and echoes the request id`, () => {
    /* openapi.yaml, MoveResponse example. */
    const decoded = fromMoveResponse({
        move: { pieces: [{ q: 1, r: 0 }, { q: -1, r: 1 }] },
        request_id: 1,
    });

    assert.deepEqual(decoded.cells, [{ x: 1, y: 0 }, { x: 0, y: -1 }]);
    assert.equal(decoded.requestId, 1);
});

test(`a response without a request id decodes with a null one`, () => {
    const decoded = fromMoveResponse({ move: { pieces: [{ q: 1, r: 0 }, { q: 2, r: 0 }] } });

    assert.equal(decoded.requestId, null);
});

test(`two placements on the same cell are rejected as occupied`, () => {
    assert.throws(
        () => fromMoveResponse({ move: { pieces: [{ q: 2, r: -1 }, { q: 2, r: -1 }] } }),
        (error: unknown) => error instanceof HtttxCodecError && error.code === `occupied`,
    );
});

test(`a move that is not exactly two integer placements is rejected`, () => {
    const bodies: unknown[] = [
        { move: { pieces: [{ q: 1, r: 0 }] } },
        { move: { pieces: [{ q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 }] } },
        { move: { pieces: [{ q: 1.5, r: 0 }, { q: 2, r: 0 }] } },
        { move: { pieces: [] } },
        { move: {} },
        {},
    ];

    for (const body of bodies) {
        assert.throws(() => fromMoveResponse(body), HtttxCodecError);
    }
});

test(`considerations and an evaluation are accepted and ignored`, () => {
    const decoded = fromMoveResponse({
        move: { pieces: [{ q: 1, r: 0 }, { q: 2, r: 0 }], evaluation: { heuristic: 0.25, win_in: -2 } },
        considerations: [{ pieces: [{ q: 5, r: 0 }, { q: 6, r: 0 }] }],
    });

    assert.deepEqual(decoded.cells, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
});
