import { randomBytes } from 'node:crypto';

import {
    type BotAccepts,
    type BotChallenge,
    type BotChallengeEvent,
    type BotChallengeFirstPlayer,
    formatThinkSeconds,
    type GameTimeControl,
    type LobbyFirstPlayer,
    type OwnerBotChallenge,
} from '@ih3t/shared';
import { Mutex } from 'async-mutex';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile, AuthRepository } from '../auth/authRepository';
import { ServerConfig } from '../config/serverConfig';
import { ROOT_LOGGER } from '../logger';
import type { RequestClientInfo } from '../network/clientInfo';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { SessionManager } from '../session/sessionManager';
import type { ServerGameSession } from '../session/types';
import { BotAccountRepository } from './botAccountRepository';
import { MAX_CONCURRENT_GAMES_PER_BOT } from './botAccountService';
import { BotPlayerMapper } from './botPlayerMapper';
import { seatBotInLobby, serverDrivenBotPresence, underBotSeatGate } from './botSeatGate';
import { BotSeatManager } from './botSeatManager';
import { BotStreamRegistry } from './botStreamRegistry';
import { EngineDriver, type EngineSeatConfig } from './drivers/engineDriver';

/** A rejection a bot can act on, carrying one of the contract's challenge codes. */
export class BotChallengeError extends ApiRequestError {
    constructor(message: string, readonly code: `not-a-bot` | `not-open` | null = null) {
        super(400, message);
        this.name = `BotChallengeError`;
    }
}

/** Pending only on the wire; the other three are the states an event carried. */
type ChallengeStatus = `pending` | `accepted` | `declined` | `expired`;

type ChallengeEntry = {
    challengeId: string;
    challengerProfileId: string;
    challengedProfileId: string;
    session: ServerGameSession;
    createdAt: number;
    expiresAt: number;
    status: ChallengeStatus;
    /* The wire shape, built once: the terminal events fire from synchronous session
     * callbacks, which cannot await repository reads for a fresh view. */
    view: BotChallenge;
};

export type CreateChallengeOptions = {
    timeControl: BotChallenge[`timeControl`];
    firstPlayer: BotChallengeFirstPlayer;
    /** Required when the target is server-driven: its thinking time per move. */
    thinkMs?: number;
};

const SWEEP_INTERVAL_MS = 5_000;

/**
 * A challenge is a private reserved-lobby session plus the state the wire needs; the
 * map is the only home of that state, because every reader asks "pending for bot X"
 * and the target holds no seat while the challenge is pending. All terminal paths but
 * expiry funnel through `lobbyRemoved`: cancel and a dropped challenger stream delete
 * the lobby, and the handler retracts the target's line. Expiry marks first so the
 * handler stays silent, then deletes and notifies both sides.
 */
