import type { GameState, HexCoordinate } from '@ih3t/shared';
import { getCellKey, isCellWithinPlacementRadius } from '@ih3t/shared';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { ROOT_LOGGER } from '../logger';
import { SessionManager } from '../session/sessionManager';
import type { ServerGameSession, ServerSessionPlayer } from '../session/types';

export type BotDriverType = `engine` | `stream`;

/** How long a bot seat stays in a finished game for whoever is still watching it. */
export const BOT_SEAT_FINISHED_GRACE_MS = 60_000;

/** One bot seat in one running game, as a driver sees it. */
export type BotSeat = {
    sessionId: string;
    gameId: string;
    seatId: string;
    botProfileId: string;
};

/**
 * Who moves for a bot seat. A hook may run inside the session lock that dispatched
 * the event (or from a `replay`), so a driver queues its work and never awaits here;
 * `onTurn` arrives once per turn, with the origin already placed and exactly two stones
 * wanted.
 */
export type BotSeatDriver = {
    readonly type: BotDriverType;
    /** The game is running and this seat is in it: once per game, again after `replay`. */
    onStart(seat: BotSeat, session: ServerGameSession): void;
    onTurn(seat: BotSeat, state: GameState, clock: { expiresInMs: number | null }): void;
    onFinish(seat: BotSeat, reason: string, winningPlayerId: string | null): void;
    /** The human asked for a rematch of a finished game this seat is still in. `true`
     * takes it through the ordinary rematch flow, with the seat carried over; `false`,
     * or no hook, makes the seat leave, so the human is told rather than kept waiting. */
    onRematchRequested?(seat: BotSeat): boolean;
    /** A session left the manager without a finish — a reaped lobby, typically — and
     * anything a driver pinned to its id can go. */
    onSessionRemoved?(sessionId: string): void;
};

/** How far an opening stone may sit from the stones already on the board: a tight
 * cluster, so an opening reads as an opening and not a head start across the board. */
const OPENING_STONE_RADIUS = 2;

type TrackedSeat = {
    seat: BotSeat;
    driver: BotSeatDriver;
    lastRequestedCellCount: number | null;
    originPlaced: boolean;
};

/** A finished game with bot seats still in it, waiting for its humans to go. */
type FinishedWatch = {
    seatIds: string[];
    grace: ReturnType<typeof setTimeout>;
    /** Seats already asked about a rematch; the request is broadcast on every update. */
    rematchAsked: Set<string>;
};

/**
 * The one session subscription for every bot seat: it turns session events into
 * "this seat's turn" and hands that to the seat's driver. Driver-agnostic work —
 * the opening stone, once-per-turn delivery, the finish edge — lives here so an
 * engine and a stream get it the same way.
 */
