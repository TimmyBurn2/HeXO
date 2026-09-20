import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { FinishedGamesVsFilter } from '@ih3t/shared';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from './ui/button-group';

export const vsFilterOptions: { value: FinishedGamesVsFilter, label: (t: TFunction) => string }[] = [
    { value: `all`, label: (t) => t('allGames', 'All') },
    { value: `humans`, label: (t) => t('vsHumans', 'vs Humans') },
    { value: `bots`, label: (t) => t('vsBots', 'vs Bots') },
];

type VsFilterTabsProps = {
    value: FinishedGamesVsFilter
    onChange: (value: FinishedGamesVsFilter) => void
};

/** The history's opponent filter: every game, or only those with/without a bot seat. */
export default function VsFilterTabs({
    value,
    onChange,
}: Readonly<VsFilterTabsProps>) {
    const { t } = useTranslation();
    return (
        <ButtonGroup>
            {vsFilterOptions.map((filterOption) => {
                const isActive = value === filterOption.value;
                return (
                    <Button
                        key={filterOption.value}
                        type="button"
                        variant="filter"
                        size="sm"
                        aria-pressed={isActive}
                        onClick={() => onChange(filterOption.value)}
                    >
                        {filterOption.label(t)}
                    </Button>
                );
            })}
        </ButtonGroup>
    );
}