@injectable()
export class ChallengeService {
    private readonly logger: Logger;
    private readonly challenges = new Map<string, ChallengeEntry>();
    /** Creates racing each other must not both pass the pair and cap checks. */
    private readonly createMutex = new Mutex();
    /** Serializes every challenge-state transition. The claim of a seat, the delete
     * of a lobby and the expiry sweep all check-and-set entry state under this one
     * mutex, so an accept can never be interleaved with the very cancel or expiry it
     * raced — whoever transitions first wins, the other side sees a plain 400.
     * Ordering is one-way (this mutex, then a session lock) so it cannot deadlock. */
    private readonly transitionMutex = new Mutex();
    private unsubscribe: (() => void) | null = null;
    private sweepInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(ServerConfig) private readonly serverConfig: ServerConfig,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotStreamRegistry) private readonly botStreamRegistry: BotStreamRegistry,
        @inject(AuthRepository) private readonly authRepository: AuthRepository,
        @inject(BotPlayerMapper) private readonly botPlayerMapper: BotPlayerMapper,
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(BotSeatManager) private readonly botSeatManager: BotSeatManager,
        @inject(EngineDriver) private readonly engineDriver: EngineDriver,
    ) {
        this.logger = rootLogger.child({ component: `challenge-service` });
    }

    /** Subscribes beside the other session watchers; only meaningful under the flag. */
    attach(): void {
        this.unsubscribe ??= this.sessionManager.addEventHandlers({
            gameStarted: ({ sessionId }) => this.consume(sessionId),
            lobbyRemoved: ({ id }) => this.onLobbyRemoved(id),
        });

        this.sweepInterval ??= setInterval(() => {
            void this.sweep().catch((error: unknown) => {
                /* An unhandled rejection here would take the process down. */
                this.logger.warn({ err: error, event: `challenge.sweep.failed` }, `Challenge sweep failed`);
            });
        }, SWEEP_INTERVAL_MS);
        this.sweepInterval.unref?.();
    }

    detach(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;

        if (this.sweepInterval) {
            clearInterval(this.sweepInterval);
            this.sweepInterval = null;
        }
    }

    async createChallenge(
        challenger: AccountUserProfile,
        challengedProfileId: string,
        client: RequestClientInfo,
        options: CreateChallengeOptions,
    ): Promise<BotChallenge> {
        return await this.createMutex.runExclusive(() => this.createEntry(challenger, challengedProfileId, client, options))
            .then((entry) => entry.view);
    }

    async acceptChallenge(bot: AccountUserProfile, challengeId: string): Promise<void> {
        await this.transitionMutex.runExclusive(() => this.acceptLocked(bot, challengeId));
    }

    private async acceptLocked(bot: AccountUserProfile, challengeId: string): Promise<void> {
        const entry = this.requirePending(challengeId, `That challenge has already been answered.`);
        if (entry.challengedProfileId !== bot.id) {
            /* Not this bot's to answer; the id is not confirmed to exist, either. */
            throw new ApiRequestError(404, `That challenge does not exist.`);
        }

        const session = this.sessionManager.getSession(entry.session.id);
        if (!session || session.state !== `lobby`) {
            throw new ApiRequestError(400, `That challenge no longer has a lobby.`);
        }

        const challengerSeat = session.players.find((player) => player.profileId === entry.challengerProfileId);
        if (!challengerSeat || challengerSeat.connection.status !== `connected`) {
            /* The challenger vanished before its own lobby's sweep noticed: cancel now
             * rather than seat a game that can never start. */
            await this.cancelPendingLocked(entry);
            throw new ApiRequestError(400, `The challenger is no longer connected.`);
        }

        await underBotSeatGate(() => seatBotInLobby(
            { sessionManager: this.sessionManager, presence: this.botStreamRegistry },
            session,
            bot,
            (botProfileId) => this.sessionManager.countActivePlayerSessionsByProfileId(botProfileId),
            {
                offline: () => new BotChallengeError(`Hold your stream open to accept a challenge.`, `not-open`),
                capReached: () => new BotChallengeError(`A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`, `not-open`),
                seatLost: () => new ApiRequestError(400, `That challenge no longer has a seat.`),
            },
        ));

        /* Nothing can have transitioned this entry while we held the mutex, but a
         * lobby sweep may still have deleted the session under the seat claim. */
        if (this.challenges.get(challengeId) !== entry) {
            throw new ApiRequestError(400, `That challenge no longer exists.`);
        }

        entry.status = `accepted`;
        /* Both seats are connected now; the existing sweep starts the game and the
         * registry replays it onto both streams as gameStart (plus a first
         * moveRequest for whoever opens). */
    }

    async declineChallenge(bot: AccountUserProfile, challengeId: string): Promise<void> {
        await this.transitionMutex.runExclusive(() => this.declineLocked(bot, challengeId));
    }

    private async declineLocked(bot: AccountUserProfile, challengeId: string): Promise<void> {
        const entry = this.requirePending(challengeId, `That challenge has already been answered.`);
        if (entry.challengedProfileId !== bot.id) {
            throw new ApiRequestError(404, `That challenge does not exist.`);
        }

        entry.status = `declined`;
        entry.view.status = `declined`;
        this.emitTo(entry.challengerProfileId, { type: `challengeDeclined`, challenge: entry.view });
        await this.sessionManager.deleteLobby(entry.session, `challenge-declined`);
    }

    async cancelChallenge(bot: AccountUserProfile, challengeId: string): Promise<void> {
        await this.transitionMutex.runExclusive(async () => {
            const entry = this.requirePending(challengeId, `That challenge has already been answered.`);
            if (entry.challengerProfileId !== bot.id) {
                throw new ApiRequestError(404, `That challenge does not exist.`);
            }

            await this.cancelPendingLocked(entry);
        });
    }

    listChallenges(bot: AccountUserProfile): BotChallenge[] {
        return this.pendingEntries()
            .filter((entry) => entry.challengerProfileId === bot.id || entry.challengedProfileId === bot.id)
            .map((entry) => entry.view);
    }

    /** Replayed on every stream open, `open=1` or not: openness gates new challenges,
     * not the answering of ones the target already holds. */
    replayPending(bot: AccountUserProfile): void {
        for (const entry of this.pendingEntries()) {
            if (entry.challengedProfileId === bot.id) {
                this.emitTo(bot.id, { type: `challenge`, challenge: entry.view });
            }
        }
    }

    /* --- the owner path: cookie auth, the same service, ownership checked --- */

    async createChallengeAsOwner(
        owner: AccountUserProfile,
        challengedProfileId: string,
        client: RequestClientInfo,
        options: CreateChallengeOptions & { challengerBotProfileId: string },
    ): Promise<OwnerBotChallenge> {
        const challenger = await this.requireOwnedBot(owner, options.challengerBotProfileId);
        const entry = await this.createMutex.runExclusive(() =>
            this.createEntry(challenger, challengedProfileId, client, options));

        return { ...entry.view, sessionId: entry.session.id };
    }

    async listChallengesAsOwner(owner: AccountUserProfile, challengedProfileId: string): Promise<OwnerBotChallenge[]> {
        const owned = new Set((await this.botAccountRepository.listByOwner(owner.id)).map((account) => account.id));
        return this.pendingEntries()
            .filter((entry) =>
                entry.challengedProfileId === challengedProfileId
                && owned.has(entry.challengerProfileId))
            .map((entry) => ({ ...entry.view, sessionId: entry.session.id }));
    }

    async cancelChallengeAsOwner(
        owner: AccountUserProfile,
        challengedProfileId: string,
        challengeId: string,
    ): Promise<void> {
        await this.transitionMutex.runExclusive(async () => {
            const entry = this.requirePending(challengeId, `That challenge has already been answered.`);
            if (entry.challengedProfileId !== challengedProfileId) {
                throw new ApiRequestError(404, `No such challenge for that bot.`);
            }

            const account = await this.botAccountRepository.findById(entry.challengerProfileId);
            if (!account || account.ownerProfileId !== owner.id) {
                throw new ApiRequestError(404, `No such challenge for that bot.`);
            }

            await this.cancelPendingLocked(entry);
        });
    }

    /* --- internals --- */

    /** The engine-driver answer for a server-driven target (D12): `thinkMs` is
     * required, out of range is a plain 400, out of capacity is `not-open`, and the
     * returned config is what the challenge plays at. */
    private challengeEngineTarget(
        target: AccountUserProfile,
        targetName: string,
        options: CreateChallengeOptions,
    ): EngineSeatConfig {
        if (options.thinkMs === undefined) {
            throw new ApiRequestError(400, `A challenge to ${targetName} needs a thinkMs, its thinking time per move.`);
        }

        const seat = this.engineDriver.onChallenge(target.id, options.thinkMs);
        if (!seat) {
            throw new BotChallengeError(`${targetName} is busy in too many games right now.`, `not-open`);
        }

        return seat;
    }

    private async createEntry(
        challenger: AccountUserProfile,
        challengedProfileId: string,
        client: RequestClientInfo,
        options: CreateChallengeOptions,
    ): Promise<ChallengeEntry> {
        const target = await this.authRepository.getUserProfileById(challengedProfileId);
        if (!target) {
            throw new ApiRequestError(404, `That account does not exist.`);
        }

        if (target.kind !== `bot`) {
            throw new BotChallengeError(`Challenges target bots; that account is a human.`, `not-a-bot`);
        }

        const targetAccount = await this.botAccountRepository.findById(target.id);
        if (!targetAccount) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

        if (target.id === challenger.id) {
            throw new ApiRequestError(400, `A bot cannot challenge itself.`);
        }

        /* A server-driven target has no stream to answer on; its driver answers for
         * it (D12), at the requested strength, while the engine pool has capacity. */
        const engineSeat = this.botSeatManager.getDriverType(target.id) === `engine`
            ? this.challengeEngineTarget(target, targetAccount.username, options)
            : null;

        if (!engineSeat) {
            if (!this.botStreamRegistry.isOpenForChallenges(target.id)) {
                throw new BotChallengeError(`That bot is not taking challenges right now.`, `not-open`);
            }

            /* The bot's own declaration narrows `open=1`: a clock it did not say it
             * accepts is refused exactly like a closed stream (spec 0.4, DRIFT #21). */
            if (targetAccount.declaration?.accepts
                && !acceptsTimeControl(targetAccount.declaration.accepts, options.timeControl)) {
                throw new BotChallengeError(`That bot does not take games with that clock.`, `not-open`);
            }

            if (this.sessionManager.countActivePlayerSessionsByProfileId(target.id) >= MAX_CONCURRENT_GAMES_PER_BOT) {
                throw new BotChallengeError(`A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`, `not-open`);
            }
        }

        if (this.pendingEntries().some((entry) =>
            entry.challengerProfileId === challenger.id && entry.challengedProfileId === target.id)) {
            throw new ApiRequestError(400, `A challenge between those bots is already pending.`);
        }

        const challengeId = this.createChallengeId();
        const response = this.sessionManager.createSession({
            client,
            lobbyOptions: {
                visibility: `private`,
                timeControl: options.timeControl,
                /* Every game with a bot seat is unrated; SessionManager re-asserts it. */
                rated: false,
                firstPlayer: toLobbyFirstPlayer(options.firstPlayer),
            },
            reservedPlayerProfileIds: [challenger.id, target.id],
            pendingChallengeId: challengeId,
        });

        const session = this.sessionManager.requireSession(response.sessionId);
        await underBotSeatGate(() => seatBotInLobby(
            { sessionManager: this.sessionManager, presence: this.botStreamRegistry },
            session,
            challenger,
            (botProfileId) => this.sessionManager.countActivePlayerSessionsByProfileId(botProfileId),
            {
                offline: () => new ApiRequestError(400, `The challenger is not connected right now.`),
                capReached: () => new ApiRequestError(400, `A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`),
                seatLost: () => new ApiRequestError(400, `The challenger could not claim its seat.`),
            },
        ));

        if (engineSeat) {
            /* The target's driver already said yes: the seat is claimed here and the
             * game starts on the sweep like an accepted challenge would. */
            this.engineDriver.configureSeat(session.id, engineSeat);
            try {
                await underBotSeatGate(() => seatBotInLobby(
                    { sessionManager: this.sessionManager, presence: serverDrivenBotPresence },
                    session,
                    target,
                    () => this.engineDriver.countActiveGames(),
                    {
                        offline: () => new BotChallengeError(`That bot is not taking challenges right now.`, `not-open`),
                        capReached: () => new BotChallengeError(`${targetAccount.username} is busy right now.`, `not-open`),
                        seatLost: () => new ApiRequestError(400, `That challenge no longer has a seat.`),
                    },
                    {
                        maxGames: this.serverConfig.houseBotMaxGames,
                        displayName: `${targetAccount.username} ${formatThinkSeconds(engineSeat.thinkMs)}`,
                    },
                ));
            } catch (error: unknown) {
                /* The lobby empties itself through the sweep; the pin goes with it. */
                this.engineDriver.releaseSeat(session.id);
                throw error;
            }
        }

        const now = Date.now();
        const entry: ChallengeEntry = {
            challengeId,
            challengerProfileId: challenger.id,
            challengedProfileId: target.id,
            session,
            createdAt: now,
            expiresAt: now + this.serverConfig.challengeTtlMs,
            status: `pending`,
            view: {
                challengeId,
                challenger: await this.botPlayerMapper.fromProfile(challenger),
                destUser: await this.botPlayerMapper.fromProfile(target),
                timeControl: { ...options.timeControl },
                status: `created`,
            },
        };
        this.challenges.set(challengeId, entry);
        if (engineSeat) {
            /* Nothing will call accept for a target with no stream: mark it here, so
             * a lobby that vanishes before the sweep notifies the challenger. */
            entry.status = `accepted`;
        }

        this.emitTo(target.id, { type: `challenge`, challenge: entry.view });

        /* The evictions transition other entries, so they take the transition mutex
         * one at a time; createMutex stays the outer lock, and the ordering is one-way. */
        await this.enforceInboxLimit(target.id, challengeId);

        this.logger.info(
            { event: `challenge.created`, challengeId, challengerProfileId: challenger.id, challengedProfileId: target.id },
            `Challenge created`,
        );
        return entry;
    }

    /** One pending outgoing challenge per pair, and an inbox bounded by the oldest
     * expiring first: the cap is per target, so a flood cannot wedge one challenger. */
    private async enforceInboxLimit(challengedProfileId: string, exceptChallengeId: string): Promise<void> {
        const incoming = this.pendingEntries()
            .filter((entry) => entry.challengedProfileId === challengedProfileId && entry.challengeId !== exceptChallengeId)
            .sort((left, right) => left.createdAt - right.createdAt);

        const overflow = incoming.length + 1 - this.serverConfig.challengeInboxLimit;
        for (const entry of incoming.slice(0, Math.max(0, overflow))) {
            await this.transitionMutex.runExclusive(() => this.expireLocked(entry));
        }
    }

    private requirePending(challengeId: string, answeredMessage: string): ChallengeEntry {
        const entry = this.challenges.get(challengeId);
        if (!entry) {
            throw new ApiRequestError(404, `That challenge does not exist.`);
        }

        if (entry.status !== `pending`) {
            throw new ApiRequestError(400, answeredMessage);
        }

        return entry;
    }

    /** Withdraws a pending challenge: the lobby goes first, and `lobbyRemoved` is
     * what retracts the target's `challenge` line and drops the entry. Transition
     * mutex held. */
    private async cancelPendingLocked(entry: ChallengeEntry): Promise<void> {
        await this.sessionManager.deleteLobby(entry.session, `challenge-canceled`);
    }

    /** Transition mutex held. Marks first, so the `lobbyRemoved` handler stays
     * silent, then deletes and notifies both sides. Re-checks pending, because the
     * sweep collects candidates before it takes the mutex. */
    private async expireLocked(entry: ChallengeEntry): Promise<void> {
        if (entry.status !== `pending`) {
            /* Answered between collection and this transition — the challenge lives. */
            return;
        }

        entry.status = `expired`;
        entry.view.status = `expired`;

        const deleted = await this.sessionManager.deleteLobby(entry.session, `challenge-expired`);
        if (deleted) {
            /* The handler saw status `expired` and stayed silent; both sides learn
             * without polling — the target retracts a line, the challenger its offer. */
            this.emitTo(entry.challengedProfileId, { type: `challengeCanceled`, challenge: entry.view, reason: `expired` });
            this.emitTo(entry.challengerProfileId, { type: `challengeCanceled`, challenge: entry.view, reason: `expired` });
        }
        /* Not deleted: an accept won the lock and the game started — the challenge
         * was answered after all, and consume() drops the entry on gameStarted. */
    }

    private async sweep(): Promise<void> {
        const now = Date.now();
        for (const entry of this.pendingEntries()) {
            if (entry.expiresAt <= now) {
                await this.transitionMutex.runExclusive(() => this.expireLocked(entry));
            }
        }
    }

    private consume(sessionId: string): void {
        const entry = this.findBySession(sessionId);
        if (entry) {
            this.challenges.delete(entry.challengeId);
        }
    }

    /** The single funnel for a challenge whose lobby vanished under it. */
    private onLobbyRemoved(sessionId: string): void {
        const entry = this.findBySession(sessionId);
        if (!entry) {
            return;
        }

        this.challenges.delete(entry.challengeId);
        switch (entry.status) {
            case `pending`:
                /* A withdrawal, or the challenger's stream dropped: the target holds
                 * the only line that needs retracting. */
                entry.view.status = `canceled`;
                this.emitTo(entry.challengedProfileId, { type: `challengeCanceled`, challenge: entry.view, reason: `canceled` });
                break;
            case `accepted`:
                /* The target claimed its seat but the game never started: the side
                 * waiting on a game is the challenger. */
                entry.view.status = `canceled`;
                this.emitTo(entry.challengerProfileId, { type: `challengeCanceled`, challenge: entry.view, reason: `canceled` });
                break;
            case `declined`:
            case `expired`:
                /* Already notified by the action that marked the entry. */
                break;
        }
    }

    private findBySession(sessionId: string): ChallengeEntry | null {
        for (const entry of this.challenges.values()) {
            if (entry.session.id === sessionId) {
                return entry;
            }
        }

        return null;
    }

    private pendingEntries(): ChallengeEntry[] {
        return [...this.challenges.values()].filter((entry) => entry.status === `pending`);
    }

    private async requireOwnedBot(owner: AccountUserProfile, botProfileId: string): Promise<AccountUserProfile> {
        const account = await this.botAccountRepository.findByOwner(owner.id, botProfileId);
        if (!account) {
            throw new ApiRequestError(404, `Bot not found.`);
        }

        const profile = await this.authRepository.getUserProfileById(botProfileId);
        if (!profile) {
            throw new ApiRequestError(404, `Bot not found.`);
        }

        return profile;
    }

    private emitTo(botProfileId: string, event: BotChallengeEvent): void {
        /* A closed stream drops the line; the open-replay re-offers pending ones. */
        this.botStreamRegistry.emitToBot(botProfileId, event);
    }

    private createChallengeId(): string {
        /* Guessing an id must not be a door: the same standard as tokens, not Math.random. */
        let challengeId = `c_${randomBytes(8).toString(`hex`)}`;
        while (this.challenges.has(challengeId)) {
            challengeId = `c_${randomBytes(8).toString(`hex`)}`;
        }

        return challengeId;
    }
}

/** A declared `accepts` against a challenge's clock: the window is inclusive, and a
 * `null` window declines turn clocks entirely, parallel to `match: false`. */
function acceptsTimeControl(accepts: BotAccepts, timeControl: GameTimeControl): boolean {
    if (timeControl.mode === `unlimited`) {
        return accepts.unlimited;
    }

    if (timeControl.mode === `match`) {
        return accepts.match;
    }

    return accepts.turnMs !== null
        && timeControl.turnTimeMs >= accepts.turnMs[0]
        && timeControl.turnTimeMs <= accepts.turnMs[1];
}

/** The reserved list is `[challenger, target]`, which is the lobby's `[host, guest]`. */
function toLobbyFirstPlayer(firstPlayer: `challenger` | `challenged` | `random`): LobbyFirstPlayer {
    switch (firstPlayer) {
        case `challenger`:
            return `host`;
        case `challenged`:
            return `guest`;
        case `random`:
            return `random`;
    }
}
