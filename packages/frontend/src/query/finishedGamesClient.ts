import type { FinishedGameRecord, FinishedGamesPage } from '@ih3t/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { fetchJson } from './apiClient';
import { queryClient } from './queryClient';
import {
    FINISHED_GAMES_PAGE_SIZE,
    type FinishedGamesArchiveView,
    type FinishedGamesRatedFilter,
    type FinishedGamesVsFilter,
    queryKeys,
} from './queryDefinitions';


async function fetchFinishedGames(
    page: number,
    pageSize: number,
    baseTimestamp: number,
    view: FinishedGamesArchiveView,
    ratedFilter: FinishedGamesRatedFilter,
    vsFilter: FinishedGamesVsFilter,
) {
    const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        baseTimestamp: String(baseTimestamp),
    });
    if (view === `mine`) {
        params.set(`view`, view);
    }
    if (ratedFilter !== `all`) {
        params.set(`rated`, ratedFilter);
    }
    if (vsFilter !== `all`) {
        params.set(`vs`, vsFilter);
    }

    return await fetchJson<FinishedGamesPage>(`/api/finished-games?${params.toString()}`);
}

async function fetchFinishedGame(gameId: string) {
    return await fetchJson<FinishedGameRecord>(`/api/finished-games/${encodeURIComponent(gameId)}`);
}

async function fetchPublicProfileGames(profileId: string) {
    return await fetchJson<FinishedGamesPage>(`/api/profiles/${encodeURIComponent(profileId)}/games`);
}

export async function invalidateFinishedGames() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.finishedGames });
}

export function useQueryFinishedGames(
    page: number,
    baseTimestamp: number,
    view: FinishedGamesArchiveView,
    ratedFilter: FinishedGamesRatedFilter,
    vsFilter: FinishedGamesVsFilter = `all`,
    options?: { enabled?: boolean },
) {
    return useQuery({
        queryKey: queryKeys.finishedGamesPage(view, ratedFilter, vsFilter, page, FINISHED_GAMES_PAGE_SIZE, baseTimestamp),
        queryFn: () => fetchFinishedGames(page, FINISHED_GAMES_PAGE_SIZE, baseTimestamp, view, ratedFilter, vsFilter),
        placeholderData: keepPreviousData,
        enabled: options?.enabled,
        staleTime: 60 * 60 * 1000,
    });
}

export function useQueryFinishedGame(gameId: string | null, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.finishedGame(gameId),
        queryFn: () => {
            if (!gameId) {
                throw new Error(`Missing finished game id.`);
            }

            return fetchFinishedGame(gameId);
        },
        enabled: Boolean(gameId) && options?.enabled,
        staleTime: 60 * 60 * 1000,
    });
}

export function useQueryPublicProfileGames(profileId: string | null) {
    return useQuery({
        queryKey: queryKeys.profileRecentGames(profileId),
        queryFn: () => {
            if (!profileId) {
                throw new Error(`Missing profile id.`);
            }

            return fetchPublicProfileGames(profileId);
        },
        enabled: Boolean(profileId),
        staleTime: 60 * 1000,
    });
}
