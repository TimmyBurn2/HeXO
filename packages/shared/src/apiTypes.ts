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

export const zCreateSessionRequest = z.object({
    lobbyOptions: zLobbyOptions.optional(),
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

export const zBotAccount = z.object({
    id: zIdentifier,
    username: z.string(),
    image: z.string().nullable(),
    ownerProfileId: zIdentifier,
    createdAt: zTimestamp,
    tokenRotatedAt: zTimestamp.nullable(),
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

/* The options a human picks to start a game against a bot; the server owns the rest
 * (visibility is private, first player random, and every bot game is unrated). */
export const zCreateBotSessionRequest = z.object({
    timeControl: zGameTimeControl.optional(),
});
export type CreateBotSessionRequest = z.infer<typeof zCreateBotSessionRequest>;

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
