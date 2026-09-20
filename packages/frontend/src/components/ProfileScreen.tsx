import { Button, buttonVariants } from '@/components/ui/button';
import type { AccountProfile, AccountEloHistory, AccountStatistics, BotAccount, BotListing, BotStats, FinishedGamesPage, LobbyInfo, PublicAccountProfile } from '@ih3t/shared';
import { type ReactNode, useMemo, useState } from 'react';
import React from 'react';
import { Link } from 'react-router';
import { toast } from 'react-toastify';
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

import { signInWithDiscord } from '../query/authClient';
import { joinSession } from '../liveGameClient';
import { hostGame } from '../query/sessionClient';
import { buildSessionPath } from '../routes/archiveRouteState';
import { useSsrCompatibleNow } from '../ssrState';
import type { TFunction } from 'i18next';
import BotBadge from './BotBadge';
import {
    formatCalendarDate,
    formatChartDate,
    formatDateTime,
    formatRelativeTimeFrom,
    useIntlFormatProvider,
} from '../utils/dateTime';
import { formatDetailedDuration } from '../utils/duration';
import { formatTimeControl } from '../utils/gameTimeControl';
import { formatLobbyPlayers } from '../utils/lobby';
import {
    formatWinSummary,
    formatWorldRank,
} from '../utils/profileStats';
import AccountPicture from './AccountPicture';
import AccountBotsCard, { BotTokenPanel } from './AccountBotsCard';
import type { HouseBotListing } from '@ih3t/shared';
import ChallengeDialog from './ChallengeDialog';
import CreateLobbyDialog from './CreateLobbyDialog';
import FinishedGameCard from './FinishedGameCard';
import PageCorpus from './PageCorpus';
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'

const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

function showErrorToast(message: string) {
    toast.error(message, {
        toastId: `error:${message}`,
    });
}

type ProfileScreenProps = {
    account: PublicAccountProfile | null
    statistics: AccountStatistics | null
    recentGames: FinishedGamesPage | null
    liveGame: LobbyInfo | null
    isLoading: boolean
    isStatisticsLoading: boolean
    isRecentGamesLoading: boolean
    errorMessage: string | null
    statisticsErrorMessage: string | null
    recentGamesErrorMessage: string | null
    isPublicView: boolean
    /** The signed-in player's bots; null while the flag is off hides the Challenge entry. */
    ownBots?: BotAccount[] | null
    /** The house-bot listing when the profile is one: it is challenged at a picked strength. */
    houseBot?: HouseBotListing | null
    /** The signed-in player, for the Play dialog's rated options; null as a guest. */
    viewerAccount?: AccountProfile | null
    /** The public roster; presence and ownership come off it, and it feeds Play. */
    botsListing?: BotListing[] | null
    /** The profile bot's stats, when the profile is a bot. */
    botStats?: BotStats | null
};

type PrimaryStatCardProps = {
    label: string
    value: string | number
    detail: string
    accentClassName: string
};

function PrimaryStatCard({ label, value, detail, accentClassName }: Readonly<PrimaryStatCardProps>) {
    return (
        <div className="rounded-3xl border border-white/10 bg-slate-950/55 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.22)]">
            <div className={`text-xs font-semibold uppercase tracking-[0.28em] ${accentClassName}`}>
                {label}
            </div>

            <div className="mt-3 text-4xl font-black uppercase tracking-[0.04em] text-white sm:text-5xl">
                {value}
            </div>

            <div className="mt-3 text-sm leading-6 text-slate-300">
                {detail}
            </div>
        </div>
    );
}

type SecondaryStatCardProps = {
    label: string
    value: string | number
    detail: string
};

function SecondaryStatCard({ label, value, detail }: Readonly<SecondaryStatCardProps>) {
    return (
        <div className="rounded-[1.25rem] border border-white/10 bg-slate-950/55 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.18)]">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-400">
                {label}
            </div>

            <div className="mt-2 text-2xl font-black uppercase tracking-[0.05em] text-white">
                {value}
            </div>

            <div className="mt-2 text-sm text-slate-300">
                {detail}
            </div>
        </div>
    );
}

type AccountMetaItemProps = {
    label: string
    value: string
};

function AccountMetaItem({ label, value }: Readonly<AccountMetaItemProps>) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                {label}
            </span>

            <span className="text-sm text-slate-200">
                {value}
            </span>
        </div>
    );
}

type StatisticsGroupProps = {
    eyebrow: string
    title: string
    description: string
    accentClassName: string
    cardGridClassName: string
    children: ReactNode
};

