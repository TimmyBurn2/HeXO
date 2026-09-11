import 'reflect-metadata';

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { type BotStreamEvent, type SessionId, zCellOccupant } from '@ih3t/shared';
import pino from 'pino';

import type { AccountUserProfile } from '../auth/authRepository';
import { SessionManager } from '../session/sessionManager';
import { createGameSession, type ServerGameSession } from '../session/types';
import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import { type BotStreamConnection, BotStreamRegistry } from './botStreamRegistry';

const BOT_PROFILE_ID = `bot-1`;
const HUMAN_PROFILE_ID = `human-1`;
const BOT_SEAT = `seat-bot`;
const HUMAN_SEAT = `seat-human`;
const TURN_TIME_MS = 45_000;

const BOT_PROFILE: AccountUserProfile = {
    id: BOT_PROFILE_ID,
    username: `Strix`,
    email: null,
    image: null,
    role: `user`,
    kind: `bot`,
    permissions: [],
    registeredAt: 0,
    lastActiveAt: 0,
};

class FakeConnection implements BotStreamConnection {
    readonly chunks: string[] = [];
    readonly headers = new Map<string, string>();
    writableLength = 0;
    ended = false;
    destroyed = false;
    private closeListener: (() => void) | null = null;

    setHeader(name: string, value: string): unknown {
        this.headers.set(name, value);
        return this;
    }

    flushHeaders(): void { /* nothing is buffered in a test */ }

    write(chunk: string): boolean {
        this.chunks.push(chunk);
        return true;
    }

    end(): void {
        this.ended = true;
        this.closeListener?.();
    }

    destroy(): void {
        this.destroyed = true;
        this.closeListener?.();
    }

    on(_event: `close`, listener: () => void): unknown {
        this.closeListener = listener;
        return this;
    }

    events(): BotStreamEvent[] {
        return this.chunks
            .filter((chunk) => chunk.trim().length > 0)
            .map((chunk) => JSON.parse(chunk) as BotStreamEvent);
    }

    keepalives(): number {
        return this.chunks.filter((chunk) => chunk === `\n`).length;
    }
}

type SeedOptions = {
    botMovesFirst?: boolean;
    opponentIsGuest?: boolean;
    startInLobby?: boolean;
};

type Fixture = {
    sessionManager: SessionManager;
    session: ServerGameSession;
    registry: BotStreamRegistry;
    connection: FakeConnection;
};

function createSessionManager(): SessionManager {
    const gameHistoryRepository = {
        appendMove: () => Promise.resolve(),
        finishGame: () => Promise.resolve(),
        createGame: () => Promise.resolve(`game-abc`),
    };

    return new SessionManager(
        pino({ level: `silent` }),
        { createShutdownHook: () => ({ tryShutdown: () => { } }) } as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        {} as never,
        gameHistoryRepository as never,
        { track: () => { } } as never,
        {} as never,
    );
}

function seedSession(sessionManager: SessionManager, options: SeedOptions): ServerGameSession {
    const sessionId = `bot-session` as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `turn`, turnTimeMs: TURN_TIME_MS },
        firstPlayer: `host`,
    });

    session.players.push({
        id: HUMAN_SEAT,
        deviceId: `device-human`,
        profileId: options.opponentIsGuest ? null : HUMAN_PROFILE_ID,
        displayName: options.opponentIsGuest ? `Guest 1234` : `TimmyBurn`,
        rating: { eloScore: options.opponentIsGuest ? 0 : 1_240, gameCount: 0 },
        ratingAdjustment: null,
        ratingAdjusted: null,
        isBot: false,
        connection: { status: `connected`, socketId: `socket-human` },
    });
    session.players.push({
        id: BOT_SEAT,
        deviceId: `bot:${BOT_PROFILE_ID}`,
        profileId: BOT_PROFILE_ID,
        displayName: `Strix`,
        rating: { eloScore: 1_500, gameCount: 0 },
        ratingAdjustment: null,
        ratingAdjusted: null,
        isBot: true,
        connection: { status: `connected`, socketId: `bot:${BOT_PROFILE_ID}` },
    });

    if (options.startInLobby) {
        /* Left for the manager to start, so the real start edge is exercised. */
        for (const player of session.players) {
            player.connection = { status: `disconnected`, timestamp: Date.now() };
        }

        (sessionManager as unknown as { sessions: Map<string, ServerGameSession> })
            .sessions.set(sessionId, session);
        return session;
    }

    session.state = `in-game`;
    session.startedAt = Date.now();
    session.gameId = `game-abc`;
    new GameSimulation().startSession(
        session.gameState,
        [HUMAN_SEAT, BOT_SEAT],
        options.botMovesFirst ? BOT_SEAT : HUMAN_SEAT,
    );
    /* A deadline without a timer: these tests read the clock, they never fire it. */
    session.currentTurnExpiresAt = session.startedAt + TURN_TIME_MS;

    (sessionManager as unknown as { sessions: Map<string, ServerGameSession> })
        .sessions.set(sessionId, session);

    return session;
}

