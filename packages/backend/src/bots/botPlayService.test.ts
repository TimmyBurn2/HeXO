import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type SessionId } from '@ih3t/shared';
import pino from 'pino';

import type { AccountUserProfile } from '../auth/authRepository';
import type { AuthRepository } from '../auth/authRepository';
import { SessionError, SessionManager } from '../session/sessionManager';
import { createGameSession, type ServerGameSession } from '../session/types';
import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import type { BotAccountRepository } from './botAccountRepository';
import { BotPlayerMapper } from './botPlayerMapper';
import { BotSeatManager } from './botSeatManager';
import { BotMoveError, BotPlayService } from './botPlayService';
import { type BotStreamConnection, BotStreamRegistry } from './botStreamRegistry';
import { ApiRequestError } from '../network/rest/apiQueryService';
import type { BotDeclaration, BotDeclarationPatch } from '@ih3t/shared';

const BOT_PROFILE_ID = `bot-1`;
const OWNER_PROFILE_ID = `owner-1`;
const BOT_SEAT = `seat-bot`;
const HUMAN_SEAT = `seat-human`;
const GAME_ID = `game-abc`;

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

const OWNER_PROFILE: AccountUserProfile = { ...BOT_PROFILE, id: OWNER_PROFILE_ID, username: `Timmy`, kind: `human` };

type Fixture = {
    sessionManager: SessionManager;
    session: ServerGameSession;
    service: BotPlayService;
    registry: BotStreamRegistry;
    botAccountRepository: BotAccountRepository;
    gameResults: (`win` | `loss`)[];
};

function move(cells: { q: number, r: number }[], requestId?: number): unknown {
    return { move: { pieces: cells }, ...(requestId === undefined ? {} : { request_id: requestId }) };
}

function createFixture(): Fixture {
    const gameResults: (`win` | `loss`)[] = [];
    const sessionManager = new SessionManager(
        pino({ level: `silent` }),
        { createShutdownHook: () => ({ tryShutdown: () => { } }) } as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        {
            getPlayerRating: () => Promise.resolve({ eloScore: 1_000, gameCount: 0 }),
            applyGameResult: async (_playerId: string, _adjustment: never, result: `win` | `loss`) => {
                gameResults.push(result);
                return { eloScore: 1_012, gameCount: 1 };
            },
        } as never,
        { appendMoves: () => Promise.resolve(), finishGame: () => Promise.resolve() } as never,
        { track: () => { } } as never,
        {} as never,
    );

    const sessionId = `bot-session` as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `turn`, turnTimeMs: 45_000 },
        firstPlayer: `host`,
    });

    for (const [id, isBot] of [[HUMAN_SEAT, false], [BOT_SEAT, true]] as const) {
        session.players.push({
            id,
            deviceId: `device-${id}`,
            profileId: isBot ? BOT_PROFILE_ID : `human-1`,
            displayName: id,
            rating: { eloScore: 1_000, gameCount: 0 },
            ratingAdjustment: null,
            ratingAdjusted: null,
            isBot,
            connection: { status: `connected`, socketId: `socket-${id}` },
        });
    }

    session.state = `in-game`;
    session.startedAt = Date.now();
    session.gameId = GAME_ID;
    session.currentTurnExpiresAt = session.startedAt + 45_000;
    new GameSimulation().startSession(session.gameState, [HUMAN_SEAT, BOT_SEAT], HUMAN_SEAT);
    (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions.set(sessionId, session);

    const eloHandler = { getPlayerRating: () => Promise.resolve({ eloScore: 1_337, gameCount: 4 }) };
    const registry = new BotStreamRegistry(
        pino({ level: `silent` }),
        sessionManager,
        new BotPlayerMapper(eloHandler as never),
        new BotSeatManager(pino({ level: `silent` }), sessionManager),
    );
    /* The declaration the bot's own PATCH last left behind; the service only reads
     * and relays it, the repository owns the storing. */
    let declaration: BotDeclaration | undefined;
    const readAccount = () => ({
        id: BOT_PROFILE_ID,
        username: `Strix`,
        image: null,
        ownerProfileId: OWNER_PROFILE_ID,
        createdAt: 0,
        tokenRotatedAt: null,
        ...(declaration ? { declaration } : {}),
    });
    const botAccountRepository = {
        findById: () => Promise.resolve(readAccount()),
        updateDeclaration: (_botProfileId: string, patch: BotDeclarationPatch) => {
            const next: BotDeclaration = { ...declaration };
            for (const [field, value] of Object.entries(patch)) {
                if (value === ``) {
                    delete next[field as keyof BotDeclaration];
                } else if (value !== undefined) {
                    (next as Record<string, unknown>)[field] = value;
                }
            }
            declaration = next;
            return Promise.resolve(readAccount());
        },
    };
    const authRepository = {
        getUserProfileById: (id: string) => Promise.resolve(id === OWNER_PROFILE_ID ? OWNER_PROFILE : null),
    };
    const service = new BotPlayService(
        sessionManager,
        registry,
        botAccountRepository as unknown as BotAccountRepository,
        authRepository as unknown as AuthRepository,
        new BotPlayerMapper(eloHandler as never),
    );

    return { sessionManager, session, service, registry, botAccountRepository: botAccountRepository as unknown as BotAccountRepository, gameResults };
}

