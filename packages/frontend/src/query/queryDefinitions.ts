import {
    FINISHED_GAMES_PAGE_SIZE,
    type FinishedGamesArchiveView,
    type FinishedGamesVsFilter,
    queryKeys,
} from '@ih3t/shared';

import type { RatedFilter } from '../utils/ratedFilter';

export {
    FINISHED_GAMES_PAGE_SIZE,
    queryKeys,
};

export type FinishedGamesRatedFilter = RatedFilter;
export type { FinishedGamesVsFilter };
export type { FinishedGamesArchiveView };
