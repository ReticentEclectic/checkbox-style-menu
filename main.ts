import { Plugin, MarkdownView, Menu, Editor } from 'obsidian';
import { EditorView } from '@codemirror/view';

interface CodeMirrorEditor extends Editor {
    cm?: EditorView;
}

export default class CheckboxStyleMenuPlugin extends Plugin {
    private checkboxStyles = [
        { symbol: ' ', description: 'To-do', icon: 'circle' },
        { symbol: '/', description: 'Incomplete', icon: 'clock' },
        { symbol: 'x', description: 'Done', icon: 'check' },
        { symbol: '-', description: 'Canceled', icon: 'x' },
    ];
    private longPressDuration = 500;

    async onload() {
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                console.log('Active leaf changed');
                // Only reset state if no long-press is in progress
                if (!this.timer) {
                    this.resetState();
                }
            })
        );
    }

    private timer: NodeJS.Timeout | null = null;
    private isLongPress: boolean = false;
    private lastMouseDownEvent: MouseEvent | null = null;
    private targetView: MarkdownView | null = null;

    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (target.matches('.task-list-item-checkbox')) {
            console.log('Mousedown on checkbox detected');
            this.lastMouseDownEvent = event;

            // Find the MarkdownView for the leaf containing the checkbox
            const leafEl = target.closest('.workspace-leaf');
            if (leafEl) {
                const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => (l as any).containerEl === leafEl);
                this.targetView = leaf?.view as MarkdownView | null;
                console.log('Target view set:', this.targetView ? 'Found' : 'Not found');
            } else {
                console.warn('No workspace leaf found for checkbox');
                this.targetView = null;
            }

            this.timer = setTimeout(() => {
                this.isLongPress = true;
                this.showStyleMenu(event, target);
                event.preventDefault(); // Prevent default toggle on long-press
            }, this.longPressDuration);
        }
    }

    private handleMouseUp(event: MouseEvent) {
        if (this.timer) {
            clearTimeout(this.timer);
            console.log('Timer cleared in handleMouseUp');
        }
        if (this.isLongPress) {
            this.isLongPress = false;
            console.log('isLongPress reset in handleMouseUp');
        }
    }

    private resetState() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.isLongPress = false;
        this.lastMouseDownEvent = null;
        this.targetView = null;
        console.log('Plugin state reset');
    }

    private showStyleMenu(event: MouseEvent, checkbox: HTMLElement) {
        // Use the stored target view, falling back to active view
        const view = this.targetView || this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            console.error('No active Markdown view found');
            this.resetState();
            return;
        }

        const editor = view.editor as CodeMirrorEditor;
        if (!editor.cm) {
            console.error('No CodeMirror instance found');
            this.resetState();
            return;
        }

        const pos = editor.cm.posAtDOM(checkbox);
        if (pos === null || pos < 0 || pos > editor.cm.state.doc.length) {
            console.error('Invalid position from posAtDOM:', pos);
            this.resetState();
            return;
        }

        const line = editor.cm.state.doc.lineAt(pos);
        const lineNumber = line.number - 1; // Convert to 0-based
        const text = line.text;

        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            this.resetState();
            return;
        }

        const menu = new Menu();
        this.checkboxStyles.forEach(style => {
            menu.addItem(item =>
                item
                    .setTitle(`[${style.symbol}] ${style.description}`)
                    .setIcon(style.icon)
                    .onClick(() => {
                        console.log(`Applying symbol '${style.symbol}'`);
                        this.applyCheckboxStyle(editor, pos, style.symbol);
                        menu.hide();
                        this.simulateMouseUp(event);
                    })
            );
        });
        menu.showAtMouseEvent(event);
    }

    private simulateMouseUp(event: MouseEvent) {
        const mouseUpEvent = new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: event.clientX,
            clientY: event.clientY,
        });
        event.target?.dispatchEvent(mouseUpEvent);
        console.log('Simulated mouseup event dispatched');
    }

    private isCheckboxLine(line: string): boolean {
        const isValid = /^\s*-\s*\[[ \/\-x]\]\s*(.*)?$/.test(line);
        console.log(`Checking line: "${line}" -> Valid: ${isValid}`);
        return isValid;
    }

    private applyCheckboxStyle(editor: CodeMirrorEditor, pos: number, symbol: string) {
        if (!editor.cm) {
            console.error('No CodeMirror instance found');
            return;
        }

        const line = editor.cm.state.doc.lineAt(pos);
        const lineNumber = line.number - 1; // Convert to 0-based
        const text = line.text;

        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            return;
        }

        const match = text.match(/-\s*\[(.)\]/);
        if (!match) {
            console.error('No checkbox pattern found in line');
            return;
        }

        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const endIndex = startIndex + 1;
        console.log(`Replacing symbol at line ${lineNumber}, ch ${startIndex}-${endIndex} with '${symbol}'`);
        editor.replaceRange(symbol, { line: lineNumber, ch: startIndex }, { line: lineNumber, ch: endIndex });
        console.log('Symbol replacement executed');
    }
}