function StatisticsGroup({
    eyebrow,
    title,
    description,
    accentClassName,
    cardGridClassName,
    children,
}: Readonly<StatisticsGroupProps>) {
    return (
        <section className="rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.72),rgba(15,23,42,0.5))] p-5 shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
            <div className={`text-xs uppercase tracking-[0.28em] ${accentClassName}`}>
                {eyebrow}
            </div>

            <h3 className="mt-3 text-xl font-black uppercase tracking-[0.08em] text-white">
                {title}
            </h3>

            <p className="mt-2 text-sm leading-6 text-slate-300">
                {description}
            </p>

            <div className={`mt-5 grid gap-4 ${cardGridClassName}`}>
                {children}
            </div>
        </section>
    );
}

function StatisticsLoadingState({ message = i18next.t('loadingYourStatistics', 'Loading your statistics...') }: Readonly<{ message?: string }>) {
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-3xl border border-white/10 bg-slate-950/45 px-5 py-10 text-center text-sm text-slate-300 lg:col-span-2">
                {message}
            </div>
        </div>
    );
}

function StatisticsErrorState({ message }: Readonly<{ message: string }>) {
    return (
        <div className="rounded-3xl border border-rose-300/30 bg-rose-500/10 px-5 py-4 text-sm text-rose-100">
            {message}
        </div>
    );
}

function StatisticsEmptyState({ message = i18next.t('statisticsWillAppearHereOnceYourProfileDataIsReady', 'Statistics will appear here once your profile data is ready.') }: Readonly<{ message?: string }>) {
    return (
        <div className="rounded-3xl border border-white/10 bg-slate-950/45 px-5 py-10 text-center text-sm text-slate-300">
            {message}
        </div>
    );
}

