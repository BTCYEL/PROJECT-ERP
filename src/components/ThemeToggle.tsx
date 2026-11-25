import React from 'react';
import { Contrast, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme.ts';

interface Props {
  variant?: 'header' | 'full' | 'compact';
  className?: string;
}

export function ThemeToggle({ variant = 'header', className = '' }: Props) {
  const { isDark, highContrast, toggleTheme, toggleHighContrast } = useTheme();

  if (variant === 'full') {
    return (
      <div
        role="group"
        aria-label="Display Theme and Outdoor Contrast"
        className={`flex flex-wrap items-center gap-2 ${className}`}
      >
        <button
          type="button"
          onClick={toggleTheme}
          aria-pressed={isDark}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            isDark
              ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
              : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
          }`}
        >
          {isDark ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-slate-700" />}
          <span>{isDark ? 'Light Mode' : 'Dark Mode'}</span>
        </button>

        <button
          type="button"
          onClick={toggleHighContrast}
          aria-pressed={highContrast}
          aria-label={highContrast ? 'Disable outdoor high-contrast mode' : 'Enable outdoor high-contrast mode'}
          title="Boost contrast for bright outdoor sunlight"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            highContrast
              ? 'border-amber-500 bg-amber-500 text-slate-950 hover:bg-amber-400'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
          }`}
        >
          <Contrast className="w-3.5 h-3.5" />
          <span>Outdoor High Contrast</span>
        </button>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Theme and Outdoor High Contrast"
      className={`inline-flex items-center gap-1 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0 ${className}`}
    >
      <button
        type="button"
        onClick={toggleTheme}
        aria-pressed={isDark}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 shadow-xs"
      >
        {isDark ? (
          <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        ) : (
          <Moon className="w-3.5 h-3.5 text-slate-700 shrink-0" />
        )}
        <span className={variant === 'compact' ? 'sr-only' : 'hidden xl:inline'}>
          {isDark ? 'Light' : 'Dark'}
        </span>
      </button>

      <button
        type="button"
        onClick={toggleHighContrast}
        aria-pressed={highContrast}
        aria-label={highContrast ? 'Disable outdoor high-contrast mode' : 'Enable outdoor high-contrast mode'}
        title={
          highContrast
            ? 'Outdoor High Contrast ON (click to restore standard contrast)'
            : 'Enable Outdoor High Contrast for bright food truck sunlight'
        }
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
          highContrast
            ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-xs'
            : 'text-slate-700 dark:text-slate-200 hover:bg-white/80 dark:hover:bg-slate-900/70'
        }`}
      >
        <Contrast className="w-3.5 h-3.5 shrink-0" />
        <span className={variant === 'compact' ? 'sr-only' : 'hidden 2xl:inline'}>
          Outdoor HC
        </span>
      </button>
    </div>
  );
}
