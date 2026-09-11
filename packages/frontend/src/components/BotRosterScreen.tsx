import type { AccountProfile, BotListing } from '@ih3t/shared';
import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button';
import BotBadge from './BotBadge';

type BotRosterScreenProps = {
    account: AccountProfile | null
    bots: BotListing[]
    onPlay: (bot: BotListing) => void
};

/** The public bot directory: one row per live bot account, online first in spirit. */
function BotRosterScreen({ account, bots, onPlay }: Readonly<BotRosterScreenProps>) {
    const { t } = useTranslation()

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-6 sm:px-4">
            <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">
                    {t('botRoster', 'Bots')}
                </div>

                <h1 className="mt-1 text-2xl font-black uppercase tracking-[0.05em] text-white">
                    {t('playABot', 'Play a Bot')}
                </h1>

                <p className="mt-1.5 text-sm leading-5 text-slate-300">
                    {t('botRosterDescription', 'Bots connected to this server. Play one, or bring your own.')}
                </p>
            </div>

            {bots.length === 0 ? (
                <div className="rounded-[1rem] border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-slate-300">
                    {t('noBotsYet', 'No bots are registered yet.')}
                </div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {bots.map((bot) => {
                        const playable = bot.online;

                        return (
                            <li
                                key={bot.profileId}
                                className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[1rem] border px-4 py-3 ${playable
                                    ? `border-white/10 bg-white/5`
                                    : `border-white/8 bg-white/4 opacity-60`
                                    }`}
                            >
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate text-base font-bold text-white">
                                            {bot.displayName}
                                        </span>

                                        <BotBadge />
                                    </div>

                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                                        <span>
                                            {t('eloRatingValue', '{{elo}} ELO', { elo: bot.elo })}
                                        </span>

                                        {bot.owner && (
                                            <span>
                                                {t('botOwner', 'Owner')}:{` `}

                                                <NavLink
                                                    to={`/profile/${bot.owner}`}
                                                    className="text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white"
                                                >
                                                    {account?.id === bot.owner
                                                        ? t('you', 'You')
                                                        : bot.owner}
                                                </NavLink>
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2.5">
                                    <span
                                        title={bot.online ? t('botOnline', 'Online') : t('botOffline', 'Offline')}
                                        className={`size-2.5 rounded-full ${bot.online ? `bg-emerald-400` : `bg-slate-500`}`}
                                    />

                                    <Button
                                        onClick={() => onPlay(bot)}
                                        disabled={!playable}
                                        variant="secondary" size="sm"
                                        title={bot.online ? undefined : t('botOfflineHint', 'This bot is not connected.')}
                                    >
                                        {t('playBot', 'Play')}
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default BotRosterScreen;
