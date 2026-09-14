import { z } from "zod";

import {
    zAccountPermission,
    zAccountPreferences,
    zAccountProfile,
    zAccountStatistics,
    zAdminBroadcastMessage,
    zAdminStatsWindow,
    zAdminUserStatsWindow,
    zFinishedGamesPage,
    zGameTimeControl,
    zIdentifier,
    zLobbyOptions,
    zNormalizedUsername,
    zSandboxGamePosition,
    zSandboxPositionId,
    zSandboxPositionName,
    zServerSettings,
    zSessionInfo,
    zShutdownState,
    zTimestamp,
    zPublicAccountProfile,
    zSessionId,
} from "./sharedTypes";

export const zAdminScheduleShutdownRequest = z.object({
    delayMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
});
export type AdminScheduleShutdownRequest = z.infer<
    typeof zAdminScheduleShutdownRequest
>;

export const zAdminShutdownControlResponse = z.object({
    shutdown: zShutdownState.nullable(),
});
export type AdminShutdownControlResponse = z.infer<
    typeof zAdminShutdownControlResponse
>;

export const zAdminBroadcastMessageRequest = z.object({
    message: z.string().trim().min(1).max(280),
});
export type AdminBroadcastMessageRequest = z.infer<
    typeof zAdminBroadcastMessageRequest
>;

export const zAdminBroadcastMessageResponse = z.object({
    broadcast: zAdminBroadcastMessage,
});
export type AdminBroadcastMessageResponse = z.infer<
    typeof zAdminBroadcastMessageResponse
>;

export const zAdminUpdateServerSettingsRequest = z.object({
    settings: zServerSettings,
});
export type AdminUpdateServerSettingsRequest = z.infer<
    typeof zAdminUpdateServerSettingsRequest
>;

export const zAdminServerSettingsResponse = z.object({
    settings: zServerSettings,
    currentConcurrentGames: z.number().int().nonnegative(),
});
export type AdminServerSettingsResponse = z.infer<
    typeof zAdminServerSettingsResponse
>;

export const zCreateSandboxPositionRequest = z.object({
    originalPositionId: zSandboxPositionId.nullable(),
    name: zSandboxPositionName,
    gamePosition: zSandboxGamePosition,
});
export type CreateSandboxPositionRequest = z.infer<
    typeof zCreateSandboxPositionRequest
>;

export const zCreateSandboxPositionResponse = z.object({
    id: zSandboxPositionId,
    name: zSandboxPositionName,
});
export type CreateSandboxPositionResponse = z.infer<
    typeof zCreateSandboxPositionResponse
>;

export const zSandboxPositionResponse = z.object({
    originalPositionId: zSandboxPositionId.nullable(),
    id: zSandboxPositionId,
    name: zSandboxPositionName,
    gamePosition: zSandboxGamePosition,
});
export type SandboxPositionResponse = z.infer<typeof zSandboxPositionResponse>;

/* The server's own engine-driven opponents (`GET /api/house-bots`). Strength is one
 * knob, the think time, because that is the only one `BotEngineInterface` has; the
 * presets name points on it and the range bounds a custom pick. */
export const zHouseBotStrengthPreset = z.object({
    id: z.string(),
    thinkMs: z.number().int().nonnegative(),
});
export type HouseBotStrengthPreset = z.infer<typeof zHouseBotStrengthPreset>;

export const zHouseBotListing = z.object({
    profileId: zIdentifier,
    displayName: z.string(),
    engine: z.string(),
    thinkMs: z.object({
        min: z.number().int().nonnegative(),
        max: z.number().int().nonnegative(),
        default: z.number().int().nonnegative(),
    }),
    presets: z.array(zHouseBotStrengthPreset),
});
export type HouseBotListing = z.infer<typeof zHouseBotListing>;

export const zHouseBotsResponse = z.object({
    bots: z.array(zHouseBotListing),
    /* False while every engine slot is taken: the bots are shown but not offered. */
    available: z.boolean(),
});
export type HouseBotsResponse = z.infer<typeof zHouseBotsResponse>;

/** `300` → `0.3s`: how a think time reads on a seat and in the picker. */
export function formatThinkSeconds(thinkMs: number): string {
    return `${thinkMs / 1000}s`;
}

