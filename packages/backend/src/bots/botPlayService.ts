import {
    type BotAccountInfoResponse,
    type BotMoveErrorCode,
    type BotPlayer,
    getCellKey,
    type HexCoordinate,
    isCellWithinPlacementRadius,
} from '@ih3t/shared';
import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile, AuthRepository } from '../auth/authRepository';
import { EloHandler } from '../elo/eloHandler';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { MAX_PLAYERS_PER_SESSION, SessionError, SessionManager } from '../session/sessionManager';
import type { ServerGameSession, ServerSessionPlayer } from '../session/types';
import { BotAccountRepository } from './botAccountRepository';
import { MAX_CONCURRENT_GAMES_PER_BOT } from './botAccountService';
import { BotStreamRegistry } from './botStreamRegistry';
import { fromMoveResponse, HtttxCodecError, sideOf } from './htttxCodec';

/** A rejection a bot can act on, carrying one of the contract's move error codes. */
export class BotMoveError extends ApiRequestError {
    constructor(message: string, readonly code: BotMoveErrorCode | null = null) {
        super(400, message);
        this.name = `BotMoveError`;
    }
}

@injectable()
export class BotPlayService {
    constructor(
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotStreamRegistry) private readonly botStreamRegistry: BotStreamRegistry,
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(AuthRepository) private readonly authRepository: AuthRepository,
        @inject(EloHandler) private readonly eloHandler: EloHandler,
    ) { }

    async getAccount(bot: AccountUserProfile): Promise<BotAccountInfoResponse> {
        const account = await this.botAccountRepository.findById(bot.id);
        const owner = account ? await this.authRepository.getUserProfileById(account.ownerProfileId) : null;

        return {
            bot: await this.toBotPlayer(bot),
            owner: await this.toBotPlayer(owner),
            activeGames: this.getActiveGames(bot.id).map(({ session, participant }) => ({
                gameId: session.gameId,
                side: sideOf(session.gameState, participant.id),
            })),
        };
    }

    /**
     * The entry a human takes with a `?join=` link. The start arrives on the stream.
     * Joining twice reclaims the same seat: a repeated call — the natural reaction to a
     * lost response — must never take a second one, which would start a game the bot
     * plays against itself and only ever answers one side of.
     */
    async joinSession(bot: AccountUserProfile, sessionId: string): Promise<void> {
        const session = this.sessionManager.requireSession(sessionId);
        const socketId = this.botStreamRegistry.getSocketId(bot.id);
        const seated = session.players.find((player) => player.profileId === bot.id);
        const participantId = seated?.id ?? await this.claimSeat(session, bot, socketId);

        this.sessionManager.assignParticipantSocket(session, participantId, socketId);
    }

    private async claimSeat(
        session: ServerGameSession,
        bot: AccountUserProfile,
        socketId: string,
    ): Promise<string> {
        if (session.state !== `lobby`) {
            throw new ApiRequestError(400, `That game has already started.`);
        }

        if (session.players.length >= MAX_PLAYERS_PER_SESSION) {
            throw new ApiRequestError(400, `That lobby has no seat left for a bot.`);
        }

        if (this.countActiveSessions(bot.id) >= MAX_CONCURRENT_GAMES_PER_BOT) {
            throw new ApiRequestError(400, `A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`);
        }

        const participation = await this.sessionManager.joinSession(session, {
            deviceId: socketId,
            profile: bot,
            displayName: bot.username,
            allowSelfJoinCasualGames: true,
        });
        if (participation.role !== `player`) {
            /* Lost a race for the last seat: give the spectator row straight back, or it
             * would sit there forever with no socket to disconnect it. */
            await this.sessionManager.leaveSession(session, participation.participant.id, `leave-session`);
            throw new ApiRequestError(400, `That lobby has no seat left for a bot.`);
        }

        return participation.participant.id;
    }

    async playMove(bot: AccountUserProfile, gameId: string, body: unknown): Promise<void> {
        const session = this.sessionManager.getSessionByGameId(gameId);
        if (!session) {
            throw new BotMoveError(`That game is not in progress.`, `game-over`);
        }

        const seat = session.players.find((player) => player.profileId === bot.id);
        if (!seat) {
            throw new BotMoveError(`You are not playing that game.`);
        }

        const move = this.decode(body);
        if (this.isStale(session, bot.id, move.requestId)) {
            throw new BotMoveError(`That move answers an earlier position.`, `stale-request`);
        }

        const rejection = this.classify(session, seat, move.cells);
        if (rejection) {
            throw new BotMoveError(rejection.message, rejection.code);
        }

        try {
            await this.sessionManager.placeCells(session, seat.id, move.cells);
        } catch (error: unknown) {
            /* Lost a race with the clock or the opponent: nothing was applied. */
            const late = this.classify(session, seat, move.cells);
            throw new BotMoveError(error instanceof Error ? error.message : `The move was rejected.`, late?.code ?? null);
        }
    }

    /** The one game control the contract has; everything downstream is the human resign path. */
    async resignGame(bot: AccountUserProfile, gameId: string): Promise<void> {
        const session = this.sessionManager.getSessionByGameId(gameId);
        if (!session) {
            throw new BotMoveError(`That game is not in progress.`, `game-over`);
        }

        const seat = session.players.find((player) => player.profileId === bot.id);
        if (!seat) {
            throw new BotMoveError(`You are not playing that game.`);
        }

        if (session.state !== `in-game` || session.gameState.winner) {
            throw new BotMoveError(`That game is over.`, `game-over`);
        }

        try {
            await this.sessionManager.surrenderSession(session, seat.id);
        } catch (error: unknown) {
            /* Lost a race with the opponent finishing first: the same terminal state. */
            if (error instanceof SessionError) {
                throw new BotMoveError(error.message, `game-over`);
            }

            throw error;
        }
    }

    private decode(body: unknown): { cells: [HexCoordinate, HexCoordinate], requestId: number | null } {
        try {
            return fromMoveResponse(body);
        } catch (error: unknown) {
            if (error instanceof HtttxCodecError) {
                throw new BotMoveError(error.message, error.code);
            }

            throw error;
        }
    }

    private isStale(session: ServerGameSession, botProfileId: string, requestId: number | null): boolean {
        if (requestId === null) {
            /* The contract makes request_id optional; a bot that omits it opts out. */
            return false;
        }

        const current = this.botStreamRegistry.getRequestId(botProfileId, session.id);
        return current !== null && requestId < current;
    }

    /**
     * The server has no error codes of its own: every rule violation arrives as one
     * free-text message. The code is therefore read off the position, never parsed out
     * of a message, and the order is the order a bot can act on.
     */
    private classify(
        session: ServerGameSession,
        seat: ServerSessionPlayer,
        cells: readonly HexCoordinate[],
    ): { code: BotMoveErrorCode, message: string } | null {
        const { gameState } = session;
        if (session.state !== `in-game` || gameState.winner) {
            return { code: `game-over`, message: `That game is over.` };
        }

        if (gameState.currentTurnPlayerId !== seat.id) {
            return { code: `not-your-turn`, message: `It is not your turn.` };
        }

        const placed = gameState.cells.map((cell) => getCellKey(cell.x, cell.y));
        const played: HexCoordinate[] = [...gameState.cells];
        for (const cell of cells) {
            if (placed.includes(getCellKey(cell.x, cell.y))) {
                return { code: `occupied`, message: `That cell is already occupied.` };
            }

            if (!isCellWithinPlacementRadius(played, cell)) {
                return { code: `out-of-range`, message: `That cell is out of placement range.` };
            }

            placed.push(getCellKey(cell.x, cell.y));
            played.push(cell);
        }

        return null;
    }

    /** Games with a `gameId`, which is every game a bot can be asked to move in. */
    private getActiveGames(botProfileId: string) {
        return this.sessionManager.getPlayerParticipationsByProfileId(botProfileId)
            .flatMap((participation) => participation.role === `player`
                && participation.session.state === `in-game`
                && participation.session.gameId
                ? [{ session: participation.session, participant: participation.participant }]
                : []);
    }

    /** The cap counts lobbies too: refusing only once a game starts is refusing too late. */
    private countActiveSessions(botProfileId: string): number {
        return this.sessionManager.getPlayerParticipationsByProfileId(botProfileId)
            .filter((participation) => participation.role === `player`
                && participation.session.state !== `finished`)
            .length;
    }

    private async toBotPlayer(profile: AccountUserProfile | null): Promise<BotPlayer> {
        if (!profile) {
            return { profileId: null, displayName: ``, elo: null };
        }

        const rating = await this.eloHandler.getPlayerRating(profile.id);
        return { profileId: profile.id, displayName: profile.username, elo: Math.round(rating.eloScore) };
    }
}
