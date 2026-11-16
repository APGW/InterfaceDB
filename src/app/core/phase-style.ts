import type { Phase } from './live.models';

/** Shared conductor styling for every dashboard visualization. */
export const PHASE_COLORS: Readonly<Record<Phase, string>> = {
  L1: '#38bdf8',
  L2: '#a78bfa',
  L3: '#2dd4bf',
};

export const PHASE_SYMBOLS: Readonly<Record<Phase, 'circle' | 'diamond' | 'triangle'>> = {
  L1: 'circle',
  L2: 'diamond',
  L3: 'triangle',
};