/* Who takes the other seat of a new lobby; absent means an open lobby. */
export const zLobbyOpponent = z.discriminatedUnion(`kind`, [
    z.object({
        kind: z.literal(`house-bot`),
        profileId: zIdentifier,
        thinkMs: z.number().int().nonnegative(),
    }),
    /* A community bot: seated at creation over its stream, like a house bot over its engine. */
    z.object({
        kind: z.literal(`bot`),
        profileId: zIdentifier,
    }),
]);
export type LobbyOpponent = z.infer<typeof zLobbyOpponent>;

export const zCreateSessionRequest = z.object({
    lobbyOptions: zLobbyOptions.optional(),
    opponent: zLobbyOpponent.optional(),
});
export type CreateSessionRequest = z.infer<typeof zCreateSessionRequest>;

export const zCreateSessionResponse = z.object({
    sessionId: zSessionId,
});
export type CreateSessionResponse = z.infer<typeof zCreateSessionResponse>;

export const zAdminTerminateSessionResponse = z.object({
    session: zSessionInfo,
});
export type AdminTerminateSessionResponse = z.infer<
    typeof zAdminTerminateSessionResponse
>;

export const zAccountResponse = z.object({
    user: zAccountProfile.nullable(),
});
export type AccountResponse = z.infer<typeof zAccountResponse>;

export const zAdminUserSearchResponse = z.object({
    users: z.array(zAccountProfile),
});
export type AdminUserSearchResponse = z.infer<typeof zAdminUserSearchResponse>;

export const zAdminUpdateUserPermissionsRequest = z.object({
    permissions: z.array(zAccountPermission).default([]),
});
export type AdminUpdateUserPermissionsRequest = z.infer<
    typeof zAdminUpdateUserPermissionsRequest
>;

export const zAdminUpdateUserPermissionsResponse = z.object({
    user: zAccountProfile.nullable(),
});
export type AdminUpdateUserPermissionsResponse = z.infer<
    typeof zAdminUpdateUserPermissionsResponse
>;

export const zProfileResponse = z.object({
    user: zPublicAccountProfile.nullable(),
});
export type ProfileResponse = z.infer<typeof zProfileResponse>;

export const zAccountPreferencesResponse = z.object({
    preferences: zAccountPreferences,
});
export type AccountPreferencesResponse = z.infer<
    typeof zAccountPreferencesResponse
>;

export const zUserSearchResponse = z.object({
    users: z.array(zPublicAccountProfile),
});
export type UserSearchResponse = z.infer<typeof zUserSearchResponse>;

export const zProfileStatisticsResponse = z.object({
    statistics: zAccountStatistics,
});
export type ProfileStatisticsResponse = z.infer<
    typeof zProfileStatisticsResponse
>;

export const zProfileGamesResponse = zFinishedGamesPage;
export type ProfileGamesResponse = z.infer<typeof zProfileGamesResponse>;

export const zAdminStatsResponse = z.object({
    generatedAt: zTimestamp,
    activeGames: z.object({
        total: z.number().int().nonnegative(),
        public: z.number().int().nonnegative(),
        private: z.number().int().nonnegative(),
    }),
    connectedClients: z.number().int().nonnegative(),
    users: z.object({
        total: z.number().int().nonnegative(),
        intervals: z.object({
            sinceMidnight: zAdminUserStatsWindow,
            last7Days: zAdminUserStatsWindow,
            lastMonth: zAdminUserStatsWindow,
        }),
    }),
    intervals: z.object({
        sinceMidnight: zAdminStatsWindow,
        last24Hours: zAdminStatsWindow,
        last7Days: zAdminStatsWindow,
    }),
});
export type AdminStatsResponse = z.infer<typeof zAdminStatsResponse>;

export const zUpdateAccountProfileRequest = z.object({
    username: zNormalizedUsername,
});
export type UpdateAccountProfileRequest = z.infer<
    typeof zUpdateAccountProfileRequest
>;

export const zUpdateAccountPreferencesRequest = z.object({
    preferences: zAccountPreferences.partial(),
});
export type UpdateAccountPreferencesRequest = z.infer<
    typeof zUpdateAccountPreferencesRequest
>;

/* What a bot will play under, declared by the bot itself over the API (spec 0.4):
 * the owner cannot promise behaviour for it. `turnMs` is the accepted turn-clock
 * window [min, max] in milliseconds, or null to decline turn clocks entirely. */
