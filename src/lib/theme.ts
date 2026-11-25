import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

export interface ThemeState {
  theme: ThemeMode;
  highContrast: boolean;
}

const THEME_STORAGE_KEY = 'maximus_bbq_theme';
const HIGH_CONTRAST_STORAGE_KEY = 'maximus_bbq_high_contrast';

function readStoredThemeState(): ThemeState {
  if (typeof window === 'undefined') {
    return { theme: 'light', highContrast: false };
  }
  try {
    const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const theme: ThemeMode = rawTheme === 'dark' ? 'dark' : 'light';
    const highContrast = window.localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === '1';
    return { theme, highContrast };
  } catch {
    return { theme: 'light', highContrast: false };
  }
}

export function applyThemeToDocument(state: ThemeState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(state.theme);
  root.classList.toggle('high-contrast', state.highContrast);
  root.dataset.theme = state.theme;
  root.dataset.contrast = state.highContrast ? 'high' : 'standard';
  root.style.colorScheme = state.theme;
}

let currentThemeState: ThemeState = readStoredThemeState();
applyThemeToDocument(currentThemeState);

const listeners = new Set<(state: ThemeState) => void>();

function updateThemeState(next: ThemeState, persist = true): void {
  currentThemeState = next;
  applyThemeToDocument(next);
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next.theme);
      window.localStorage.setItem(HIGH_CONTRAST_STORAGE_KEY, next.highContrast ? '1' : '0');
    } catch {
      // ignore storage failure in private browsing
    }
  }
  listeners.forEach((listener) => listener(next));
}

export function getThemeState(): ThemeState {
  return currentThemeState;
}

export function setThemeMode(theme: ThemeMode): void {
  updateThemeState({ ...currentThemeState, theme });
}

export function toggleThemeMode(): ThemeMode {
  const nextTheme: ThemeMode = currentThemeState.theme === 'dark' ? 'light' : 'dark';
  updateThemeState({ ...currentThemeState, theme: nextTheme });
  return nextTheme;
}

export function setHighContrastMode(highContrast: boolean): void {
  updateThemeState({ ...currentThemeState, highContrast });
}

export function toggleHighContrastMode(): boolean {
  const next = !currentThemeState.highContrast;
  updateThemeState({ ...currentThemeState, highContrast: next });
  return next;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === HIGH_CONTRAST_STORAGE_KEY) {
      updateThemeState(readStoredThemeState(), false);
    }
  });
}

export function useTheme() {
  const [state, setState] = useState<ThemeState>(() => currentThemeState);

  useEffect(() => {
    const handler = (next: ThemeState) => setState(next);
    listeners.add(handler);
    setState(currentThemeState);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return {
    theme: state.theme,
    isDark: state.theme === 'dark',
    highContrast: state.highContrast,
    setTheme: setThemeMode,
    toggleTheme: toggleThemeMode,
    setHighContrast: setHighContrastMode,
    toggleHighContrast: toggleHighContrastMode,
  };
}
