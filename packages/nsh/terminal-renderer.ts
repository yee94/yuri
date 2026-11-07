/** Current Host's complete terminal palette is passed to the fixed native document.
 * The production renderer is NativeTerminalDocument in ios/NativeTerminalPreview.swift,
 * not an NSH WebView or a JavaScript-supplied HTML document. */
type TerminalANSIColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite';
export type TerminalPalette = { background: string; foreground: string; cursor: string; selectionBackground: string }
  & Partial<Record<TerminalANSIColor | 'cursorAccent' | 'selectionForeground', string>>;