function LiveGameSection({
    liveGame,
}: Readonly<{
    liveGame: LobbyInfo
}>) {
    const { t } = useTranslation()
    const intlFormatProvider = useIntlFormatProvider();
    return (
        <section className="rounded-[1.6rem] border border-emerald-300/20 bg-[linear-gradient(180deg,rgba(6,78,59,0.38),rgba(15,23,42,0.62))] p-5 shadow-[0_24px_80px_rgba(6,78,59,0.18)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100">
                            {t('liveGame', 'Live Game')}
                        </span>

                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${liveGame.rated
                            ? `bg-amber-300/15 text-amber-100`
                            : `bg-white/8 text-slate-200`
                            }`}
                        >
                            {liveGame.rated ? `Rated` : `Casual`}
                        </span>

                        <span className="rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                            {formatTimeControl(liveGame.timeControl)}
                        </span>
                    </div>

                    <h3 className="mt-3 text-xl font-black uppercase tracking-[0.08em] text-white">
                        {t('currentlyPlaying', 'Currently Playing')}
                    </h3>

                    <div className="mt-2 text-sm leading-6 text-slate-300">
                        {formatLobbyPlayers(liveGame.players, liveGame.rated, `Waiting for players`)}
                        {liveGame.players.some((player) => player.isBot) && <BotBadge />}
                    </div>

                    {liveGame.startedAt && (
                        <div className="mt-2 text-xs uppercase tracking-[0.18em] text-emerald-100/80">
                            {`Started `}
                            {formatDateTime(intlFormatProvider, liveGame.startedAt)}
                        </div>
                    )}
                </div>

                <Link
                    to={buildSessionPath(liveGame.id)}
                    className={`${buttonVariants({ variant: `success-soft`, size: `lg` })} lg:shrink-0`}
                >
                    {t('watchLiveGame', 'Watch Live Game')}
                </Link>
            </div>
        </section>
    );
}

function RecentGamesSection({
    profileId,
    recentGames,
    isLoading,
    errorMessage,
    isPublicView,
}: Readonly<{
    profileId: string
    recentGames: FinishedGamesPage | null
    isLoading: boolean
    errorMessage: string | null
    isPublicView: boolean
}>) {
    const { t } = useTranslation()
    const games = recentGames?.games ?? [];

    return (
        <section className="rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.72),rgba(15,23,42,0.5))] p-5 shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
            <div>
                <div className="text-xs uppercase tracking-[0.28em] text-violet-200/85">
                    {t('matchHistory', 'Match History')}
                </div>

                <h3 className="mt-3 text-xl font-black uppercase tracking-[0.08em] text-white">
                    {t('last10Games', 'Last 10 Games')}
                </h3>

                <p className="mt-2 text-sm leading-6 text-slate-300">
                    {t('theMostRecentFinishedMatchesPlayedOnThisProfile', 'The most recent finished matches played on this profile.')}
                </p>
            </div>

            {isLoading ? (
                <div className="mt-5 rounded-[1.25rem] border border-white/10 bg-slate-950/45 px-4 py-8 text-center text-sm text-slate-300">
                    {t('loadingRecentGames', 'Loading recent games...')}
                </div>
            ) : errorMessage ? (
                <div className="mt-5 rounded-[1.25rem] border border-rose-300/30 bg-rose-500/10 px-4 py-4 text-sm text-rose-100">
                    {errorMessage}
                </div>
            ) : games.length === 0 ? (
                <div className="mt-5 rounded-[1.25rem] border border-white/10 bg-slate-950/45 px-4 py-8 text-center text-sm text-slate-300">
                    {t('noFinishedGamesHaveBeenRecordedForThisProfileYet', 'No finished games have been recorded for this profile yet.')}
                </div>
            ) : (
                <div className="mt-5 space-y-4">
                    {games.map((game) => (
                        <FinishedGameCard
                            key={game.id}
                            game={game}
                            context={isPublicView ? `user-profile` : `user-history`}
                            currentProfileId={profileId}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

type EloChartPoint = {
    timestamp: number
    elo: number
};
function EloHistoryChartSection({
    eloHistory,
    currentElo,
}: Readonly<{
    eloHistory: AccountEloHistory
    currentElo: number
}>) {
    const { t } = useTranslation()
    const intlFormatProvider = useIntlFormatProvider();
    const ssrNow = useSsrCompatibleNow();
    const now = useMemo(() => ssrNow, [eloHistory]);

    /* align the own start with the bucket size */
    let windowStart = now - thirtyDaysMs;
    windowStart -= windowStart % eloHistory.bucketSizeMs;
    windowStart = Math.max(windowStart, eloHistory.points[0]?.timestamp ?? 0)

    const sortedPoints = [...eloHistory.points]
        .filter((point) => point.timestamp < now)
        .sort((left, right) => left.timestamp - right.timestamp);

    const currentPoint = {
        elo: currentElo,

        /* The current ELO is the same since the last bucket end as buckets are only provided if there happened any games. */
        timestamp: Math.min((sortedPoints.at(-1)?.timestamp ?? now) + eloHistory.bucketSizeMs, now),
    };

    sortedPoints.push(currentPoint);

    const chartPoints: EloChartPoint[] = [];

    let currentTimestamp = windowStart;
    let currentEloScore = 1000;
    let currentHistoryIndex = 0;

    while (currentTimestamp <= now) {
        while (currentHistoryIndex < sortedPoints.length) {
            if (sortedPoints[currentHistoryIndex].timestamp > currentTimestamp) {
                break;
            }

            currentEloScore = sortedPoints[currentHistoryIndex].elo;
            currentHistoryIndex++;
        }

        chartPoints.push({ timestamp: currentTimestamp, elo: currentEloScore });
        currentTimestamp += eloHistory.bucketSizeMs;
    }

    const highestPoint = sortedPoints.reduce(
        (highest, point) => point.elo > highest.elo ? point : highest,
        currentPoint,
    );

    const [lowestElo, highestElo] = chartPoints.reduce<[number, number]>(
        (range, point) => {
            return [
                Math.min(range[0], point.elo),
                Math.max(range[1], point.elo),
            ];
        },
        [currentElo, currentElo],
    );
    const yAxisPadding = Math.max(10, Math.ceil((highestElo - lowestElo) * 0.12));
    const yAxisDomain: [number, number] = [
        Math.max(0, lowestElo - yAxisPadding),
        highestElo + yAxisPadding,
    ];

    return (
        <React.Fragment>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <div className="text-xs uppercase tracking-[0.28em] text-sky-200/85">
                        {t('competitiveTrend', 'Competitive Trend')}
                    </div>

                    <h3 className="mt-3 text-xl font-black uppercase tracking-[0.08em] text-white">
                        {t('eloRating', 'ELO Rating')}
                    </h3>

                    <p className="mt-2 text-sm leading-6 text-slate-300">
                        {t('eloRatingOverTheLast30Days', 'ELO rating over the last 30 days.')}
                    </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-3">
                    <div className="text-[0.62rem] uppercase tracking-[0.24em] text-slate-500">
                        {t('highestRating', 'Highest Rating')}
                    </div>

                    <div className="mt-1 text-lg font-bold leading-none text-white">
                        {highestPoint.elo}
                    </div>

                    <div className="mt-1 text-xs text-slate-400">
                        {`Reached `}
                        {formatDateTime(intlFormatProvider, highestPoint.timestamp)}
                    </div>
                </div>
            </div>

            <div className="mt-5 h-72 rounded-[1.25rem] border border-white/8 bg-slate-950/45 p-3">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartPoints} margin={{ top: 12, right: 12, bottom: 12, left: 0 }}>
                        <CartesianGrid stroke="rgba(148,163,184,0.16)" vertical={false} />

                        <XAxis
                            dataKey="timestamp"
                            minTickGap={28}
                            stroke="#94a3b8"
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(time: number) => formatChartDate(intlFormatProvider, time)}
                        />

                        <YAxis
                            allowDecimals={false}
                            domain={yAxisDomain}
                            stroke="#94a3b8"
                            tickLine={false}
                            axisLine={false}
                            width={48}
                        />

                        <Tooltip
                            cursor={{ stroke: `rgba(125,211,252,0.35)`, strokeWidth: 1 }}
                            contentStyle={{
                                backgroundColor: `rgba(2,6,23,0.94)`,
                                border: `1px solid rgba(148,163,184,0.2)`,
                                borderRadius: `1rem`,
                                color: `#e2e8f0`,
                            }}
                            formatter={(value) => [t('valElo', '{{val}} ELO', { val: value as number }), `Rating`]}
                            labelFormatter={(label) => formatDateTime(intlFormatProvider, Number(label))}
                        />

                        <Line
                            type="monotone"
                            dataKey="elo"
                            stroke="#7dd3fc"
                            strokeWidth={3}
                            dot={chartPoints.length === 1}
                            activeDot={{ r: 5, fill: `#7dd3fc` }}
                            isAnimationActive={false}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </React.Fragment>
    );
}

