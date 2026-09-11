import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type SessionId } from '@ih3t/shared';
import pino from 'pino';

import type { AccountUserProfile, AuthRepository } from '../auth/authRepository';
import type { EloHandler } from '../elo/eloHandler';
import { SessionManager } from '../session/sessionManager';
import { createGameSession, type ServerGameSession } from '../session/types';
import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import type { BotAccount, BotListing } from '@ih3t/shared';
import type { BotAccountRepository } from './botAccountRepository';
import { BotDirectoryService } from './botDirectoryService';
import type { BotStreamRegistry } from './botStreamRegistry';

const HUMAN_PROFILE_ID = `human-1`;
const OWNER_PROFILE_ID = `owner-1`;
const ONLINE_BOT_ID = `bot-online`;
const OFFLINE_BOT_ID = `bot-offline`;

const HUMAN_PROFILE: AccountUserProfile = {
    id: HUMAN_PROFILE_ID,
    username: `Timmy`,
    email: null,
    image: null,
    role: `user`,
    kind: `human`,
    permissions: [],
    registeredAt: 0,
    lastActiveAt: 0,
};

function botProfile(id: string): AccountUserProfile {
    return { ...HUMAN_PROFILE, id, username: id, kind: `bot` };
}

function botAccount(id: string, ownerProfileId: string = OWNER_PROFILE_ID): BotAccount {
    return { id, username: id, image: null, ownerProfileId, createdAt: 0, tokenRotatedAt: null };
}

type Fixture = {
    sessionManager: SessionManager;
    service: BotDirectoryService;
    sessions: Map<string, ServerGameSession>;
};

function createFixture(options: { onlineBotIds?: string[], onlineResult?: (callIndex: number) => boolean } = {}): Fixture {
    const online = new Set(options.onlineBotIds ?? [ONLINE_BOT_ID]);
    let onlineCalls = 0;
    const isOnline = (id: string) => options.onlineResult
        ? options.onlineResult(onlineCalls += 1)
        : online.has(id);

    const sessionManager = new SessionManager(
        pino({ level: `silent` }),
        { createShutdownHook: () => ({ tryShutdown: () => { } }), isShutdownPending: () => false } as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        { getPlayerRating: () => Promise.resolve({ eloScore: 1_000, gameCount: 0 }) } as never,
        { appendMove: () => Promise.resolve(), finishGame: () => Promise.resolve() } as never,
        { track: () => { } } as never,
        { getSettings: () => ({ maxConcurrentGames: null }) } as never,
    );
    const sessions = (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions;

    const botAccountRepository = {
        listAll: async () => [botAccount(ONLINE_BOT_ID), botAccount(OFFLINE_BOT_ID, `owner-2`)],
        findById: async (id: string) => (id === ONLINE_BOT_ID || id === OFFLINE_BOT_ID) ? botAccount(id) : null,
    };
    const authRepository = {
        getUserProfileById: async (id: string) => (id === ONLINE_BOT_ID || id === OFFLINE_BOT_ID) ? botProfile(id) : null,
    };
    const eloHandler = {
        getPlayerRating: async (id: string) => ({ eloScore: id === ONLINE_BOT_ID ? 1_500.4 : 900, gameCount: 3 }),
    };
    const registry = {
        isOnline,
        isOpenForChallenges: (id: string) => id === ONLINE_BOT_ID,
        getSocketId: (id: string) => `bot:${id}`,
    };

    const service = new BotDirectoryService(
        pino({ level: `silent` }),
        botAccountRepository as unknown as BotAccountRepository,
        authRepository as unknown as AuthRepository,
        eloHandler as unknown as EloHandler,
        sessionManager,
        registry as unknown as BotStreamRegistry,
    );

    return { sessionManager, service, sessions };
}

function seatBot(session: ServerGameSession, botProfileId: string, state: ServerGameSession['state'] = `in-game`): void {
    session.players.push({
        id: `seat-${session.id}`,
        deviceId: `bot:${botProfileId}`,
        profileId: botProfileId,
        displayName: botProfileId,
        rating: { eloScore: 1_000, gameCount: 0 },
        ratingAdjustment: null,
        ratingAdjusted: null,
        isBot: true,
        connection: { status: `connected`, socketId: `bot:${botProfileId}` },
    });
    session.state = state;
    session.startedAt = state === `in-game` ? Date.now() : null;
    session.gameId = state === `in-game` ? `game-${session.id}` : ``;
}

test(`the roster carries owner, rounded elo and connection state`, async () => {
    const { service } = createFixture();

    const listings = await service.listBots(false);

    const byId = new Map(listings.map((listing: BotListing) => [listing.profileId, listing]));
    assert.deepEqual(byId.get(ONLINE_BOT_ID), {
        profileId: ONLINE_BOT_ID,
        displayName: ONLINE_BOT_ID,
        elo: 1_500,
        owner: OWNER_PROFILE_ID,
        online: true,
        openForChallenges: true,
    });
    assert.equal(byId.get(OFFLINE_BOT_ID)?.online, false);
    assert.equal(byId.get(OFFLINE_BOT_ID)?.openForChallenges, false, `openness rides the stream entry`);
    assert.equal(byId.get(OFFLINE_BOT_ID)?.owner, `owner-2`);
});

test(`the roster is sorted by rating and narrows to connected bots on demand`, async () => {
    const { service } = createFixture();

    const everyone = await service.listBots(false);
    const connected = await service.listBots(true);

    assert.deepEqual(everyone.map(({ profileId }) => profileId), [ONLINE_BOT_ID, OFFLINE_BOT_ID]);
    assert.deepEqual(connected.map(({ profileId }) => profileId), [ONLINE_BOT_ID]);
});

test(`a bot session reserves both seats and claims the bot's seat`, async () => {
    const { sessionManager, service, sessions } = createFixture();

    const response = await service.createBotSession(HUMAN_PROFILE, ONLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
        timeControl: { mode: `unlimited` },
    });

    const session = sessionManager.requireSession(response.sessionId);
    assert.equal(sessions.has(session.id), true);
    assert.equal(session.gameOptions.visibility, `private`);
    assert.equal(session.gameOptions.rated, false, `a bot seat is never rated`);
    assert.deepEqual(session.reservedPlayerProfileIds, [HUMAN_PROFILE_ID, ONLINE_BOT_ID]);

    assert.equal(session.players.length, 1, `the human has not joined yet`);
    const botSeat = session.players[0];
    assert.equal(botSeat.profileId, ONLINE_BOT_ID);
    assert.equal(botSeat.isBot, true);
    assert.equal(botSeat.connection.status, `connected`);
    assert.equal(botSeat.deviceId, `bot:${ONLINE_BOT_ID}`);

    assert.deepEqual(sessionManager.getSessionInfo(session.id)?.players.map(({ isBot }) => isBot), [true],
        `the socket contract carries the seat kind`);
});


