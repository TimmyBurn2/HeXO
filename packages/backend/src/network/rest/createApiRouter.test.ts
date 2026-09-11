import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AccountUserProfile } from '../../auth/authRepository';
import { MAX_BOTS_PER_OWNER } from '../../bots/botAccountService';
import { BotMoveError } from '../../bots/botPlayService';
import { SessionError } from '../../session/sessionManager';
import { ApiRequestError } from './apiQueryService';
import { ApiRouter } from './createApiRouter';

const owner = { id: `owner-1`, kind: `human` } as AccountUserProfile;
const botAccount = { id: `bot-1`, username: `Botty`, kind: `bot` } as AccountUserProfile;
const botPlayer = { profileId: `bot-1`, displayName: `Botty`, elo: 1_000 };
const bot = {
    id: `bot-1`,
    username: `Botty`,
    image: null,
    ownerProfileId: owner.id,
    createdAt: 1,
    tokenRotatedAt: 1,
};

function createRouter(overrides: {
    user?: AccountUserProfile | null;
    botApiEnabled?: boolean;
    botAccountService?: Partial<Record<string, unknown>>;
    botToken?: AccountUserProfile | null;
    botPlayService?: Partial<Record<string, unknown>>;
    houseBotService?: Partial<Record<string, unknown>>;
    sessionManager?: Partial<Record<string, unknown>>;
    botDirectoryService?: Partial<Record<string, unknown>>;
}) {
    const botAccountService = {
        listBots: () => Promise.resolve([bot]),
        createBot: () => Promise.resolve({ bot, token: `hxo_secret` }),
        rotateToken: () => Promise.resolve({ bot, token: `hxo_rotated` }),
        deleteBot: () => Promise.resolve(),
        ...overrides.botAccountService,
    };

    const houseBotService = {
        listBots: () => ({ bots: [], available: true }),
        createLobby: () => Promise.resolve({ sessionId: `house-session` }),
        ...overrides.houseBotService,
    };
    const sessionManager = {
        createSession: () => ({ sessionId: `open-session` }),
        ...overrides.sessionManager,
    };

    return new ApiRouter(
        {} as never,
        { getUserFromRequest: () => Promise.resolve(overrides.user ?? null) } as never,
        {} as never,
        { isEnabled: () => false } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        sessionManager as never,
        {} as never,
        {} as never,
        { botApiEnabled: overrides.botApiEnabled ?? true } as never,
        botAccountService as never,
        { getBotFromRequest: () => Promise.resolve(overrides.botToken ?? null) } as never,
        {
            listBots: () => Promise.resolve([]),
            createBotSession: () => Promise.resolve({ sessionId: `fresh-session` }),
            ...overrides.botDirectoryService,
        } as never,
        {
            getAccount: () => Promise.resolve({ bot: botPlayer, owner: botPlayer, activeGames: [] }),
            updateAccount: () => Promise.resolve({ bot: botPlayer, owner: botPlayer, activeGames: [] }),
            getGameSnapshot: () => Promise.resolve({ gameId: `game-1`, board: { to_move: `x`, cells: [] }, clock: { mode: `unlimited` }, status: `in-progress` }),
            joinSession: () => Promise.resolve(),
            playMove: () => Promise.resolve(),
            resignGame: () => Promise.resolve(),
            ...overrides.botPlayService,
        } as never,
        { attach: () => { }, open: () => { }, getSocketId: (id: string) => `bot:${id}` } as never,
        houseBotService as never,
    );
}

async function withServer(
    router: ApiRouter,
    run: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    app.use(`/api`, router.router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once(`listening`, resolve));

    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test(`bot routes reject a signed out request`, async () => {
    await withServer(createRouter({ user: null }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: `Sign in with Discord to manage bots.` });
    });
});

test(`listing bots reports the per owner limit`, async () => {
    await withServer(createRouter({ user: owner }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bots: [bot], limit: MAX_BOTS_PER_OWNER });
    });
});

test(`creating a bot answers 201 with the issued token`, async () => {
    await withServer(createRouter({ user: owner }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ username: `Botty` }),
        });

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { bot, token: `hxo_secret` });
    });
});

test(`rotating a token passes the bot id through`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        user: owner,
        botAccountService: {
            rotateToken: (_owner: AccountUserProfile, botProfileId: string) => {
                seen.push(botProfileId);
                return Promise.resolve({ bot, token: `hxo_rotated` });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots/bot-1/token`, { method: `POST` });
        assert.equal(response.status, 200);
        assert.deepEqual(seen, [`bot-1`]);
    });
});

test(`deleting a bot answers with the refreshed list`, async () => {
    const router = createRouter({
        user: owner,
        botAccountService: { listBots: () => Promise.resolve([]) },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots/bot-1`, { method: `DELETE` });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bots: [], limit: MAX_BOTS_PER_OWNER });
    });
});

