/** Android shell hooks. In a browser nothing here runs and @capacitor/core is never fetched. */

export function themeToBarStyle(theme: string | undefined): 'DARK' | 'LIGHT' {
  // Silent Black needs light bar icons (Capacitor calls that style DARK); Paper needs dark icons.
  return theme === 'black' ? 'DARK' : 'LIGHT';
}

export async function startNativeShell(): Promise<void> {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
  const root = document.documentElement;
  const apply = () => {
    const style = themeToBarStyle(root.dataset['theme']) === 'DARK' ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
    void SystemBars.setStyle({ style }).catch(() => {});
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}
