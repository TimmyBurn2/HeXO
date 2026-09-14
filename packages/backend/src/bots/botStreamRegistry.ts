import {
    type BotStreamEvent,
    type HtttxSide,
    zBotFinishReason,
    zBotStreamEvent,
} from '@ih3t/shared';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import type { GameState } from '@ih3t/shared';

import type { AccountUserProfile } from '../auth/authRepository';
import { ROOT_LOGGER } from '../logger';
import { SessionManager } from '../session/sessionManager';
import type { ServerGameSession } from '../session/types';
import { BotPlayerMapper } from './botPlayerMapper';
import { type BotSeat, type BotSeatDriver, BotSeatManager } from './botSeatManager';
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
};

/**
 * One NDJSON stream per bot, and the bot's presence: while it is held the bot is
 * online, and dropping it orphans every game at once, because a bot has a single
 * virtual socket id for all of them. Mirrors how `devSupportService` gives its
 * server-side players `dev-bot:` socket ids. As the seat manager's stream driver it
 * only ever answers "your turn" with a `moveRequest`; whose turn it is, the opening
 * stone and once-per-turn delivery are the manager's.
 */
@injectable()
export class BotStreamRegistry implements BotSeatDriver {
    readonly type = `stream` as const;
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

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotPlayerMapper) private readonly botPlayerMapper: BotPlayerMapper,
        @inject(BotSeatManager) private readonly botSeatManager: BotSeatManager,
    ) {
        this.logger = rootLogger.child({ component: `bot-stream-registry` });
    }

    /** Registers as the manager's stream driver; the manager subscribes beside the socket gateway. */
    attach(): void {
        this.botSeatManager.registerDriver(this);
        this.botSeatManager.attach();
    }

    detach(): void {
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

    /** True while the bot holds a stream opened with `open=1`; it resets when the
     * stream dies, because the flag lives on the stream entry. */
    isOpenForChallenges(botId: string): boolean {
        return this.streams.get(botId)?.openForChallenges ?? false;
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
            openForChallenges,
            keepalive: setInterval(() => this.write(bot.id, `\n`), KEEPALIVE_INTERVAL_MS),
            games: new Map(),
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
        }

        /* The manager forgets what this bot was told and tells it again, in order. */
        this.botSeatManager.replay(botId);
    }

    onStart(seat: BotSeat, session: ServerGameSession): void {
        const stream = this.streams.get(seat.botProfileId);
        const snapshot = this.sessionManager.getSessionSnapshot(session.id);
        if (!stream || !snapshot || stream.games.has(session.id)) {
            /* Offline: the stream's next open replays this start. */
            return;
        }

        const side = sideOf(snapshot.gameState, seat.seatId);
        stream.games.set(session.id, { gameId: seat.gameId, seatId: seat.seatId, side });
        this.emit(seat.botProfileId, {
            type: `gameStart`,
            gameId: seat.gameId,
            side,
            opponent: this.botPlayerMapper.fromSeat(session.players.find((player) => player.id !== seat.seatId)),
            timeControl: session.gameOptions.timeControl,
            rated: session.isRatedGame,
        });
    }

    onTurn(seat: BotSeat, state: GameState, clock: { expiresInMs: number | null }): void {
        if (!this.streams.has(seat.botProfileId)) {
            return;
        }

        const key = requestKey(seat.botProfileId, seat.sessionId);
        const requestId = (this.requestIds.get(key) ?? 0) + 1;
        this.requestIds.set(key, requestId);
        this.emit(seat.botProfileId, {
            type: `moveRequest`,
            gameId: seat.gameId,
            request: toMoveRequest(state, clock.expiresInMs, requestId),
        });
    }

    onFinish(seat: BotSeat, reason: string, winningPlayerId: string | null): void {
        /* Also for a bot with no stream open right now, so nothing is left behind. */
        this.requestIds.delete(requestKey(seat.botProfileId, seat.sessionId));
        this.answeredRequestIds.delete(requestKey(seat.botProfileId, seat.sessionId));

        const stream = this.streams.get(seat.botProfileId);
        const game = stream?.games.get(seat.sessionId);
        if (!stream || !game) {
            return;
        }

        this.forget(seat.botProfileId, stream, seat.sessionId);
        const finishReason = zBotFinishReason.safeParse(reason);
        this.emit(seat.botProfileId, {
            type: `gameFinish`,
            gameId: game.gameId,
            winner: winningPlayerId === null ? null : winningPlayerId === game.seatId ? game.side : opposite(game.side),
            /* `draw-agreement` is unreachable: a game with a bot in it has no draw. */
            reason: finishReason.success ? finishReason.data : `aborted`,
        });
    }

    onSessionRemoved(sessionId: string): void {
        for (const key of [...this.requestIds.keys(), ...this.answeredRequestIds.keys()]) {
            if (key.endsWith(`::${sessionId}`)) {
                this.requestIds.delete(key);
                this.answeredRequestIds.delete(key);
            }
        }
    }

    private forget(botId: string, stream: BotStream, sessionId: string): void {
        stream.games.delete(sessionId);
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
