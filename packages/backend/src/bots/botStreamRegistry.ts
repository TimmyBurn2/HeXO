import {
    type BotStreamEvent,
    type HtttxSide,
    zBotFinishReason,
    zBotStreamEvent,
} from '@ih3t/shared';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import type { AccountUserProfile } from '../auth/authRepository';
import { ROOT_LOGGER } from '../logger';
import { SessionManager } from '../session/sessionManager';
import type { ServerGameSession, ServerSessionPlayer } from '../session/types';
import { BotPlayerMapper } from './botPlayerMapper';
import { sideOf, toMoveRequest } from './htttxCodec';

const KEEPALIVE_INTERVAL_MS = 10_000;
const MAX_BUFFERED_BYTES = 1_000_000;

/** The subset of an `http.ServerResponse` an NDJSON stream needs. */
export type BotStreamConnection = {
    setHeader(name: string, value: string): unknown;
    flushHeaders(): void;
    write(chunk: string): boolean;
    end(): void;
    destroy(): void;
    on(event: `close`, listener: () => void): unknown;
    on(event: `error`, listener: (error: Error) => void): unknown;
    readonly writableLength: number;
};

type BotStreamGame = {
    gameId: string;
    seatId: string;
    side: HtttxSide;
};

type BotStream = {
    connection: BotStreamConnection;
    openForChallenges: boolean;
    keepalive: ReturnType<typeof setInterval>;

    /** Keyed by session id, which never reaches the wire. */
    games: Map<string, BotStreamGame>;
    lastRequestedCellCount: Map<string, number>;
    originPlacements: Set<string>;
};

/**
 * One NDJSON stream per bot, and the bot's presence: while it is held the bot is
 * online, and dropping it orphans every game at once, because a bot has a single
 * virtual socket id for all of them. Mirrors how `devSupportService` gives its
 * server-side players `dev-bot:` socket ids.
 */
