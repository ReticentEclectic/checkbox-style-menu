/** Resolve only tasks with a unique source line inside the renderer's section. */
export function resolveTaskLine(
    lines: string[], section: { lineStart: number; lineEnd: number },
    renderedLine: string | null, renderedText: string
): number | null {
    if (renderedLine === null || !/^\d+$/.test(renderedLine)) return null;
    const n = Number(renderedLine);
    const candidates = new Set([n, section.lineStart + n]);
    const matches = [...candidates].filter(i =>
        i >= section.lineStart && i <= section.lineEnd &&
        /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/.test(lines[i] ?? '')
    );
    if (matches.length === 1) return matches[0];
    const sameText = matches.filter(i =>
        (lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/)?.[2] ?? '').trim() === renderedText.trim()
    );
    return sameText.length === 1 ? sameText[0] : null;
}

/** Replace a symbol only while the rendered source line is still identical. */
export function replaceTaskSymbol(data: string, lineNumber: number, original: string, symbol: string): string {
    const lines = data.split('\n');
    if (lines[lineNumber] !== original) return data;
    const match = original.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/);
    if (!match) return data;
    lines[lineNumber] = match[1] + symbol + match[3];
    return lines.join('\n');
}
