import { THEMES, useTheme } from '../theme/theme.ts';

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className="segmented-option" onClick={() => setTheme(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