@injectable()
export class BotStreamRegistry {
    private readonly logger: Logger;
    private readonly streams = new Map<string, BotStream>();
    /**
     * Request ids belong to the game, not to the connection carrying it: the contract
     * has them rise monotonically within a game, and a bot that drops and comes back is
     * still in the same game. Keyed `<botId>::<sessionId>`, cleared when the game ends.
     */
    private readonly requestIds = new Map<string, number>();
    /** The last request id the bot already answered, so a retried move after a lost
     * HTTP response is answered, not rejected. Keyed like `requestIds`. */
    private readonly answeredRequestIds = new Map<string, number>();
    private unsubscribe: (() => void) | null = null;

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotPlayerMapper) private readonly botPlayerMapper: BotPlayerMapper,
    ) {
        this.logger = rootLogger.child({ component: `bot-stream-registry` });
    }

    /** Subscribes beside the socket gateway rather than replacing it. */
    attach(): void {
        this.unsubscribe ??= this.sessionManager.addEventHandlers({
            gameStarted: ({ sessionId }) => this.reconcile(sessionId),
            gameStateUpdated: ({ sessionId }) => this.reconcile(sessionId),
            gameCellPlacement: ({ sessionId }) => this.reconcile(sessionId),
            gameFinished: ({ sessionId, reason, winningPlayerId }) => this.finish(sessionId, reason, winningPlayerId),
            lobbyRemoved: ({ id }) => this.abortIfVanished(id),
        });
    }

    detach(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const botId of [...this.streams.keys()]) {
            this.closeStream(botId);
        }
    }

    /** A bot's games all hang off this one id, so one drop orphans all of them. */
    getSocketId(botId: string): string {
        return `bot:${botId}`;
    }

    isOnline(botId: string): boolean {
        return this.streams.has(botId);
    }

    /** The last request id sent for a game, so a late answer can be spotted. */
    getRequestId(botId: string, sessionId: string): number | null {
        return this.requestIds.get(requestKey(botId, sessionId)) ?? null;
    }

    /** The last request id the bot already answered for a game, if any. */
    getAnsweredRequestId(botId: string, sessionId: string): number | null {
        return this.answeredRequestIds.get(requestKey(botId, sessionId)) ?? null;
    }

    /** Records a request id as answered, so its retry is recognised as a replay. */
    markAnsweredRequestId(botId: string, sessionId: string, requestId: number): void {
        this.answeredRequestIds.set(requestKey(botId, sessionId), requestId);
    }

    open(bot: AccountUserProfile, connection: BotStreamConnection, openForChallenges: boolean): void {
        /* A second stream replaces the first; the bot keeps its games either way. */
        this.closeStream(bot.id);

        const stream: BotStream = {
            connection,
            /* Held for `challenges`, which is the feature that reads it. */
            openForChallenges,
            keepalive: setInterval(() => this.write(bot.id, `\n`), KEEPALIVE_INTERVAL_MS),
            games: new Map(),
            lastRequestedCellCount: new Map(),
            originPlacements: new Set(),
        };
        stream.keepalive.unref?.();

        connection.setHeader(`Content-Type`, `application/x-ndjson`);
        connection.setHeader(`Cache-Control`, `no-cache`);
        connection.setHeader(`Connection`, `keep-alive`);
        /* A buffering reverse proxy would otherwise hold every line back. */
        connection.setHeader(`X-Accel-Buffering`, `no`);
        connection.flushHeaders();

        this.streams.set(bot.id, stream);
        connection.on(`close`, () => {
            if (this.streams.get(bot.id) !== stream) {
                /* Already replaced by a newer stream, which owns the socket now. */
                return;
            }

            this.dropStream(bot.id, stream);
        });
        connection.on(`error`, (error) => {
            /* The socket can die without a `close` first; without this listener the
             * process would go down with the stream. */
            this.logger.warn({ event: `bots.stream.error`, botId: bot.id, err: error }, `Bot stream errored`);
            if (this.streams.get(bot.id) === stream) {
                this.dropStream(bot.id, stream);
            }
        });

        this.replay(bot.id);
    }

    /** Every active game comes back as a gameStart, and a moveRequest if it is our turn. */
    private replay(botId: string): void {
        for (const participation of this.sessionManager.getPlayerParticipationsByProfileId(botId)) {
            if (participation.role !== `player` || participation.session.state !== `in-game`) {
                continue;
            }

            this.sessionManager.assignParticipantSocket(
                participation.session,
                participation.participant.id,
                this.getSocketId(botId),
            );
            this.reconcile(participation.session.id);
        }
    }

    private reconcile(sessionId: string): void {
        if (this.streams.size === 0) {
            return;
        }

        const session = this.sessionManager.getSession(sessionId);
        if (!session || session.state !== `in-game` || !session.gameId) {
            return;
        }

        for (const [botId, stream] of this.streams) {
            const seat = session.players.find((player) => player.isBot && player.profileId === botId);
            if (seat) {
                this.reconcileSeat(botId, stream, session, seat);
            }
        }
    }

    private reconcileSeat(
        botId: string,
        stream: BotStream,
        session: ServerGameSession,
        seat: ServerSessionPlayer,
    ): void {
        const snapshot = this.sessionManager.getSessionSnapshot(session.id);
        if (!snapshot) {
            return;
        }

        const { gameState } = snapshot;
        const side = sideOf(gameState, seat.id);
        if (!stream.games.has(session.id)) {
            stream.games.set(session.id, { gameId: session.gameId, seatId: seat.id, side });
            this.emit(botId, {
                type: `gameStart`,
                gameId: session.gameId,
                side,
                opponent: this.botPlayerMapper.fromSeat(session.players.find((player) => player.id !== seat.id)),
                timeControl: session.gameOptions.timeControl,
                rated: session.isRatedGame,
            });
        }

        if (gameState.winner) {
            /* A winning second stone still completes the turn, and the state is emitted
             * before the session is marked finished: without this, the loser would be
             * asked to move in a game that is already over. */
            return;
        }

        const isOurTurn = gameState.currentTurnPlayerId === seat.id;
        if (isOurTurn && gameState.cells.length === 0 && gameState.placementsRemaining === 1) {
            this.placeOrigin(stream, session, seat);
            return;
        }

        if (!isOurTurn || gameState.placementsRemaining !== 2) {
            return;
        }

        if (stream.lastRequestedCellCount.get(session.id) === gameState.cells.length) {
            return;
        }

        stream.lastRequestedCellCount.set(session.id, gameState.cells.length);
        const key = requestKey(botId, session.id);
        const requestId = (this.requestIds.get(key) ?? 0) + 1;
        this.requestIds.set(key, requestId);
        this.emit(botId, {
            type: `moveRequest`,
            gameId: session.gameId,
            request: toMoveRequest(gameState, gameState.currentTurnExpiresInMs, requestId),
        });
    }

    /**
     * The opening stone is placed for the bot, so every request it sees wants exactly
     * two placements, as htttx assumes. There is no server-side `autoPlaceOriginTile`
     * to reuse: that preference is acted on by the browser.
     */
    private placeOrigin(stream: BotStream, session: ServerGameSession, seat: ServerSessionPlayer): void {
        if (stream.originPlacements.has(session.id)) {
            return;
        }

        stream.originPlacements.add(session.id);
        /* Queued, not awaited: this runs inside the session lock the event came from. */
        void this.sessionManager.placeCell(session, seat.id, { x: 0, y: 0 })
            .catch((error: unknown) => {
                stream.originPlacements.delete(session.id);
                this.logger.warn(
                    { err: error, event: `bots.origin.failed`, sessionId: session.id },
                    `Failed to place the opening stone for a bot`,
                );
            });
    }

    private finish(sessionId: string, reason: string, winningPlayerId: string | null): void {
        /* Also for a bot with no stream open right now, so nothing is left behind. */
        for (const key of [...this.requestIds.keys(), ...this.answeredRequestIds.keys()]) {
            if (key.endsWith(`::${sessionId}`)) {
                this.requestIds.delete(key);
                this.answeredRequestIds.delete(key);
            }
        }

        for (const [botId, stream] of this.streams) {
            const game = stream.games.get(sessionId);
            if (!game) {
                continue;
            }

            this.forget(botId, stream, sessionId);
            const finishReason = zBotFinishReason.safeParse(reason);
            this.emit(botId, {
                type: `gameFinish`,
                gameId: game.gameId,
                winner: winningPlayerId === null ? null : winningPlayerId === game.seatId ? game.side : opposite(game.side),
                /* `draw-agreement` is unreachable: a game with a bot in it has no draw. */
                reason: finishReason.success ? finishReason.data : `aborted`,
            });
        }
    }

    /**
     * A session can be dropped without ever finishing; `deleteSession` announces only
     * that the lobby is gone, so a bot would otherwise wait on a game nobody is
     * playing. Correct only while `finishSessionLocked` dispatches `gameFinished`
     * while the session is still in the manager's map — the vanish check must never
     * see a finished game as gone, or every ending would read as `aborted`.
     */
    private abortIfVanished(sessionId: string): void {
        if (this.sessionManager.getSession(sessionId)) {
            return;
        }

        this.finish(sessionId, `aborted`, null);
    }

    private forget(botId: string, stream: BotStream, sessionId: string): void {
        stream.games.delete(sessionId);
        stream.lastRequestedCellCount.delete(sessionId);
        stream.originPlacements.delete(sessionId);
        this.requestIds.delete(requestKey(botId, sessionId));
        this.answeredRequestIds.delete(requestKey(botId, sessionId));
    }

    private emit(botId: string, event: BotStreamEvent): void {
        const validated = zBotStreamEvent.safeParse(event);
        if (!validated.success) {
            this.logger.error(
                { event: `bots.stream.invalid`, botId, streamEvent: event.type },
                `Refused to write a stream line that does not match the contract`,
            );
            return;
        }

        this.write(botId, `${JSON.stringify(validated.data)}\n`);
    }

    private write(botId: string, chunk: string): void {
        const stream = this.streams.get(botId);
        if (!stream) {
            return;
        }

        if (stream.connection.writableLength > MAX_BUFFERED_BYTES) {
            /* A bot that never reads is indistinguishable from a gone one. */
            this.logger.warn({ event: `bots.stream.backpressure`, botId }, `Dropping a bot stream that is not being read`);
            stream.connection.destroy();
            return;
        }

        try {
            /* A destroyed socket can throw synchronously; the error listener cleans up. */
            stream.connection.write(chunk);
        } catch (error: unknown) {
            this.logger.warn({ event: `bots.stream.write-failed`, botId, err: error }, `Failed to write to a bot stream`);
            stream.connection.destroy();
        }
    }

    private closeStream(botId: string): void {
        const stream = this.streams.get(botId);
        if (!stream) {
            return;
        }

        this.streams.delete(botId);
        clearInterval(stream.keepalive);
        stream.connection.end();
    }

    /** The `close`/`error` path: the connection is already gone, so only the
     * bookkeeping and the games' virtual socket need releasing. */
    private dropStream(botId: string, stream: BotStream): void {
        this.streams.delete(botId);
        clearInterval(stream.keepalive);
        this.sessionManager.handleSocketDisconnect(this.getSocketId(botId));
    }
}

function requestKey(botId: string, sessionId: string): string {
    return `${botId}::${sessionId}`;
}

function opposite(side: HtttxSide): HtttxSide {
    return side === `x` ? `o` : `x`;
}