@injectable()
export class BotSeatManager {
    private readonly logger: Logger;
    private readonly drivers = new Map<BotDriverType, BotSeatDriver>();
    private readonly driverTypes = new Map<string, BotDriverType>();
    /** Keyed `<sessionId>::<seatId>`. */
    private readonly seats = new Map<string, TrackedSeat>();
    /** Sessions whose server-placed opening has started; `done` once the handover is
     * a whole turn again. Keyed by session id. */
    private readonly openings = new Map<string, `running` | `done`>();
    private readonly finishedWatches = new Map<string, FinishedWatch>();
    private unsubscribe: (() => void) | null = null;

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
    ) {
        this.logger = rootLogger.child({ component: `bot-seat-manager` });
    }

    /** Subscribes beside the socket gateway rather than replacing it. */
    attach(): void {
        this.unsubscribe ??= this.sessionManager.addEventHandlers({
            gameStarted: ({ sessionId }) => this.reconcile(sessionId),
            gameStateUpdated: ({ sessionId }) => this.reconcile(sessionId),
            gameCellPlacement: ({ sessionId }) => this.reconcile(sessionId),
            gameFinished: ({ sessionId, reason, winningPlayerId }) => this.finish(sessionId, reason, winningPlayerId),
            sessionUpdated: ({ sessionId }) => this.onFinishedGameUpdated(sessionId),
            rematchCreated: ({ sessionId, socketMapping }) => this.seatRematch(sessionId, socketMapping),
            lobbyRemoved: ({ id }) => this.abortIfVanished(id),
        });
    }

    detach(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.seats.clear();
        this.openings.clear();
        for (const sessionId of [...this.finishedWatches.keys()]) {
            this.clearFinishedWatch(sessionId);
        }
    }

    registerDriver(driver: BotSeatDriver): void {
        this.drivers.set(driver.type, driver);
    }

    /** Marks a bot as driven by `type`; unmarked bots default to the stream. */
    assignDriver(botProfileId: string, type: BotDriverType): void {
        this.driverTypes.set(botProfileId, type);
    }

    getDriverType(botProfileId: string): BotDriverType {
        return this.driverTypes.get(botProfileId) ?? `stream`;
    }

    /**
     * Forgets what a bot was already told and tells it again: every running game as a
     * fresh `onStart`, plus `onTurn` if it is the bot's move. A reconnecting stream
     * needs exactly this.
     */
    replay(botProfileId: string): void {
        for (const participation of this.sessionManager.getPlayerParticipationsByProfileId(botProfileId)) {
            if (participation.role !== `player` || participation.session.state !== `in-game`) {
                continue;
            }

            this.seats.delete(seatKey(participation.session.id, participation.participant.id));
            this.reconcile(participation.session.id);
        }
    }

    reconcile(sessionId: string): void {
        const session = this.sessionManager.getSession(sessionId);
        if (!session || session.state !== `in-game` || !session.gameId) {
            return;
        }

        if (this.maybeStartOpening(session)) {
            /* The opening owns the board until it is laid: no seat is told anything
             * about a position that is still being placed. */
            return;
        }

        for (const player of session.players) {
            if (!player.isBot || !player.profileId) {
                continue;
            }

            const driver = this.drivers.get(this.getDriverType(player.profileId));
            if (!driver) {
                /* Nothing registered for this kind of bot: the seat waits, and the clock decides. */
                continue;
            }

            this.reconcileSeat(session, player, driver);
        }
    }

    private reconcileSeat(session: ServerGameSession, player: ServerSessionPlayer, driver: BotSeatDriver): void {
        const key = seatKey(session.id, player.id);
        let tracked = this.seats.get(key);
        if (!tracked) {
            tracked = {
                seat: { sessionId: session.id, gameId: session.gameId, seatId: player.id, botProfileId: player.profileId ?? `` },
                driver,
                lastRequestedCellCount: null,
                originPlaced: false,
            };
            this.seats.set(key, tracked);
            driver.onStart(tracked.seat, session);
        }

        const snapshot = this.sessionManager.getSessionSnapshot(session.id);
        if (!snapshot) {
            return;
        }

        const { gameState } = snapshot;
        if (gameState.winner) {
            /* A winning second stone still completes the turn, and the state is emitted
             * before the session is marked finished: without this, the loser would be
             * asked to move in a game that is already over. */
            return;
        }

        const isOurTurn = gameState.currentTurnPlayerId === player.id;
        if (isOurTurn && gameState.cells.length === 0 && gameState.placementsRemaining === 1) {
            this.placeOrigin(tracked, session);
            return;
        }

        if (!isOurTurn || gameState.placementsRemaining !== 2) {
            return;
        }

        if (tracked.lastRequestedCellCount === gameState.cells.length) {
            return;
        }

        tracked.lastRequestedCellCount = gameState.cells.length;
        driver.onTurn(tracked.seat, gameState, { expiresInMs: gameState.currentTurnExpiresInMs });
    }

    /**
     * The opening stone is placed for the bot, so every turn it sees wants exactly two
     * placements, as the engines and htttx assume (D6). There is no server-side
     * `autoPlaceOriginTile` to reuse: that preference is acted on by the browser.
     */
    private placeOrigin(tracked: TrackedSeat, session: ServerGameSession): void {
        if (tracked.originPlaced) {
            return;
        }

        tracked.originPlaced = true;
        /* Queued, not awaited: this runs inside the session lock the event came from. */
        void this.sessionManager.placeCell(session, tracked.seat.seatId, { x: 0, y: 0 })
            .catch((error: unknown) => {
                tracked.originPlaced = false;
                this.logger.warn(
                    { err: error, event: `bots.origin.failed`, sessionId: session.id },
                    `Failed to place the opening stone for a bot`,
                );
            });
    }

    /** The opening starts the moment the first turn is complete — the origin stone
     * exists and a full turn is owed — whoever placed that origin, bot or human. */
    private maybeStartOpening(session: ServerGameSession): boolean {
        if (session.openingRandomTurns <= 0 || this.openings.has(session.id)) {
            return this.openings.get(session.id) === `running`;
        }

        const snapshot = this.sessionManager.getSessionSnapshot(session.id);
        if (!snapshot) {
            return false;
        }

        const firstTurnComplete = snapshot.gameState.cells.length === 1
            && snapshot.gameState.placementsRemaining === 2;
        if (!firstTurnComplete) {
            return false;
        }

        /* Marked synchronously: reconcile runs from inside the session lock, and the
         * placement's own cell events re-enter reconcile before the stones exist. */
        this.openings.set(session.id, `running`);
        void this.placeOpening(session)
            .catch((error: unknown) => {
                this.logger.warn({ err: error, event: `bots.opening.failed`, sessionId: session.id }, `Failed to place an opening`);
            })
            .finally(() => {
                /* Whatever stopped the placement, the game goes on from wherever it
                 * got to: the owed turn is delivered like any other — unless the game
                 * ended meanwhile. `finish` has already cleared the entry, and a
                 * rematch (the same session id) deserves a fresh opening, so it is
                 * never resurrected here. */
                if (this.openings.get(session.id) === `running`) {
                    this.openings.set(session.id, `done`);
                }

                this.reconcile(session.id);
            });
        return true;
    }

    /** Lays the opening turn by turn through the ordinary rules and locks, so the
     * history, the clocks and every board see the same game. */
    private async placeOpening(session: ServerGameSession): Promise<void> {
        for (let turn = 0; turn < session.openingRandomTurns; turn += 1) {
            const snapshot = this.sessionManager.getSessionSnapshot(session.id);
            if (!snapshot || snapshot.gameState.winner || session.state !== `in-game`) {
                return;
            }

            const { gameState } = snapshot;

            /* A human whose turn this is may still click while their opening stones
             * are being placed; the lock serializes it, and the loop simply stops on
             * the first refusal — legal and self-healing. */
            const cells = randomOpeningTurn(gameState);
            await this.sessionManager.placeCells(session, gameState.currentTurnPlayerId!, cells);
        }
    }

    private finish(sessionId: string, reason: string, winningPlayerId: string | null): void {
        this.openings.delete(sessionId);
        for (const [key, tracked] of this.seats) {
            if (tracked.seat.sessionId !== sessionId) {
                continue;
            }

            this.seats.delete(key);
            tracked.driver.onFinish(tracked.seat, reason, winningPlayerId);
        }

        this.watchFinishedGame(sessionId);
    }

    /**
     * A bot's virtual socket never disconnects on its own, and a finished session is
     * only reaped once no player is connected: the seats leave, as a human who closed
     * the tab would, or every game against a bot stays in memory forever. Not at once,
     * though — the human still on the result screen keeps the rematch open, and a
     * spectator keeps the board — but as soon as no human is connected, or after the
     * grace, whichever comes first. The reaper stays the backstop.
     */
    private watchFinishedGame(sessionId: string): void {
        const session = this.sessionManager.getSession(sessionId);
        const seatIds = session?.state === `finished`
            ? session.players.filter((player) => player.isBot).map((player) => player.id)
            : [];
        if (seatIds.length === 0) {
            return;
        }

        this.clearFinishedWatch(sessionId);
        this.finishedWatches.set(sessionId, {
            seatIds,
            grace: setTimeout(() => this.leaveFinishedGame(sessionId), BOT_SEAT_FINISHED_GRACE_MS),
            rematchAsked: new Set(),
        });
        this.onFinishedGameUpdated(sessionId);
    }

    private onFinishedGameUpdated(sessionId: string): void {
        const watch = this.finishedWatches.get(sessionId);
        if (!watch) {
            return;
        }

        const session = this.sessionManager.getSession(sessionId);
        if (!session || session.state !== `finished`) {
            this.clearFinishedWatch(sessionId);
            return;
        }

        const humanConnected = session.players.some((player) => !player.isBot && player.connection.status !== `disconnected`)
            || session.spectators.some((spectator) => spectator.socketId !== null);
        if (!humanConnected) {
            this.leaveFinishedGame(sessionId);
            return;
        }

        this.offerRematch(session, watch);
    }

    /**
     * `rematchAcceptedPlayerIds` names whoever has asked; a bot seat not yet in it is
     * put to its driver once. Accepting runs the same two steps a second human's click
     * would, and `rematchCreated` then seats the bot in the new session.
     */
    private offerRematch(session: ServerGameSession, watch: FinishedWatch): void {
        if (session.rematchAcceptedPlayerIds.length === 0) {
            return;
        }

        for (const seatId of watch.seatIds) {
            const player = session.players.find((candidate) => candidate.id === seatId);
            if (!player || player.connection.status === `disconnected` || session.rematchAcceptedPlayerIds.includes(seatId) || watch.rematchAsked.has(seatId)) {
                continue;
            }

            watch.rematchAsked.add(seatId);
            const seat: BotSeat = { sessionId: session.id, gameId: session.gameId, seatId, botProfileId: player.profileId ?? `` };
            const driver = this.drivers.get(this.getDriverType(seat.botProfileId));
            /* Queued either way: this runs inside the lock the request was made under. */
            if (driver?.onRematchRequested?.(seat)) {
                void this.acceptRematch(session, seat).catch((error: unknown) => {
                    this.logger.warn({ err: error, event: `bots.rematch.failed`, sessionId: session.id }, `Bot seat could not take the rematch`);
                });
            } else {
                void this.sessionManager.leaveSession(session, seatId, `leave-session`).catch((error: unknown) => {
                    this.logger.warn({ err: error, event: `bots.seat.leave.failed`, sessionId: session.id }, `Bot seat could not decline the rematch`);
                });
            }
        }
    }

    private async acceptRematch(session: ServerGameSession, seat: BotSeat): Promise<void> {
        const request = await this.sessionManager.requestRematch(session, seat.seatId);
        if (request.status !== `ready`) {
            return;
        }

        await this.sessionManager.createRematchSession(session.id);
    }

    /** The new session's bot seats get their virtual sockets back, as the gateway does for the humans. */
    private seatRematch(sessionId: string, socketMapping: Record<string, string>): void {
        this.clearFinishedWatch(sessionId);
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
            return;
        }

        for (const player of session.players) {
            const socketId = socketMapping[player.id];
            if (!player.isBot || !socketId) {
                continue;
            }

            this.sessionManager.assignParticipantSocket(session, player.id, socketId);
        }
    }

    private leaveFinishedGame(sessionId: string): void {
        const watch = this.finishedWatches.get(sessionId);
        this.clearFinishedWatch(sessionId);
        const session = this.sessionManager.getSession(sessionId);
        if (!watch || !session || session.state !== `finished`) {
            return;
        }

        for (const seatId of watch.seatIds) {
            const player = session.players.find((candidate) => candidate.id === seatId);
            if (!player || player.connection.status === `disconnected`) {
                continue;
            }

            /* Queued: this may run inside the session lock an event came from. */
            void this.sessionManager.leaveSession(session, seatId, `leave-session`)
                .catch((error: unknown) => {
                    this.logger.warn({ err: error, event: `bots.seat.leave.failed`, sessionId }, `Bot seat could not leave a finished game`);
                });
        }
    }

    private clearFinishedWatch(sessionId: string): void {
        const watch = this.finishedWatches.get(sessionId);
        if (!watch) {
            return;
        }

        clearTimeout(watch.grace);
        this.finishedWatches.delete(sessionId);
    }

    /**
     * A session can be dropped without ever finishing; `deleteSession` announces only
     * that the lobby is gone, so a driver would otherwise wait on a game nobody is
     * playing. Correct only while `finishSessionLocked` dispatches `gameFinished`
     * while the session is still in the manager's map — the vanish check must never
     * see a finished game as gone, or every ending would read as `aborted`.
     */
    private abortIfVanished(sessionId: string): void {
        if (this.sessionManager.getSession(sessionId)) {
            return;
        }

        this.finish(sessionId, `aborted`, null);
        this.clearFinishedWatch(sessionId);
        for (const driver of this.drivers.values()) {
            driver.onSessionRemoved?.(sessionId);
        }
    }
}

