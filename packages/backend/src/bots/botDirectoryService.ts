import { type BotListing, type CreateSessionResponse, type LobbyOpponent, type LobbyOptions } from '@ih3t/shared';
import { Mutex } from 'async-mutex';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { AuthRepository } from '../auth/authRepository';
import { ROOT_LOGGER } from '../logger';
import type { RequestClientInfo } from '../network/clientInfo';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { SessionManager } from '../session/sessionManager';
import { BotAccountRepository } from './botAccountRepository';
import { MAX_CONCURRENT_GAMES_PER_BOT } from './botAccountService';
import { BotPlayerMapper } from './botPlayerMapper';
import { type BotSeatPresence, seatBotInLobby, underBotSeatGate } from './botSeatGate';
import { BotSeatManager } from './botSeatManager';
import { BotStreamRegistry } from './botStreamRegistry';

@injectable()
export class BotDirectoryService {
    private readonly logger: Logger;

    /* Two Plays racing each other must not both pass the cap check; the mutex makes
     * the check-and-create sequence atomic for this route. */
    private readonly createMutex = new Mutex();

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(AuthRepository) private readonly authRepository: AuthRepository,
        @inject(BotPlayerMapper) private readonly botPlayerMapper: BotPlayerMapper,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotStreamRegistry) private readonly botStreamRegistry: BotStreamRegistry,
        @inject(BotSeatManager) private readonly botSeatManager: BotSeatManager,
    ) {
        this.logger = rootLogger.child({ component: `bot-directory-service` });
    }

    /**
     * The public roster, spec tag Directory; `?online=1` narrows it to connected bots.
     * A bot the server drives is reached by running it: always online, and never open
     * — it takes no challenges, only the lobby dialog seats it.
     */
    async listBots(onlineOnly: boolean): Promise<BotListing[]> {
        const accounts = await this.botAccountRepository.listAll();
        const listings = await Promise.all(accounts.map(async (account) => {
            const engineDriven = this.botSeatManager.getDriverType(account.id) === `engine`;
            return {
                ...await this.botPlayerMapper.fromAccount(account),
                owner: account.ownerProfileId ?? undefined,
                online: engineDriven || this.botStreamRegistry.isOnline(account.id),
                openForChallenges: !engineDriven && this.botStreamRegistry.isOpenForChallenges(account.id),
                ...(account.declaration?.accepts ? { accepts: account.declaration.accepts } : {}),
            } satisfies BotListing;
        }));

        const visible = onlineOnly ? listings.filter((listing) => listing.online) : listings;
        return visible.sort((left, right) => right.elo - left.elo || left.displayName.localeCompare(right.displayName));
    }

    /**
     * The dialog's community-bot opponent: a normal lobby — its visibility and clock,
     * never rated, first player random, no reserved seats — with the bot's seat already
     * claimed over its stream, exactly as a house bot's is over its engine. The human
     * takes the open seat over the socket; a dropped stream un-claims the seat through
     * the same sweep, nothing here has to react.
     */
    async createLobby(client: RequestClientInfo, lobbyOptions: LobbyOptions, opponent: Extract<LobbyOpponent, { kind: `bot` }>): Promise<CreateSessionResponse> {
        return await this.createMutex.runExclusive(() => this.createLobbyLocked(client, lobbyOptions, opponent));
    }

    private async createLobbyLocked(client: RequestClientInfo, lobbyOptions: LobbyOptions, opponent: Extract<LobbyOpponent, { kind: `bot` }>): Promise<CreateSessionResponse> {
        const account = await this.botAccountRepository.findById(opponent.profileId);
        const botProfile = account ? await this.authRepository.getUserProfileById(account.id) : null;
        if (!account || !botProfile || botProfile.kind !== `bot`) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

        /* Playable from the dialog means connected with `open=1`: the flag is the bot's
         * word that it takes games it did not start, and it dies with the stream. */
        const presence: BotSeatPresence = {
            isOnline: (botId) => this.botStreamRegistry.isOnline(botId) && this.botStreamRegistry.isOpenForChallenges(botId),
            getSocketId: (botId) => this.botStreamRegistry.getSocketId(botId),
        };
        const offline = () => new ApiRequestError(503, this.botStreamRegistry.isOnline(account.id)
            ? `That bot is not taking games right now.`
            : `That bot is not connected right now.`);
        if (!presence.isOnline(account.id)) {
            /* Refused before a lobby exists; the gate's own check is the atomic one. */
            throw offline();
        }

        /* The lobby and the seat are one claim: a cap or connection failure past this
         * point leaves an empty lobby the sweep retires within seconds. */
        return await underBotSeatGate(async () => {
            const response = this.sessionManager.createSession({
                client,
                lobbyOptions: { ...lobbyOptions, rated: false, firstPlayer: `random` },
                reservedPlayerProfileIds: [],
            });

            const session = this.sessionManager.requireSession(response.sessionId);
            await seatBotInLobby(
                { sessionManager: this.sessionManager, presence },
                session,
                botProfile,
                (profileId) => this.sessionManager.countActivePlayerSessionsByProfileId(profileId),
                {
                    offline,
                    capReached: () => new ApiRequestError(409, `A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`),
                    seatLost: () => new ApiRequestError(409, `That bot could not take its seat.`),
                },
            );

            this.logger.info({ event: `bot.lobby.created`, botProfileId: account.id, sessionId: session.id }, `Community bot lobby created`);
            return response;
        });
    }
}
