import type { BotListing, CreateSessionRequest } from '@ih3t/shared';
import { Navigate } from 'react-router';
import { toast } from 'react-toastify';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next'

import BotRosterScreen from '../components/BotRosterScreen';
import CreateLobbyDialog, { type LobbyOpponentChoice } from '../components/CreateLobbyDialog';
import PageMetadata from '../components/PageMetadata';
import { joinSession } from '../liveGameClient';
import { useQueryAccount, useQueryAccountBots } from '../query/accountClient';
import { useQueryBots } from '../query/botsClient';
import { useQueryHouseBots } from '../query/houseBotsClient';
import { hostGame } from '../query/sessionClient';

function BotsRoute() {
    const { t } = useTranslation()
    const accountQuery = useQueryAccount({ enabled: true });
    const botsQuery = useQueryBots();
    const houseBotsQuery = useQueryHouseBots();
    const accountBotsQuery = useQueryAccountBots({
        enabled: !accountQuery.isLoading && Boolean(accountQuery.data?.user),
    });
    const [playingBot, setPlayingBot] = useState<BotListing | null>(null);
    /* A house bot on the roster opens the dialog on its strength picker, not on a stream seat;
     * a string-keyed memo, so a re-render with the same choice does not reset the dialog. */
    const houseBots = houseBotsQuery.data ?? null;
    const initialOpponent = useMemo<LobbyOpponentChoice>(
        () => playingBot
            ? { kind: houseBots?.bots.some((bot) => bot.profileId === playingBot.profileId) ? `house-bot` : `bot`, profileId: playingBot.profileId }
            : `open`,
        [playingBot, houseBots],
    );

    /* Null, not undefined: the roster route is absent while the flag is off. */
    if (botsQuery.data === null && !botsQuery.isLoading) {
        return <Navigate to="/" replace />;
    }

    /* The same picker as the lobby, opened on the chosen bot; Play here is a shortcut. */
    const createLobby = (request: CreateSessionRequest) => {
        void (async () => {
            try {
                const sessionId = await hostGame(request);
                setPlayingBot(null);

                /* Joining switches the screen to the lobby, same as hosting one. */
                joinSession(sessionId);
            } catch (error) {
                console.error(`Failed to start a bot session:`, error);
                const message = error instanceof Error ? error.message : t('failedToCreateASession', 'Failed to create a session.');
                toast.error(message, {
                    toastId: `error:${message}`,
                });
            }
        })();
    };

    return (
        <>
            <PageMetadata
                title={t('botRoster', 'Bots')}
                description={t('botRosterDescription', 'Bots connected to this server. Play one, or bring your own.')}
            />

            {botsQuery.isLoading ? (
                <div className="mx-auto w-full max-w-3xl px-3 py-6 text-sm text-slate-300 sm:px-4">
                    {t('loadingBots', 'Loading bots…')}
                </div>
            ) : botsQuery.isError ? (
                <div className="mx-auto w-full max-w-3xl px-3 py-6 text-sm text-rose-200 sm:px-4">
                    {t('botsUnavailable', 'The bot roster could not be loaded.')}
                </div>
            ) : (
                <BotRosterScreen
                    account={accountQuery.data?.user ?? null}
                    bots={botsQuery.data ?? []}
                    onPlay={setPlayingBot}
                />
            )}

            <CreateLobbyDialog
                isOpen={playingBot !== null}
                initialOpponent={initialOpponent}
                onClose={() => setPlayingBot(null)}
                account={accountQuery.data?.user ?? null}
                houseBots={houseBotsQuery.data ?? null}
                ownBots={accountBotsQuery.data?.bots ?? null}
                onlineBots={(botsQuery.data ?? []).filter((bot) => bot.online)}
                onCreateLobby={createLobby}
            />
        </>
    );
}

export default BotsRoute;