export const zBotAccepts = z.object({
    turnMs: z.tuple([z.number().int(), z.number().int()])
        .nullable()
        .refine((window) => window === null || window[0] <= window[1], `turnMs min must not exceed its max`),
    match: z.boolean(),
    unlimited: z.boolean(),
});
export type BotAccepts = z.infer<typeof zBotAccepts>;

/* The body of `PATCH /api/bot/account`: every field optional, each present field
 * replacing the stored one, an empty string clearing a text field, `accepts`
 * replaced wholesale. */
export const zBotDeclarationPatch = z.object({
    about: z.string().max(280).optional(),
    version: z.string().optional(),
    repoUrl: z.union([z.literal(``), z.url()]).optional(),
    accepts: zBotAccepts.optional(),
});
export type BotDeclarationPatch = z.infer<typeof zBotDeclarationPatch>;

/* The stored declaration: exactly what the bot last sent and did not clear. */
export const zBotDeclaration = z.object({
    about: z.string().min(1).max(280).optional(),
    version: z.string().min(1).optional(),
    repoUrl: z.url().optional(),
    accepts: zBotAccepts.optional(),
});
export type BotDeclaration = z.infer<typeof zBotDeclaration>;

export const zBotAccount = z.object({
    id: zIdentifier,
    username: z.string(),
    image: z.string().nullable(),
    /** `null` = server-owned (a house bot). */
    ownerProfileId: zIdentifier.nullable(),
    createdAt: zTimestamp,
    tokenRotatedAt: zTimestamp.nullable(),
    /** What the bot declared about itself over the API, if anything. */
    declaration: zBotDeclaration.optional(),
});
export type BotAccount = z.infer<typeof zBotAccount>;

export const zBotAccountsResponse = z.object({
    bots: z.array(zBotAccount),
    limit: z.number().int().positive(),
});
export type BotAccountsResponse = z.infer<typeof zBotAccountsResponse>;

export const zCreateBotAccountRequest = z.object({
    username: zNormalizedUsername,
});
export type CreateBotAccountRequest = z.infer<
    typeof zCreateBotAccountRequest
>;

/** The plaintext token is returned only here and on rotation; it is stored hashed. */
export const zBotAccountTokenResponse = z.object({
    bot: zBotAccount,
    token: z.string(),
});
export type BotAccountTokenResponse = z.infer<
    typeof zBotAccountTokenResponse
>;

/* The public bot directory, spec tag Directory (`GET /api/bots`). */
export const zBotListing = z.object({
    profileId: zIdentifier,
    displayName: z.string(),
    elo: z.number().int(),
    owner: zIdentifier.optional(),
    online: z.boolean(),
    openForChallenges: z.boolean(),
});
export type BotListing = z.infer<typeof zBotListing>;

/*
 * The bot play API. Paths, event shapes and error codes are defined by the spec
 * repository (TimmyBurn2/Hexo-Bot-Api); these schemas mirror it and must not drift.
 * The `Htttx*` half is the htttx stateless v1-alpha engine exchange, vendored there
 * from htttx-bot-api@37d2385, and uses axial `q,r` — never HeXO's `x,y`.
 */

export const zHtttxSide = z.enum([`x`, `o`]);
export type HtttxSide = z.infer<typeof zHtttxSide>;

export const zHtttxCoord = z.object({
    q: z.number().int(),
    r: z.number().int(),
});
export type HtttxCoord = z.infer<typeof zHtttxCoord>;

export const zHtttxBoard = z.object({
    to_move: zHtttxSide,
    cells: z.array(zHtttxCoord.extend({ p: zHtttxSide })),
});
export type HtttxBoard = z.infer<typeof zHtttxBoard>;

export const zHtttxMove = z.object({
    pieces: z.array(zHtttxCoord).length(2),
    evaluation: z.looseObject({
        heuristic: z.number().optional(),
        win_in: z.number().int().optional(),
    }).optional(),
});
export type HtttxMove = z.infer<typeof zHtttxMove>;

export const zHtttxMoveRequest = z.object({
    board: zHtttxBoard,
    time_limit: z.number().nonnegative().optional(),
    request_id: z.number().int().nonnegative().optional(),
});
export type HtttxMoveRequest = z.infer<typeof zHtttxMoveRequest>;