test(`a service rejection is mapped to its status code`, async () => {
    const router = createRouter({
        user: owner,
        botAccountService: {
            createBot: () => Promise.reject(new ApiRequestError(409, `You can own at most 3 bots.`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ username: `Botty` }),
        });

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: `You can own at most 3 bots.` });
    });
});

test(`the routes are absent while the flag is off`, async () => {
    await withServer(createRouter({ user: owner, botApiEnabled: false }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 404);
    });
});

test(`the play routes reject a request without a bot token`, async () => {
    const router = createRouter({ botToken: null });

    await withServer(router, async (baseUrl) => {
        for (const [method, path] of [
            [`GET`, `/bot/account`],
            [`PATCH`, `/bot/account`],
            [`GET`, `/bot/stream`],
            [`GET`, `/bot/game/game-1`],
            [`POST`, `/bot/game/game-1/move`],
            [`POST`, `/bot/game/game-1/resign`],
            [`POST`, `/bot/session/abc123/join`],
        ] as const) {
            const response = await fetch(`${baseUrl}${path}`, { method });
            assert.equal(response.status, 401, path);
        }
    });
});

test(`the play routes do not exist while the flag is off`, async () => {
    const router = createRouter({ botApiEnabled: false, botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        for (const [method, path] of [
            [`GET`, `/bot/account`],
            [`PATCH`, `/bot/account`],
            [`GET`, `/bot/stream`],
            [`GET`, `/bot/game/game-1`],
            [`POST`, `/bot/game/game-1/move`],
            [`POST`, `/bot/game/game-1/resign`],
            [`POST`, `/bot/session/abc123/join`],
            [`GET`, `/bots`],
            [`POST`, `/bots/bot-1/session`],
        ] as const) {
            const response = await fetch(`${baseUrl}${path}`, { method });
            assert.equal(response.status, 404, path);
        }
    });
});

test(`a bot reads its own account`, async () => {
    const router = createRouter({ botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/account`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bot: botPlayer, owner: botPlayer, activeGames: [] });
    });
});

test(`a declaration patch reaches the service, an invalid one answers 400`, async () => {
    const seen: unknown[] = [];
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            updateAccount: (_bot: unknown, patch: unknown) => {
                seen.push(patch);
                return Promise.resolve({ bot: botPlayer, owner: botPlayer, activeGames: [] });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/account`, {
            method: `PATCH`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({
                about: `Strix, a reference bot`,
                version: `1.0.0`,
                repoUrl: `https://github.com/TimmyBurn2/Hexo-Bot-Api`,
                accepts: { turnMs: [5_000, 600_000], match: true, unlimited: true },
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(seen.length, 1);

        /* The window is the one shape a bot can get wrong: min above max. */
        for (const body of [
            { accepts: { turnMs: [60_000, 5_000], match: true, unlimited: true } },
            { repoUrl: `not a url` },
            { about: `x`.repeat(281) },
        ]) {
            const rejected = await fetch(`${baseUrl}/bot/account`, {
                method: `PATCH`,
                headers: { 'Content-Type': `application/json` },
                body: JSON.stringify(body),
            });

            assert.equal(rejected.status, 400, JSON.stringify(body));
            assert.deepEqual(await rejected.json(), { error: `The account declaration is not valid.` });
        }

        assert.equal(seen.length, 1, `no invalid patch reached the service`);
    });
});

test(`a game snapshot is served to any authenticated bot, a 404 stays a 404`, async () => {
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            getGameSnapshot: (gameId: string) => gameId === `game-1`
                ? Promise.resolve({
                    gameId,
                    board: { to_move: `o`, cells: [{ q: 0, r: 0, p: `x` }] },
                    clock: { mode: `unlimited` },
                    status: `in-progress`,
                })
                : Promise.reject(new ApiRequestError(404, `That game does not exist.`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/game/game-1`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            gameId: `game-1`,
            board: { to_move: `o`, cells: [{ q: 0, r: 0, p: `x` }] },
            clock: { mode: `unlimited` },
            status: `in-progress`,
        });

        const missing = await fetch(`${baseUrl}/bot/game/nope`);
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: `That game does not exist.` });
    });
});

test(`a rejected move answers with the contract's error code`, async () => {
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            playMove: () => Promise.reject(new BotMoveError(`It is not your turn.`, `not-your-turn`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/game/game-1/move`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ move: { pieces: [{ q: 1, r: 0 }, { q: 2, r: 0 }] } }),
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: `It is not your turn.`, code: `not-your-turn` });
    });
});

test(`joining a lobby answers ok`, async () => {
    const router = createRouter({ botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/session/abc123/join`, { method: `POST` });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
    });
});

test(`resigning a game answers ok`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            resignGame: (_bot: AccountUserProfile, gameId: string) => {
                seen.push(gameId);
                return Promise.resolve();
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/game/game-1/resign`, { method: `POST` });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.deepEqual(seen, [`game-1`]);
    });
});

test(`house bots are listed while the flag is on and absent while it is off`, async () => {
    await withServer(createRouter({ user: null }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/house-bots`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bots: [], available: true });
    });

    await withServer(createRouter({ user: null, botApiEnabled: false }), async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/house-bots`)).status, 404);
    });
});

test(`a lobby with an opponent goes to the house bots; with the flag off the key is ignored`, async () => {
    const seen: unknown[] = [];
    const router = createRouter({
        user: null,
        houseBotService: {
            createLobby: (_client: unknown, lobbyOptions: unknown, opponent: unknown) => {
                seen.push({ lobbyOptions, opponent });
                return Promise.resolve({ sessionId: `house-session` });
            },
        },
    });
    const body = JSON.stringify({
        lobbyOptions: { visibility: `private`, rated: true },
        opponent: { kind: `house-bot`, profileId: `bot-1`, thinkMs: 300 },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/sessions`, { method: `POST`, headers: { 'Content-Type': `application/json` }, body });
        assert.equal(response.status, 401, `rated is still the signed-in rule before the opponent is looked at`);
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/sessions`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ lobbyOptions: { visibility: `private` }, opponent: { kind: `house-bot`, profileId: `bot-1`, thinkMs: 300 } }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sessionId: `house-session` });
        assert.equal(seen.length, 1);
        assert.deepEqual((seen[0] as { opponent: unknown }).opponent, { kind: `house-bot`, profileId: `bot-1`, thinkMs: 300 });
    });

    await withServer(createRouter({ user: null, botApiEnabled: false, houseBotService: { createLobby: () => Promise.reject(new Error(`must not be called`)) } }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/sessions`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ opponent: { kind: `house-bot`, profileId: `bot-1`, thinkMs: `garbage` } }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sessionId: `open-session` });
    });
});