/**
 * One in-game session with a bot seat, torn down afterwards: a turn deadline or an
 * orphan timer left behind would hold the whole test process open for 30 seconds.
 */
function botTest(
    name: string,
    body: (fixture: Fixture, t: TestContext) => Promise<void> | void,
    options: SeedOptions = {},
): void {
    test(name, async (t) => {
        const sessionManager = createSessionManager();
        const session = seedSession(sessionManager, options);
        const registry = new BotStreamRegistry(pino({ level: `silent` }), sessionManager);
        registry.attach();

        try {
            await body({ sessionManager, session, registry, connection: new FakeConnection() }, t);
        } finally {
            registry.detach();
            (sessionManager as unknown as { timeControl: { dispose: () => void } }).timeControl.dispose();
            for (const player of session.players) {
                if (player.connection.status === `orphaned`) {
                    clearTimeout(player.connection.timeout);
                }
            }
        }
    });
}

async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

botTest(`opening a stream sets the ndjson headers and replays the running game`, async ({ session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    assert.equal(connection.headers.get(`Content-Type`), `application/x-ndjson`);
    assert.deepEqual(connection.events()[0], {
        type: `gameStart`,
        gameId: session.gameId,
        side: `o`,
        opponent: { profileId: HUMAN_PROFILE_ID, displayName: `TimmyBurn`, elo: 1_240 },
        timeControl: { mode: `turn`, turnTimeMs: TURN_TIME_MS },
        rated: false,
    });
    assert.equal(registry.isOnline(BOT_PROFILE_ID), true);
});

botTest(`a guest opponent has no rating and no profile id`, async ({ registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    const start = connection.events()[0];
    assert.equal(start?.type, `gameStart`);
    assert.deepEqual(start?.type === `gameStart` ? start.opponent : null, {
        profileId: null,
        displayName: `Guest 1234`,
        elo: null,
    });
}, { opponentIsGuest: true });

botTest(`the opening stone is placed for a bot that moves first`, async ({ session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    assert.deepEqual(session.gameState.cells, [{ x: 0, y: 0, occupiedBy: BOT_SEAT }]);
    assert.equal(session.gameState.currentTurnPlayerId, HUMAN_SEAT);
    /* A bot is never asked for a one-placement turn. */
    assert.deepEqual(connection.events().map((event) => event.type), [`gameStart`]);
}, { botMovesFirst: true });

botTest(`a move request follows the opponent's turn and carries the live clock`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await settle();

    const request = connection.events().at(-1);
    assert.equal(request?.type, `moveRequest`);
    if (request?.type !== `moveRequest`) {
        return;
    }

    assert.equal(request.gameId, session.gameId);
    assert.deepEqual(request.request.board, { to_move: `o`, cells: [{ q: 0, r: 0, p: `x` }] });
    assert.equal(request.request.request_id, 1);
    assert.ok((request.request.time_limit ?? 0) > 0);
    assert.ok((request.request.time_limit ?? 0) <= TURN_TIME_MS / 1_000);
});

botTest(`only one move request is sent per turn`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await settle();

    assert.equal(connection.events().filter((event) => event.type === `moveRequest`).length, 1);
});

botTest(`a bot that drops and comes back replays the position, ids still rising`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    /* Two full turns first, so the id at the drop is not the one a fresh map would give. */
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await settle();
    await sessionManager.placeCells(session, BOT_SEAT, [{ x: 1, y: 0 }, { x: 0, y: 1 }]);
    await sessionManager.placeCells(session, HUMAN_SEAT, [{ x: 2, y: 0 }, { x: 0, y: 2 }]);
    await settle();
    const beforeDrop = connection.events().filter((event) => event.type === `moveRequest`).at(-1);
    assert.equal(beforeDrop?.type === `moveRequest` ? beforeDrop.request.request_id : null, 2);

    /* A real drop, not a swap: the close listener has already unregistered the stream
     * by the time the bot comes back, which is where a per-connection counter resets. */
    connection.destroy();
    await settle();
    assert.equal(registry.isOnline(BOT_PROFILE_ID), false);

    const second = new FakeConnection();
    registry.open(BOT_PROFILE, second, false);
    await settle();

    const events = second.events();
    assert.deepEqual(events.map((event) => event.type), [`gameStart`, `moveRequest`]);
    const replayed = events[1];
    /* The contract has request_id rise monotonically within a game, reconnect included. */
    assert.equal(replayed?.type === `moveRequest` ? replayed.request.request_id : null, 3);
    /* Replacing the stream must not orphan the seat it belongs to. */
    assert.equal(session.players.find((player) => player.id === BOT_SEAT)?.connection.status, `connected`);
});

botTest(`a game that starts while the bot is streaming sends exactly one gameStart`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();
    assert.deepEqual(connection.events(), [], `a lobby is not a game`);

    for (const player of session.players) {
        sessionManager.assignParticipantSocket(session, player.id, `socket-${player.id}`);
    }
    await settle();

    assert.equal(session.state, `in-game`);
    assert.equal(connection.events().filter((event) => event.type === `gameStart`).length, 1);
}, { startInLobby: true });

