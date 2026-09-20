import type { HouseBotListing } from '@ih3t/shared';
import { formatThinkSeconds } from '@ih3t/shared';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/* The custom-strength slider's ladder, cut to what the chosen bot's engine allows. */
const THINK_TIME_LADDER_MS = [
    10, 20, 50, 100, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000,
] as const;

/* Preset ids the server may send; anything else is shown by its think time alone. */
const strengthPresetLabels: Record<string, (t: TFunction) => string> = {
    beginner: (t) => t('beginner', 'Beginner'),
    easy: (t) => t('easy', 'Easy'),
    medium: (t) => t('medium', 'Medium'),
    hard: (t) => t('hard', 'Hard'),
    expert: (t) => t('expert', 'Expert'),
};

function thinkTimeSteps(bot: HouseBotListing): number[] {
    const steps = THINK_TIME_LADDER_MS.filter((step) => step >= bot.thinkMs.min && step <= bot.thinkMs.max);
    return steps.length > 0 ? steps : [bot.thinkMs.default];
}

function nearestStepIndex(steps: readonly number[], thinkMs: number): number {
    let best = 0;
    for (let index = 1; index < steps.length; index += 1) {
        if (Math.abs(steps[index] - thinkMs) < Math.abs(steps[best] - thinkMs)) {
            best = index;
        }
    }

    return best;
}

type HouseBotStrengthPickerProps = {
    /** The house bot being played; its engine's range and presets drive the picker. */
    bot: HouseBotListing
    /** The chosen think time, in milliseconds; the state stays with the caller. */
    thinkMs: number
    onChange: (thinkMs: number) => void
};

/**
 * The strength a house bot is played at, wherever it is picked: the lobby dialog, a
 * challenge. Preset chips plus a custom slider bounded by the engine's range, the
 * same markup in every dialog. Remount (a `key`) to reset the custom choice.
 */
function HouseBotStrengthPicker({ bot, thinkMs, onChange }: Readonly<HouseBotStrengthPickerProps>) {
    const { t } = useTranslation();
    const [customStrength, setCustomStrength] = useState(false);
    const strengthSteps = thinkTimeSteps(bot);
    const selectedPreset = !customStrength
        ? bot.presets.find((preset) => preset.thinkMs === thinkMs) ?? null
        : null;
    const presetLabel = (id: string) => strengthPresetLabels[id]?.(t) ?? null;

    return (
        <div className="mt-2.5 rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    {t('strength', 'Strength')}
                </div>

                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                    {selectedPreset
                        ? presetLabel(selectedPreset.id) && <span>{presetLabel(selectedPreset.id)}</span>
                        : <span>{t('custom', 'Custom')}</span>}
                    <span>{formatThinkSeconds(thinkMs)}</span>
                </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('strength', 'Strength')}>
                {bot.presets.map((preset) => {
                    const active = selectedPreset?.id === preset.id;
                    const label = presetLabel(preset.id);

                    return (
                        <button
                            key={preset.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                                setCustomStrength(false);
                                onChange(preset.thinkMs);
                            }}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${active
                                ? `border-sky-300/35 bg-sky-300/15 text-white`
                                : `border-white/10 bg-white/6 text-slate-200 hover:border-white/20 hover:bg-white/10`}`}
                        >
                            {label ? `${label} · ` : ``}{formatThinkSeconds(preset.thinkMs)}
                        </button>
                    );
                })}

                {strengthSteps.length > 1 && (
                <button
                    type="button"
                    aria-pressed={customStrength}
                    onClick={() => setCustomStrength(true)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${customStrength
                        ? `border-sky-300/35 bg-sky-300/15 text-white`
                        : `border-white/10 bg-white/6 text-slate-200 hover:border-white/20 hover:bg-white/10`}`}
                >
                    {t('custom', 'Custom')}
                </button>
                )}
            </div>

            {customStrength && strengthSteps.length > 1 && (
                <div className="mt-2.5 space-y-1.5">
                    <input
                        type="range"
                        min={0}
                        max={strengthSteps.length - 1}
                        step={1}
                        value={nearestStepIndex(strengthSteps, thinkMs)}
                        aria-label={t('thinkTimePerTurn', 'Think time per turn')}
                        onChange={(event) => onChange(strengthSteps[Number(event.target.value)])}
                        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-sky-300"
                    />

                    <div className="flex justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                        <span>{formatThinkSeconds(strengthSteps[0])}</span>
                        <span>{formatThinkSeconds(strengthSteps[strengthSteps.length - 1])}</span>
                    </div>
                </div>
            )}

            <div className="mt-2 text-[11px] leading-4.5 text-slate-300">
                {t('theLongerItThinksTheDeeperItSearches', 'The longer it thinks per turn, the deeper it searches. Games against it are unrated.')}
            </div>
        </div>
    );
}

export default HouseBotStrengthPicker;