function seatKey(sessionId: string, seatId: string): string {
    return `${sessionId}::${seatId}`;
}

/** Two distinct unoccupied cells within the opening radius, chosen uniformly; the
 * turn's player is whoever the rules say owes it, alternating with each turn. */
function randomOpeningTurn(gameState: GameState): [HexCoordinate, HexCoordinate] {
    const occupied = new Set(gameState.cells.map((cell) => getCellKey(cell.x, cell.y)));
    const candidates: HexCoordinate[] = [];
    for (const stone of gameState.cells) {
        for (let dx = -OPENING_STONE_RADIUS; dx <= OPENING_STONE_RADIUS; dx += 1) {
            for (let dy = -OPENING_STONE_RADIUS; dy <= OPENING_STONE_RADIUS; dy += 1) {
                const candidate = { x: stone.x + dx, y: stone.y + dy };
                if (occupied.has(getCellKey(candidate.x, candidate.y))
                    || !isCellWithinPlacementRadius(gameState.cells, candidate, OPENING_STONE_RADIUS)) {
                    continue;
                }

                candidates.push(candidate);
                occupied.add(getCellKey(candidate.x, candidate.y));
            }
        }
    }

    if (candidates.length < 2) {
        /* Unreachable on a real board (the radius-2 ring alone has 18 cells); the
         * widening keeps the invariant "an opening is always a whole turn". */
        for (const cell of gameState.cells.flatMap((stone) => neighborsWithin(gameState, stone, 8))) {
            if (!occupied.has(getCellKey(cell.x, cell.y))) {
                occupied.add(getCellKey(cell.x, cell.y));
                candidates.push(cell);
            }
        }
    }

    if (candidates.length < 2) {
        /* Still nowhere to place: hand the turn back rather than place a non-turn;
         * the caller stops the opening and the game continues from here. */
        throw new Error(`no legal cells for an opening turn`);
    }

    const first = candidates[Math.floor(Math.random() * candidates.length)]!;
    const second = candidates.filter((cell) => cell !== first)[Math.floor(Math.random() * (candidates.length - 1))]!;
    return [first, second];
}

function neighborsWithin(gameState: GameState, stone: HexCoordinate, radius: number): HexCoordinate[] {
    const cells: HexCoordinate[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
            const candidate = { x: stone.x + dx, y: stone.y + dy };
            if (isCellWithinPlacementRadius(gameState.cells, candidate, radius)) {
                cells.push(candidate);
            }
        }
    }

    return cells;
}