function ProfileScreen({
    account,
    statistics,
    recentGames,
    liveGame,
    isLoading,
    isStatisticsLoading,
    isRecentGamesLoading,
    errorMessage,
    statisticsErrorMessage,
    recentGamesErrorMessage,
    isPublicView,
    ownBots = null,
    houseBot = null,
    viewerAccount = null,
    botsListing = null,
    botStats = null,
}: Readonly<ProfileScreenProps>) {
    const { t } = useTranslation()
    const intlFormatProvider = useIntlFormatProvider();
    const now = useSsrCompatibleNow();
    const [isChallenging, setIsChallenging] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    /* Owners initiate: a Challenge entry only makes sense for a bot someone can send.
     * A house bot answers through its driver, at the strength picked in the dialog. */
    const canChallenge = account?.kind === `bot` && (ownBots?.length ?? 0) > 0;

    const isBotProfile = account?.kind === `bot`;
    const profileBotListing = isBotProfile && account
        ? botsListing?.find((listing) => listing.profileId === account.id) ?? null
        : null;
    /* Play needs the bot reachable: a house bot always is, a stream bot while online. */
    const canPlay = isBotProfile && (houseBot !== null || profileBotListing?.online === true);
    const ownedBots = account ? (botsListing ?? []).filter((listing) => listing.owner === account.id) : [];
    const isOwnProfile = account !== null && viewerAccount?.id === account?.id;
    const ownedBotEntry = account ? ownBots?.find((bot) => bot.id === account.id) ?? null : null;

    const handleSignIn = async () => {
        try {
            await signInWithDiscord();
        } catch (error) {
            console.error(`Failed to start Discord sign in:`, error);
            showErrorToast(error instanceof Error ? error.message : `Failed to start Discord sign in.`);
        }
    };

    const isMissingPublicProfile = isPublicView && errorMessage === `Profile not found.`;
    const memberSinceLabel = account ? formatCalendarDate(intlFormatProvider, account.registeredAt) : null;
    const lastSeenLabel = account ? formatRelativeTimeFrom(intlFormatProvider, account.lastActiveAt, now) : null;

    return (
        <PageCorpus
            category={isPublicView ? t('profile', 'Profile') : t('account', 'Account')}
            title={isPublicView ? (account?.username ?? `Player Profile`) : t('yourAccount', 'Your Account')}
            description={isPublicView
                ? t('publicProfileDetailsAndCompetitiveStandingForThisHexoPlayer', 'Public profile details and competitive standing for this HeXO player.')
                : t('accountDetailsAndCompetitiveStandingForYourHexoProfile', 'Account details and competitive standing for your HeXO profile.')}
        >
            <div className="flex-1 px-4 pb-4 sm:px-6 sm:pb-6">
                {isLoading ? (
                    <div className="flex h-full items-center justify-center rounded-[1.75rem] border border-white/10 bg-white/6 px-6 py-10 text-center text-slate-300">
                        {isPublicView ? t('loadingProfile', 'Loading profile...') : t('loadingYourAccount', 'Loading your account...')}
                    </div>
                ) : isMissingPublicProfile ? (
                    <div className="flex h-full items-center justify-center">
                        <section className="w-full max-w-2xl rounded-[1.75rem] border border-white/10 bg-white/6 p-6 text-center shadow-[0_20px_80px_rgba(15,23,42,0.35)] sm:p-8">
                            <div className="text-xs uppercase tracking-[0.3em] text-sky-100/90">
                                {t('profile', 'Profile')}
                            </div>

                            <h2 className="mt-4 text-3xl font-black uppercase tracking-[0.08em] text-white">
                                {t('profileNotFound2', 'Profile Not Found')}
                            </h2>

                            <p className="mt-4 text-sm leading-6 text-slate-300 sm:text-base">
                                {t('thisPlayerProfileIsUnavailableOrNoLongerExists', 'This player profile is unavailable or no longer exists.')}
                            </p>
                        </section>
                    </div>
                ) : errorMessage ? (
                    <div className="rounded-3xl border border-rose-300/30 bg-rose-500/10 px-5 py-4 text-sm text-rose-100">
                        {errorMessage}
                    </div>
                ) : !account ? (
                    isPublicView ? (
                        <div className="flex h-full items-center justify-center">
                            <section className="w-full max-w-2xl rounded-[1.75rem] border border-white/10 bg-white/6 p-6 text-center shadow-[0_20px_80px_rgba(15,23,42,0.35)] sm:p-8">
                                <div className="text-xs uppercase tracking-[0.3em] text-sky-100/90">
                                    {t('profile', 'Profile')}
                                </div>

                                <h2 className="mt-4 text-3xl font-black uppercase tracking-[0.08em] text-white">
                                    {t('profileNotFound2', 'Profile Not Found')}
                                </h2>

                                <p className="mt-4 text-sm leading-6 text-slate-300 sm:text-base">
                                    {t('thisPlayerProfileIsUnavailableOrNoLongerExists', 'This player profile is unavailable or no longer exists.')}
                                </p>
                            </section>
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center">
                            <section className="w-full max-w-2xl rounded-[1.75rem] border border-amber-300/20 bg-amber-300/10 p-6 text-center shadow-[0_20px_80px_rgba(15,23,42,0.35)] sm:p-8">
                                <div className="text-xs uppercase tracking-[0.3em] text-amber-100/90">
                                    {t('profileAccess', 'Profile Access')}
                                </div>

                                <h2 className="mt-4 text-3xl font-black uppercase tracking-[0.08em] text-white">
                                    {t('signInRequired', 'Sign In Required')}
                                </h2>

                                <p className="mt-4 text-sm leading-6 text-amber-50/85 sm:text-base">
                                    {t('signInWithDiscordToViewYourAccountDetailsAndCompetitiveStanding', 'Sign in with Discord to view your account details and competitive standing.')}
                                </p>

                                <Button
                                    onClick={() => void handleSignIn()}
                                    variant="discord" size="lg" className="mt-6"
                                >
                                    {t('signInWithDiscord', 'Sign In With Discord')}
                                </Button>
                            </section>
                        </div>
                    )
                ) : (
                    <div className="space-y-6">
                        <section className="relative overflow-hidden rounded-4xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.12),transparent_30%),rgba(255,255,255,0.05)] p-6 shadow-[0_24px_100px_rgba(15,23,42,0.34)] sm:p-8">
                            <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-sky-200/50 to-transparent" />

                            <div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] xl:items-end">
                                <div className="min-w-0 flex items-center my-auto">
                                    <div className="flex min-w-0 items-start gap-4">
                                        <AccountPicture username={account.username} image={account.image} className="h-20 w-20 sm:h-24 sm:w-24 mr-4" />

                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="rounded-full border border-sky-300/25 bg-sky-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-100">
                                                    {account.role === `admin` ? `Administrator` : `Player Profile`}
                                                </span>

                                                <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-200">
                                                    {account.kind === `bot`
                                                        ? t('botAccount', 'Bot')
                                                        : t('discordAccount', 'Discord Account')}
                                                </span>
                                            </div>

                                            <h2 className="mt-4 truncate text-3xl font-black uppercase tracking-[0.06em] text-white sm:text-4xl">
                                                {account.username}
                                            </h2>

                                            <div className="mt-4 flex flex-col text-slate-300">
                                                <AccountMetaItem label={t('memberSince', 'Member Since')} value={memberSinceLabel ?? `Unavailable`} />
                                                <AccountMetaItem label={t('lastSeen', 'Last Seen')} value={lastSeenLabel ?? `Unavailable`} />
                                            </div>

                                            <div className="mt-4 flex flex-wrap gap-2">
                                                {canPlay ? (
                                                    <Button
                                                        onClick={() => setIsPlaying(true)}
                                                        variant="secondary" size="sm"
                                                    >
                                                        {t('play', 'Play')}
                                                    </Button>
                                                ) : null}

                                                {canChallenge ? (
                                                    <Button
                                                        onClick={() => setIsChallenging(true)}
                                                        variant="secondary" size="sm"
                                                    >
                                                        {t('challenge', 'Challenge')}
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    {isStatisticsLoading ? (
                                        <StatisticsLoadingState message={isPublicView ? t('loadingProfileStatistics', 'Loading profile statistics...') : t('loadingYourStatistics', 'Loading your statistics...')} />
                                    ) : statisticsErrorMessage ? (
                                        <StatisticsErrorState message={statisticsErrorMessage} />
                                    ) : statistics ? (
                                        <div className="grid gap-4 lg:grid-cols-2">
                                            <PrimaryStatCard
                                                label={t('worldRank', 'World Rank')}
                                                value={formatWorldRank(statistics.worldRank)}
                                                detail={statistics.worldRank === null ? t('finishARankedGameToEnterTheGlobalStandings', 'Finish a ranked game to enter the global standings.') : t('currentGlobalPlacementBasedOnElo', 'Current global placement based on ELO.')}
                                                accentClassName="text-amber-200"
                                            />

                                            <PrimaryStatCard
                                                label={t('eloRating', 'ELO Rating')}
                                                value={statistics.elo}
                                                detail="Current rating from ranked play."
                                                accentClassName="text-sky-200"
                                            />
                                        </div>
                                    ) : (
                                        <StatisticsEmptyState message={isPublicView
                                            ? t('statisticsWillAppearHereOnceThisProfileHasCompetitiveDataReady', 'Statistics will appear here once this profile has competitive data ready.')
                                            : t('statisticsWillAppearHereOnceYourProfileDataIsReady', 'Statistics will appear here once your profile data is ready.')}
                                        />
                                    )}
                                </div>
                            </div>
                        </section>

                        {liveGame ? (
                            <LiveGameSection liveGame={liveGame} />
                        ) : null}

                        <section className="">
                            {isStatisticsLoading ? (
                                <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-slate-950/45 px-4 py-8 text-center text-sm text-slate-300">
                                    {isPublicView ? t('loadingProfileStatistics', 'Loading profile statistics...') : t('loadingYourStatistics', 'Loading your statistics...')}
                                </div>
                            ) : statisticsErrorMessage ? (
                                <div className="mt-6 rounded-[1.25rem] border border-rose-300/30 bg-rose-500/10 px-4 py-4 text-sm text-rose-100">
                                    {statisticsErrorMessage}
                                </div>
                            ) : statistics ? (
                                <>
                                    <section className="mt-6 rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.72),rgba(15,23,42,0.5))] p-5 shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
                                        <EloHistoryChartSection
                                            eloHistory={statistics.eloHistory}
                                            currentElo={statistics.elo}
                                        />

                                        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
                                            <SecondaryStatCard
                                                label={t('rankedGames', 'Ranked Games')}
                                                value={statistics.rankedGames.played}
                                                detail={formatWinSummary(statistics.rankedGames.won, statistics.rankedGames.played)}
                                            />

                                            <SecondaryStatCard
                                                label={t('currentWinStreak', 'Current Win Streak')}
                                                value={statistics.rankedGames.currentWinStreak}
                                                detail="Current number of unbeaten rated games"
                                            />

                                            <SecondaryStatCard
                                                label={t('longestWinStreak', 'Longest Win Streak')}
                                                value={statistics.rankedGames.longestWinStreak}
                                                detail="Longest streak of unbeaten rated games"
                                            />
                                        </div>
                                    </section>

                                    <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_1.2fr_0.95fr]">
                                        <StatisticsGroup
                                            eyebrow="Overview"
                                            title={t('overallGames', 'Overall Games')}
                                            description={t('allFinishedGamesRegardlessOfQueueTypeAlongWithTheVolumeOfMovesYouveLogged', 'All finished games, regardless of queue type, along with the volume of moves you\'ve logged.')}
                                            accentClassName="text-sky-200/85"
                                            cardGridClassName="sm:grid-cols-2 xl:grid-cols-1"
                                        >
                                            <SecondaryStatCard
                                                label={t('totalGames', 'Total Games')}
                                                value={statistics.totalGames.played}
                                                detail={formatWinSummary(statistics.totalGames.won, statistics.totalGames.played)}
                                            />

                                            <SecondaryStatCard
                                                label={t('totalMoves', 'Total Moves')}
                                                value={statistics.totalMovesMade}
                                                detail="Moves recorded across all of your finished matches."
                                            />
                                        </StatisticsGroup>

                                        <StatisticsGroup
                                            eyebrow="Records"
                                            title={t('personalHighlights', 'Personal Highlights')}
                                            description={t('personalHighlightsLikeLongestMatchMeasuredByTimeOrMoveCount', 'Personal highlights like longest match measured by time or move count.')}
                                            accentClassName="text-emerald-200/85"
                                            cardGridClassName="sm:grid-cols-2 xl:grid-cols-1"
                                        >
                                            <SecondaryStatCard
                                                label={t('longestGame', 'Longest Game')}
                                                value={formatDetailedDuration(statistics.longestGamePlayedMs)}
                                                detail="Your longest finished game by duration."
                                            />

                                            <SecondaryStatCard
                                                label={t('longestByMoves', 'Longest By Moves')}
                                                value={statistics.longestGameByMoves}
                                                detail="Your longest finished game by move count."
                                            />
                                        </StatisticsGroup>
                                    </div>
                                </>
                            ) : (
                                <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-slate-950/45 px-4 py-8 text-center text-sm text-slate-300">
                                    {t('statisticsWillAppearHereOnceYourProfileDataIsReady', 'Statistics will appear here once your profile data is ready.')}
                                </div>
                            )}
                        </section>

                        <RecentGamesSection
                            profileId={account.id}
                            recentGames={recentGames}
                            isLoading={isRecentGamesLoading}
                            errorMessage={recentGamesErrorMessage}
                            isPublicView={isPublicView}
                        />

                        {isBotProfile && (botsListing !== null || houseBot !== null) ? (
                            <BotProfileSection
                                listing={profileBotListing}
                                houseBot={houseBot}
                                stats={botStats}
                            />
                        ) : null}

                        {isBotProfile && ownedBotEntry ? (
                            <BotTokenPanel bot={ownedBotEntry} />
                        ) : null}

                        {account && ownedBots.length > 0 ? (
                            <OwnedBotsSection
                                bots={ownedBots}
                                isOwner={isOwnProfile}
                            />
                        ) : null}

                        {isOwnProfile && account ? <AccountBotsCard /> : null}
                    </div>
                )}
            </div>

            {account && canChallenge ? (
                <ChallengeDialog
                    isOpen={isChallenging}
                    onClose={() => setIsChallenging(false)}
                    target={account}
                    ownBots={ownBots ?? []}
                    houseBot={houseBot}
                />
            ) : null}

            {account && isPlaying ? (
                <CreateLobbyDialog
                    isOpen
                    onClose={() => setIsPlaying(false)}
                    account={viewerAccount}
                    houseBots={houseBot ? { bots: [houseBot], available: profileBotListing?.openForChallenges ?? true } : null}
                    ownBots={ownBots}
                    onlineBots={botsListing?.filter((listing) => listing.online) ?? null}
                    initialOpponent={houseBot
                        ? { kind: `house-bot`, profileId: account.id }
                        : { kind: `bot`, profileId: account.id }}
                    onCreateLobby={(request) => {
                        void hostGame(request).then((sessionId) => {
                            setIsPlaying(false);
                            joinSession(sessionId);
                        }).catch((error: unknown) => {
                            console.error(`Failed to create a lobby:`, error);
                            showErrorToast(error instanceof Error ? error.message : `Failed to create the game.`);
                        });
                    }}
                />
            ) : null}
        </PageCorpus>
    );
}