test(`a refused house lobby answers with the service's status`, async () => {
    const router = createRouter({
        user: null,
        houseBotService: { createLobby: () => Promise.reject(new ApiRequestError(409, `SealBot is busy.`)) },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/sessions`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ opponent: { kind: `house-bot`, profileId: `bot-1`, thinkMs: 300 } }),
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: `SealBot is busy.` });
    });
});

test(`the bot roster is readable without signing in`, async () => {
    const listing = { profileId: `bot-1`, displayName: `Strix`, elo: 1_337, owner: `owner-1`, online: true, openForChallenges: false };
    const router = createRouter({ botDirectoryService: { listBots: () => Promise.resolve([listing]) } });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots?online=1`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), [listing]);
    });
});

test(`starting a bot session requires signing in`, async () => {
    const router = createRouter({ user: null });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, { method: `POST` });

        assert.equal(response.status, 401);
    });
});

test(`starting a bot session answers with the new session id`, async () => {
    const seenOptions: object[] = [];
    const router = createRouter({
        user: owner,
        botDirectoryService: {
            createBotSession: (_user: AccountUserProfile, profileId: string, _client: unknown, options: object) => {
                seenOptions.push({ profileId, options });
                return Promise.resolve({ sessionId: `fresh-session` });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        /* A legacy body still asking for a rated game gets the field dropped on the
         * floor: a bot seat is never rated, and the server does not pretend to obey. */
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ rated: true }),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sessionId: `fresh-session` });
        assert.deepEqual(seenOptions, [{
            profileId: `bot-1`,
            options: { timeControl: { mode: `turn`, turnTimeMs: 45_000 } },
        }]);
    });
});

test(`a malformed bot session request answers 400`, async () => {
    const router = createRouter({ user: owner });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ timeControl: { mode: `nonsense` } }),
        });

        assert.equal(response.status, 400);
    });
});

test(`a bot session the session manager refuses answers 409`, async () => {
    const router = createRouter({
        user: owner,
        botDirectoryService: {
            createBotSession: () => Promise.reject(new SessionError(`The server is currently at its concurrent game limit (2). Please wait for another game to finish before creating a new one.`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ rated: true }),
        });

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: `The server is currently at its concurrent game limit (2). Please wait for another game to finish before creating a new one.` });
    });
});