function playTest(name: string, body: (fixture: Fixture) => Promise<void>): void {
    test(name, async () => {
        const fixture = createFixture();
        try {
            await body(fixture);
        } finally {
            fixture.registry.detach();
            (fixture.sessionManager as unknown as { timeControl: { dispose: () => void } }).timeControl.dispose();
        }
    });
}

async function rejection(body: () => Promise<void>): Promise<BotMoveError> {
    try {
        await body();
    } catch (error: unknown) {
        assert.ok(error instanceof BotMoveError, `expected a BotMoveError, got ${String(error)}`);
        return error;
    }

    throw new Error(`the move was accepted`);
}

function toLobby(session: ServerGameSession, options: { keepSeats?: boolean } = {}): void {
    session.state = `lobby`;
    session.gameId = ``;
    session.startedAt = null;
    session.currentTurnExpiresAt = null;
    if (!options.keepSeats) {
        session.players.length = 0;
    }
}

/** The join route's entry condition: a live stream, however inert. */
function openStream(registry: BotStreamRegistry): void {
    registry.attach();
    registry.open(BOT_PROFILE, {
        setHeader: () => undefined,
        flushHeaders: () => undefined,
        write: () => true,
        end: () => undefined,
        destroy: () => undefined,
        on: () => undefined,
        writableLength: 0,
} satisfies BotStreamConnection, false);
}

playTest(`a bot claims its reserved seat in a lobby`, async ({ session, service, registry }) => {
    toLobby(session);
    session.reservedPlayerProfileIds.push(BOT_PROFILE_ID);
    openStream(registry);

    await service.joinSession(BOT_PROFILE, session.id);

    assert.equal(session.players.length, 1);
    assert.equal(session.players[0]?.profileId, BOT_PROFILE_ID);
    assert.equal(session.players[0]?.isBot, true);
});

playTest(`joining twice reclaims the same seat`, async ({ session, service, registry }) => {
    toLobby(session);
    session.reservedPlayerProfileIds.push(BOT_PROFILE_ID);
    openStream(registry);

    await service.joinSession(BOT_PROFILE, session.id);
    await service.joinSession(BOT_PROFILE, session.id);
    await service.joinSession(BOT_PROFILE, session.id);

    /* A second seat would start a game the bot plays against itself and only ever
     * answers one side of. */
    assert.equal(session.players.length, 1);
});

playTest(`a bot cannot join a game that has already started`, async ({ session, service, registry }) => {
    session.players.length = 1;
    openStream(registry);

    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /already started/,
    );
    assert.equal(session.players.length, 1);
    assert.equal(session.spectators.length, 0);
});

playTest(`a bot cannot take a seat in a full lobby, and leaves no spectator`, async ({ session, service, registry }) => {
    toLobby(session, { keepSeats: true });
    session.players[1].profileId = `someone-else`;
    session.reservedPlayerProfileIds.push(BOT_PROFILE_ID);
    openStream(registry);

    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /no seat left/,
    );
    assert.equal(session.players.length, 2);
    assert.equal(session.spectators.length, 0);
});

playTest(`a bot cannot claim a seat it is not reserved for`, async ({ session, service, registry }) => {
    toLobby(session);
    openStream(registry);

    /* An open lobby whose id the bot learned is not the bot's to take. */
    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /no seat reserved/,
    );
    assert.equal(session.players.length, 0);
    assert.equal(session.spectators.length, 0);
});

playTest(`a bot without a stream cannot take a seat`, async ({ session, service }) => {
    toLobby(session);
    session.reservedPlayerProfileIds.push(BOT_PROFILE_ID);

    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /Hold your stream open/,
    );
    assert.equal(session.players.length, 0);
    assert.equal(session.spectators.length, 0);
});

playTest(`a legal turn applies both stones`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    await service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }]));

    assert.equal(session.gameState.cells.length, 3);
    assert.equal(session.gameState.currentTurnPlayerId, HUMAN_SEAT);
});