export const zHtttxMoveResponse = z.object({
    move: zHtttxMove,
    considerations: z.array(zHtttxMove).optional(),
    request_id: z.number().int().nonnegative().optional(),
});
export type HtttxMoveResponse = z.infer<typeof zHtttxMoveResponse>;

/** `elo` is null for a guest, who has no rating; so is `profileId`. */
export const zBotPlayer = z.object({
    profileId: zIdentifier.nullable(),
    displayName: z.string(),
    elo: z.number().int().nullable(),
});
export type BotPlayer = z.infer<typeof zBotPlayer>;

export const zBotActiveGame = z.object({
    gameId: z.string(),
    side: zHtttxSide,
});
export type BotActiveGame = z.infer<typeof zBotActiveGame>;

export const zBotAccountInfoResponse = z.object({
    bot: zBotPlayer,
    owner: zBotPlayer,
    activeGames: z.array(zBotActiveGame),
    /* The declaration's fields ride along; each is absent until the bot declares it. */
    about: z.string().optional(),
    version: z.string().optional(),
    repoUrl: z.string().optional(),
    accepts: zBotAccepts.optional(),
});
export type BotAccountInfoResponse = z.infer<typeof zBotAccountInfoResponse>;

/** The spec's closed enum: `draw-agreement` is unreachable, bot games have no draw. */
export const zBotFinishReason = z.enum([
    `aborted`,
    `disconnect`,
    `surrender`,
    `timeout`,
    `terminated`,
    `six-in-a-row`,
]);
export type BotFinishReason = z.infer<typeof zBotFinishReason>;

/* The clock half of a game snapshot, mirroring `TimeControl`'s modes: `turn` carries
 * the remaining budget of the side to move, `match` each side's remaining main time,
 * `unlimited` nothing. */
export const zBotGameClock = z.discriminatedUnion(`mode`, [
    z.object({ mode: z.literal(`unlimited`) }),
    z.object({
        mode: z.literal(`turn`),
        remainingTurnMs: z.number().int().nonnegative(),
    }),
    z.object({
        mode: z.literal(`match`),
        remainingMainMs: z.object({
            x: z.number().int().nonnegative(),
            o: z.number().int().nonnegative(),
        }),
    }),
]);
export type BotGameClock = z.infer<typeof zBotGameClock>;

/* `GET /api/bot/game/{gameId}`: the position as the htttx `Board` the players' own
 * move requests are cut from, plus clock and status. `winner` and `reason` exist
 * once the game is finished. */
export const zBotGameSnapshot = z.object({
    gameId: z.string(),
    board: zHtttxBoard,
    clock: zBotGameClock,
    status: z.enum([`in-progress`, `finished`]),
    winner: zHtttxSide.nullable().optional(),
    reason: zBotFinishReason.optional(),
});
export type BotGameSnapshot = z.infer<typeof zBotGameSnapshot>;

export const zBotGameStartEvent = z.object({
    type: z.literal(`gameStart`),
    gameId: z.string(),
    side: zHtttxSide,
    opponent: zBotPlayer,
    timeControl: zGameTimeControl,
    rated: z.boolean(),
});
export type BotGameStartEvent = z.infer<typeof zBotGameStartEvent>;

export const zBotMoveRequestEvent = z.object({
    type: z.literal(`moveRequest`),
    gameId: z.string(),
    request: zHtttxMoveRequest,
});
export type BotMoveRequestEvent = z.infer<typeof zBotMoveRequestEvent>;

export const zBotGameFinishEvent = z.object({
    type: z.literal(`gameFinish`),
    gameId: z.string(),
    winner: zHtttxSide.nullable(),
    reason: zBotFinishReason,
});
export type BotGameFinishEvent = z.infer<typeof zBotGameFinishEvent>;

export const zBotStreamEvent = z.discriminatedUnion(`type`, [
    zBotGameStartEvent,
    zBotMoveRequestEvent,
    zBotGameFinishEvent,
]);
export type BotStreamEvent = z.infer<typeof zBotStreamEvent>;

/** Move rejections a bot can act on; anything else is a plain 400. */
export const zBotMoveErrorCode = z.enum([
    `not-your-turn`,
    `occupied`,
    `out-of-range`,
    `game-over`,
    `stale-request`,
]);
export type BotMoveErrorCode = z.infer<typeof zBotMoveErrorCode>;