botTest(`a win on the opponent's second stone asks the bot for nothing`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    /* x has five on the row y=0 with a hole at (1,0); o has four stones elsewhere. */
    const occupied = (x: number, y: number, by: string) => ({ x, y, occupiedBy: zCellOccupant.parse(by) });
    session.gameState.cells = [
        occupied(0, 0, HUMAN_SEAT), occupied(2, 0, HUMAN_SEAT), occupied(3, 0, HUMAN_SEAT),
        occupied(4, 0, HUMAN_SEAT), occupied(5, 0, HUMAN_SEAT),
        occupied(0, 1, BOT_SEAT), occupied(0, 2, BOT_SEAT), occupied(0, 3, BOT_SEAT), occupied(0, 4, BOT_SEAT),
    ];
    session.gameState.currentTurnPlayerId = HUMAN_SEAT;
    session.gameState.placementsRemaining = 2;
    session.gameState.turnCount = 4;

    /* A harmless first stone, then the hole: the win lands on the second placement. */
    await sessionManager.placeCells(session, HUMAN_SEAT, [{ x: 7, y: 0 }, { x: 1, y: 0 }]);
    await settle();

    const types = connection.events().map((event) => event.type);
    assert.equal(session.state, `finished`);
    assert.deepEqual(types, [`gameStart`, `gameFinish`], `no moveRequest for a game that is over`);
    const finish = connection.events().at(-1);
    assert.deepEqual(finish?.type === `gameFinish` ? [finish.winner, finish.reason] : null, [`x`, `six-in-a-row`]);
});

botTest(`a finished game arrives with the winning side`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    await sessionManager.surrenderSession(session, HUMAN_SEAT);
    await settle();

    assert.deepEqual(connection.events().at(-1), {
        type: `gameFinish`,
        gameId: `game-abc`,
        winner: `o`,
        reason: `surrender`,
    });
});

botTest(`a terminated game arrives with no winner at all`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    await sessionManager.terminateActiveSession(session.id);
    await settle();

    assert.deepEqual(connection.events().at(-1), {
        type: `gameFinish`,
        gameId: `game-abc`,
        winner: null,
        reason: `terminated`,
    });
});

botTest(`a session dropped without finishing arrives as an abort`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions.delete(session.id);
    (sessionManager as unknown as {
        dispatch: (event: string, payload: unknown) => void;
    }).dispatch(`lobbyRemoved`, { id: session.id });
    await settle();

    assert.deepEqual(connection.events().at(-1), {
        type: `gameFinish`,
        gameId: `game-abc`,
        winner: null,
        reason: `aborted`,
    });
});

botTest(`dropping the stream orphans the bot's seat`, async ({ session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    connection.destroy();
    await settle();

    assert.equal(registry.isOnline(BOT_PROFILE_ID), false);
    assert.equal(session.players.find((player) => player.id === BOT_SEAT)?.connection.status, `orphaned`);
});

botTest(`an unread stream is dropped rather than buffered forever`, async ({ sessionManager, session, registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    connection.writableLength = 8_000_000;
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await settle();

    assert.equal(connection.destroyed, true);
});

botTest(`a held stream is kept alive with a bare newline`, ({ registry, connection }, t) => {
    t.mock.timers.enable({ apis: [`setInterval`] });

    registry.open(BOT_PROFILE, connection, false);
    t.mock.timers.tick(25_000);

    assert.equal(connection.keepalives(), 2);
});

botTest(`open=1 marks the bot open, and the flag dies with the stream`, async ({ registry, connection }) => {
    assert.equal(registry.isOpenForChallenges(BOT_PROFILE_ID), false);

    registry.open(BOT_PROFILE, connection, true);
    await settle();

    assert.equal(registry.isOpenForChallenges(BOT_PROFILE_ID), true);
    assert.equal(registry.isOnline(BOT_PROFILE_ID), true);

    connection.end();

    assert.equal(registry.isOpenForChallenges(BOT_PROFILE_ID), false, `openness never outlives its stream`);
    assert.equal(registry.isOnline(BOT_PROFILE_ID), false);
});

botTest(`a challenge line is written through the same validation as a game line`, async ({ registry, connection }) => {
    registry.open(BOT_PROFILE, connection, false);
    await settle();

    registry.emitToBot(BOT_PROFILE_ID, {
        type: `challenge`,
        challenge: {
            challengeId: `c_1`,
            challenger: { profileId: `bot-2`, displayName: `Rival`, elo: 1_100 },
            destUser: { profileId: BOT_PROFILE_ID, displayName: `Strix`, elo: 1_500 },
            timeControl: { mode: `unlimited` },
            status: `created`,
        },
    });

    assert.deepEqual(connection.events().at(-1), {
        type: `challenge`,
        challenge: {
            challengeId: `c_1`,
            challenger: { profileId: `bot-2`, displayName: `Rival`, elo: 1_100 },
            destUser: { profileId: BOT_PROFILE_ID, displayName: `Strix`, elo: 1_500 },
            timeControl: { mode: `unlimited` },
            status: `created`,
        },
    });
});