playTest(`a move in someone else's turn is not-your-turn`, async ({ service }) => {
    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 2, r: 0 }])));

    assert.equal(error.code, `not-your-turn`);
    assert.equal(error.statusCode, 400);
});

playTest(`a move onto a placed stone is occupied`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 0, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(error.code, `occupied`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`two placements on one cell are occupied`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(error.code, `occupied`);
});

playTest(`a move beyond the placement radius is out-of-range`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 40, r: 0 }, { q: 41, r: 0 }])));

    assert.equal(error.code, `out-of-range`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`a move in a finished game is game-over`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await sessionManager.surrenderSession(session, HUMAN_SEAT);

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }])));

    assert.equal(error.code, `game-over`);
});

playTest(`a move for a game that is not running is game-over`, async ({ service }) => {
    const error = await rejection(() => service.playMove(BOT_PROFILE, `game-nope`, move([{ q: 1, r: 0 }, { q: 2, r: 0 }])));

    assert.equal(error.code, `game-over`);
});

playTest(`a resign hands the win to the opponent and applies the rating`, async ({ session, service, gameResults }) => {
    session.isRatedGame = true;
    for (const player of session.players) {
        player.ratingAdjustment = { eloGain: 12, eloLoss: -12 };
    }

    await service.resignGame(BOT_PROFILE, GAME_ID);

    assert.equal(session.state, `finished`);
    assert.equal(session.finishReason, `surrender`);
    assert.equal(session.winningPlayerId, HUMAN_SEAT);
    for (const player of session.players) {
        assert.deepEqual(player.ratingAdjusted, { eloScore: 1_012, gameCount: 1 });
    }
    assert.deepEqual(gameResults, [`win`, `loss`], `the human seat is the winner`);
});

playTest(`a second resign leaves the recorded result alone`, async ({ sessionManager, session, service }) => {
    await sessionManager.surrenderSession(session, HUMAN_SEAT);

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `finished`);
    assert.equal(session.winningPlayerId, BOT_SEAT);
    assert.equal(session.finishReason, `surrender`);
});

playTest(`resigning before the game starts is game-over`, async ({ session, service }) => {
    toLobby(session, { keepSeats: true });

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `lobby`);
});

playTest(`resigning a game the bot is not seated in is rejected`, async ({ session, service }) => {
    session.players[1].profileId = `another-bot`;

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, null);
    assert.equal(session.state, `in-game`);
});

playTest(`resigning an unknown game is game-over`, async ({ service }) => {
    const error = await rejection(() => service.resignGame(BOT_PROFILE, `game-nope`));

    assert.equal(error.code, `game-over`);
});

playTest(`resigning a session that never left the lobby is game-over`, async ({ session, service }) => {
    session.state = `lobby`;

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `lobby`);
});

playTest(`a resign that loses a race still answers game-over`, async ({ sessionManager, session, service }) => {
    (sessionManager as unknown as { surrenderSession: () => Promise<void> }).surrenderSession = async () => {
        throw new SessionError(`Game is not currently active`);
    };

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `in-game`, `nothing was applied`);
});

playTest(`an answer to an earlier position is stale-request`, async ({ sessionManager, session, service, registry }) => {
    openStream(registry);
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }], 0)));

    assert.equal(error.code, `stale-request`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`a retried move is answered, not rejected`, async ({ sessionManager, session, service, registry }) => {
    openStream(registry);
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    await service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }], 1));
    /* The retry after a lost response replays the same request id. */
    await service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }], 1));

    assert.equal(session.gameState.cells.length, 3);
    assert.equal(session.gameState.currentTurnPlayerId, HUMAN_SEAT);
});

playTest(`a rejected move leaves the clock running`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    const expiresAt = session.currentTurnExpiresAt;

    await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 0, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(session.state, `in-game`);
    assert.equal(session.currentTurnExpiresAt, expiresAt);
    assert.equal(session.gameState.currentTurnPlayerId, BOT_SEAT);
});

playTest(`a malformed body is refused before the session is touched`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, { move: { pieces: [{ q: 1, r: 0 }] } }));

    assert.equal(error.code, null);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`an account carries the bot, its owner and its running games`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const account = await service.getAccount(BOT_PROFILE);

    assert.deepEqual(account.bot, { profileId: BOT_PROFILE_ID, displayName: `Strix`, elo: 1_337 });
    assert.deepEqual(account.owner, { profileId: OWNER_PROFILE_ID, displayName: `Timmy`, elo: 1_337 });
    assert.deepEqual(account.activeGames, [{ gameId: session.gameId, side: `o` }]);
});