export default ProfileScreen;

type BotProfileSectionProps = {
    listing: BotListing | null
    houseBot: HouseBotListing | null
    stats: BotStats | null
};

/** What a bot is, beyond its name: who drives it, whether it is reachable, what it
 * declared about itself, and its record. Everything public, for every visitor. */
function BotProfileSection({ listing, houseBot, stats }: Readonly<BotProfileSectionProps>) {
    const { t } = useTranslation();
    const intlFormatProvider = useIntlFormatProvider();

    const driver = houseBot
        ? t('serverEngine', 'Server engine ({{engine}})', { engine: houseBot.engine })
        : t('itsOwnProcess', 'Its own process, over the bot API');
    const presence = listing?.online
        ? (listing.openForChallenges ? t('onlineOpen', 'Online, taking games') : t('online', 'Online'))
        : t('offline', 'Offline');

    return (
        <section className="mt-6 rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.72),rgba(15,23,42,0.5))] p-5">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-white">
                {t('botProfile', 'Bot Profile')}
            </h3>

            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('drivenBy', 'Driven by')}</dt>
                    <dd className="mt-1 text-slate-100">{driver}</dd>
                </div>
                <div>
                    <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('presence', 'Presence')}</dt>
                    <dd className="mt-1 text-slate-100">{presence}</dd>
                </div>
                {listing?.about ? (
                    <div className="sm:col-span-2">
                        <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('about', 'About')}</dt>
                        <dd className="mt-1 leading-6 text-slate-100">{listing.about}</dd>
                    </div>
                ) : null}
                {listing?.version ? (
                    <div>
                        <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('version', 'Version')}</dt>
                        <dd className="mt-1 text-slate-100">{listing.version}</dd>
                    </div>
                ) : null}
                {listing?.repoUrl ? (
                    <div>
                        <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('sourceCode', 'Source')}</dt>
                        <dd className="mt-1 truncate">
                            <a className="text-sky-200 underline underline-offset-2" href={listing.repoUrl} target="_blank" rel="noreferrer">{listing.repoUrl}</a>
                        </dd>
                    </div>
                ) : null}
                {listing?.accepts ? (
                    <div className="sm:col-span-2">
                        <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('acceptsClocks', 'Accepts')}</dt>
                        <dd className="mt-1 text-slate-100">{acceptsLabel(t, listing.accepts)}</dd>
                    </div>
                ) : null}
            </dl>

            {stats ? (
                <div className="mt-5 border-t border-white/10 pt-4">
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-slate-100">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-400">{t('record', 'Record')}</span>
                        <span>{stats.overall.wins}–{stats.overall.losses}–{stats.overall.draws}</span>
                        <span className="text-slate-400">
                            {t('botGamesCount', '{{count}} games', { count: stats.overall.games })}
                        </span>
                        {stats.medianThinkMs !== null ? (
                            <span className="text-slate-400">
                                {t('medianThinkTime', 'median think {{seconds}}s', { seconds: (stats.medianThinkMs / 1000).toFixed(1) })}
                            </span>
                        ) : null}
                        {stats.lastSeenAt !== null ? (
                            <span className="text-slate-400">
                                {t('lastSeen', 'Last Seen')} {formatCalendarDate(intlFormatProvider, stats.lastSeenAt)}
                            </span>
                        ) : null}
                    </div>

                    {Object.keys(stats.lossesByReason).length > 0 ? (
                        <p className="mt-2 text-xs text-slate-400">
                            {t('lossesByReason', 'Losses by reason: {{reasons}}', {
                                reasons: Object.entries(stats.lossesByReason)
                                    .map(([reason, count]) => `${reason} × ${count}`)
                                    .join(`, `),
                            })}
                        </p>
                    ) : null}

                    {stats.vsBotByOpponent.length > 0 ? (
                        <div className="mt-3">
                            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                                {t('vsBotsRecord', 'vs bots')}
                            </p>
                            <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-100">
                                {stats.vsBotByOpponent.map((entry) => (
                                    <li key={entry.opponent} className="flex items-baseline justify-between gap-4">
                                        <span className="truncate">{entry.opponent}</span>
                                        <span className="shrink-0 text-slate-400">
                                            {entry.record.wins}–{entry.record.losses}–{entry.record.draws}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

function acceptsLabel(t: TFunction, accepts: NonNullable<BotListing[`accepts`]>): string {
    const parts: string[] = [];
    if (accepts.turnMs !== null) {
        parts.push(`${accepts.turnMs[0] / 1000}s–${accepts.turnMs[1] / 1000}s ${t('perTurn', 'per turn')}`);
    }
    if (accepts.match) {
        parts.push(t('matchClocks', 'match clocks'));
    }
    if (accepts.unlimited) {
        parts.push(t('unlimitedClocks', 'unlimited'));
    }

    return parts.length > 0 ? parts.join(`, `) : t('nothingDeclared', 'Nothing declared');
}

type OwnedBotsSectionProps = {
    bots: BotListing[]
    isOwner: boolean
};

/** Whose bots these are: public on the owner's profile, controls only for the owner. */
function OwnedBotsSection({ bots, isOwner }: Readonly<OwnedBotsSectionProps>) {
    const { t } = useTranslation();

    if (isOwner) {
        /* The owner gets the management card below instead: one list, with controls. */
        return null;
    }

    return (
        <section className="mt-6 rounded-[1.6rem] border border-white/10 bg-slate-950/45 p-5">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-white">
                {t('botsSection', 'Bots')}
            </h3>
            <ul className="mt-3 flex flex-col gap-2 text-sm text-slate-100">
                {bots.map((bot) => (
                    <li key={bot.profileId} className="flex items-center justify-between gap-3">
                        <Link className="truncate underline-offset-2 hover:underline" to={`/profile/${bot.profileId}`}>
                            {bot.displayName}
                        </Link>
                        <span className={`shrink-0 text-xs uppercase tracking-[0.16em] ${bot.online ? `text-emerald-200` : `text-slate-500`}`}>
                            {bot.online ? t('online', 'Online') : t('offline', 'Offline')}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}