test(`a stream that drops while the seat is claimed gives the seat back`, async () => {
    /* Online for the guard, offline by the time the seat is claimed. */
    const { sessionManager, service } = createFixture({ onlineResult: (callIndex) => callIndex === 1 });

    await assert.rejects(
        () => service.createBotSession(HUMAN_PROFILE, ONLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
            timeControl: { mode: `unlimited` },
        }),
        /not connected/,
    );

    const sessions = (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions;
    const [remaining] = [...sessions.values()];
    assert.ok(!remaining || remaining.players.length === 0, `the seat was given back`);
});

test(`a reserved lobby whose human never joins is abandoned again`, async () => {
    const { sessionManager, service, sessions } = createFixture();

    const response = await service.createBotSession(HUMAN_PROFILE, ONLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
        timeControl: { mode: `unlimited` },
    });
    const session = sessionManager.requireSession(response.sessionId);
    session.createdAt = Date.now() - 61_000;

    await sessionManager.tickAllSessions();

    assert.equal(sessions.has(session.id), false, `the lobby was reaped`);
});

test(`a reserved lobby waits out its grace before being abandoned`, async () => {
    const { sessionManager, service, sessions } = createFixture();

    const response = await service.createBotSession(HUMAN_PROFILE, ONLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
        timeControl: { mode: `unlimited` },
    });
    const session = sessionManager.requireSession(response.sessionId);
    session.createdAt = Date.now() - 10_000;

    await sessionManager.tickAllSessions();

    assert.equal(sessions.has(session.id), true, `still within the window`);
});

test(`a bot that holds no stream cannot be played`, async () => {
    const { service } = createFixture();

    await assert.rejects(
        () => service.createBotSession(HUMAN_PROFILE, OFFLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
            timeControl: { mode: `unlimited` },
        }),
        /not connected/,
    );
});

test(`an unknown bot is a 404, not a 500`, async () => {
    const { service } = createFixture();

    await assert.rejects(
        () => service.createBotSession(HUMAN_PROFILE, `bot-nope`, { ip: `127.0.0.1` } as never, {
            timeControl: { mode: `unlimited` },
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as { statusCode?: number }).statusCode, 404);
            return true;
        },
    );
});

test(`a bot at the concurrent-game cap cannot be played`, async () => {
    const { sessionManager, service } = createFixture();

    for (let index = 0; index < 4; index += 1) {
        const session = createGameSession(`cap-${index}` as SessionId, {
            visibility: `private`,
            rated: false,
            timeControl: { mode: `unlimited` },
            firstPlayer: `host`,
        });
        seatBot(session, ONLINE_BOT_ID);
        new GameSimulation().startSession(session.gameState, [session.players[0].id], session.players[0].id);
        (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions.set(session.id, session);
    }

    await assert.rejects(
        () => service.createBotSession(HUMAN_PROFILE, ONLINE_BOT_ID, { ip: `127.0.0.1` } as never, {
            timeControl: { mode: `unlimited` },
        }),
        /4 games/,
    );
});