playTest(`a declared account reads its declaration back, an undeclared one nothing`, async ({ service }) => {
    const undeclared = await service.getAccount(BOT_PROFILE);
    assert.equal(`about` in undeclared, false);
    assert.equal(`accepts` in undeclared, false);

    const declared = await service.updateAccount(BOT_PROFILE, {
        about: `Strix, the reference bot`,
        version: `1.0.0`,
        repoUrl: `https://github.com/TimmyBurn2/Hexo-Bot-Api`,
        accepts: { turnMs: [5_000, 600_000], match: true, unlimited: true },
    });

    assert.equal(declared.about, `Strix, the reference bot`);
    assert.equal(declared.version, `1.0.0`);
    assert.equal(declared.repoUrl, `https://github.com/TimmyBurn2/Hexo-Bot-Api`);
    assert.deepEqual(declared.accepts, { turnMs: [5_000, 600_000], match: true, unlimited: true });

    /* The rest of the account is unchanged; a declaration is not a rename. */
    assert.deepEqual(declared.bot, { profileId: BOT_PROFILE_ID, displayName: `Strix`, elo: 1_337 });
    assert.deepEqual(declared.activeGames, [{ gameId: GAME_ID, side: `o` }]);
});

playTest(`an empty string clears a declared field, accepts replace wholesale`, async ({ service }) => {
    await service.updateAccount(BOT_PROFILE, {
        about: `first`,
        version: `1.0.0`,
        accepts: { turnMs: [5_000, 600_000], match: true, unlimited: true },
    });

    const updated = await service.updateAccount(BOT_PROFILE, {
        about: ``,
        accepts: { turnMs: null, match: false, unlimited: true },
    });

    assert.equal(`about` in updated, false, `an empty string clears`);
    assert.equal(updated.version, `1.0.0`, `untouched fields stay`);
    assert.deepEqual(updated.accepts, { turnMs: null, match: false, unlimited: true }, `accepts replace, not merge`);
});

playTest(`a snapshot mirrors the board through the codec and the turn clock`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await sessionManager.placeCells(session, BOT_SEAT, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);

    const snapshot = await service.getGameSnapshot(GAME_ID);

    /* q = x + y, r = -y; the human placed the origin, so it is x, and after the
     * bot's whole turn the move is the human's again. */
    assert.deepEqual(snapshot.board, {
        to_move: `x`,
        cells: [
            { q: 0, r: 0, p: `x` },
            { q: 1, r: 0, p: `o` },
            { q: 2, r: 0, p: `o` },
        ],
    });
    assert.equal(snapshot.clock.mode, `turn`);
    assert.ok(snapshot.clock.mode === `turn` && snapshot.clock.remainingTurnMs > 0, `the running turn budget`);
    assert.equal(snapshot.status, `in-progress`);
    assert.equal(`winner` in snapshot, false);
    assert.equal(`reason` in snapshot, false);
});

playTest(`a finished game's snapshot carries status, winner and reason`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    session.state = `finished`;
    session.winningPlayerId = HUMAN_SEAT;
    session.finishReason = `six-in-a-row`;

    const snapshot = await service.getGameSnapshot(GAME_ID);

    assert.equal(snapshot.status, `finished`);
    assert.equal(snapshot.winner, `x`);
    assert.equal(snapshot.reason, `six-in-a-row`);
    assert.equal(snapshot.board.cells.length, 1);
    assert.ok(snapshot.clock.mode === `turn` && snapshot.clock.remainingTurnMs === 0, `no running budget once finished`);
});

playTest(`a snapshot of a match-clock game carries both sides' main time`, async ({ session, service }) => {
    session.gameOptions.timeControl = { mode: `match`, mainTimeMs: 300_000, incrementMs: 5_000 };
    session.gameState.playerTimeRemainingMs[HUMAN_SEAT] = 280_000;
    session.gameState.playerTimeRemainingMs[BOT_SEAT] = 290_000;

    const snapshot = await service.getGameSnapshot(GAME_ID);

    assert.deepEqual(snapshot.clock, { mode: `match`, remainingMainMs: { x: 280_000, o: 290_000 } });
});

playTest(`an unknown game answers 404, and so does one without a game id`, async ({ service, session }) => {
    for (const gameId of [`nope`, ``]) {
        await assert.rejects(
            () => service.getGameSnapshot(gameId),
            (error: unknown) => error instanceof ApiRequestError && error.statusCode === 404,
        );
    }

    /* A lobby carries no game id at all, so it is not addressable here either. */
    session.gameId = ``;
    await assert.rejects(
        () => service.getGameSnapshot(GAME_ID),
        (error: unknown) => error instanceof ApiRequestError && error.statusCode === 404,
    );
});
