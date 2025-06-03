import { Plugin, MarkdownView, Editor } from 'obsidian';
import { EditorView } from '@codemirror/view';

interface CodeMirrorEditor extends Editor {
    cm?: EditorView;
}

export default class CheckboxStyleMenuPlugin extends Plugin {
    private checkboxStyles = [
        { symbol: ' ', description: 'To-do' },
        { symbol: '/', description: 'Incomplete' },
        { symbol: 'x', description: 'Done' },
        { symbol: '-', description: 'Cancelled' },
    ];
    private longPressDuration = 500; // half-second for menu call
    private menuTimeoutDuration = 2000; // 2 seconds for menu dismissal
    private menuElement: HTMLElement | null = null;
    private overlayElement: HTMLElement | null = null;
    private menuTimeout: NodeJS.Timeout | null = null;

    async onload() {
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                console.log('Active leaf changed');
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

            // Try to find the active MarkdownView first
            this.targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!this.targetView) {
                // Fallback: search all markdown leaves
                const leafEl = target.closest('.workspace-leaf');
                if (leafEl) {
                    const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.containerEl.contains(leafEl));
                    this.targetView = leaf?.view as MarkdownView | null;
                }
            }
            console.log('Target view set:', this.targetView ? 'Found' : 'Not found');
            if (!this.targetView) {
                console.warn('No Markdown view found for checkbox');
                return;
            }

            this.timer = setTimeout(() => {
                this.isLongPress = true;
                this.showStyleMenu(event, target);
                event.preventDefault();
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
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
        this.isLongPress = false;
        this.lastMouseDownEvent = null;
        this.targetView = null;
        this.hideMenu();
        console.log('Plugin state reset');
    }

    private async showStyleMenu(event: MouseEvent, checkbox: HTMLElement) {
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
        const lineNumber = line.number - 1;
        const text = line.text;

        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            this.resetState();
            return;
        }

        this.hideMenu();

        // Create overlay to block interactions with checkbox
        const checkboxRect = checkbox.getBoundingClientRect();
        this.overlayElement = document.createElement('div');
        Object.assign(this.overlayElement.style, {
            position: 'fixed',
            top: `${checkboxRect.top}px`,
            left: `${checkboxRect.left}px`,
            width: `${checkboxRect.width}px`,
            height: `${checkboxRect.height}px`,
            zIndex: '998', // Below menu (zIndex: 1000)
            background: 'rgba(255, 0, 0, 0.5)', // Visible for testing
        });
        this.overlayElement.addEventListener('mouseup', (e) => {
            console.log('Blocking mouseup on checkbox overlay');
            e.preventDefault();
            e.stopPropagation();
        });
        this.overlayElement.addEventListener('click', (e) => {
            console.log('Blocking click on checkbox overlay');
            e.preventDefault();
            e.stopPropagation();
        });
        this.overlayElement.addEventListener('mouseleave', () => {
            console.log('Cursor left checkbox overlay, starting dismiss timer');
            this.startDismissTimeout();
        });
        this.overlayElement.addEventListener('mouseenter', () => {
            console.log('Cursor entered checkbox overlay, clearing dismiss timer');
            if (this.menuTimeout) {
                clearTimeout(this.menuTimeout);
                this.menuTimeout = null;
            }
        });
        document.body.appendChild(this.overlayElement);

        this.menuElement = document.createElement('div');
        this.menuElement.className = 'checkbox-style-menu markdown-source-view cm-s-obsidian';
        this.menuElement.setAttribute('role', 'menu');
        Object.assign(this.menuElement.style, {
            position: 'absolute',
            background: 'var(--background-primary)',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            padding: '4px 0',
            zIndex: '1000',
            boxShadow: '0 2px 8px var(--background-modifier-box-shadow)',
            display: 'flex',
            flexDirection: 'column',
        });

        for (const style of this.checkboxStyles) {
            const item = document.createElement('div');
            item.className = 'checkbox-style-menu-item';
            item.setAttribute('role', 'menuitem');
            Object.assign(item.style, {
                padding: '5px 4px',
                cursor: 'pointer',
                color: 'var(--text-normal)',
                fontSize: 'var(--font-ui-small)',
                display: 'flex',
                alignItems: 'center',
                position: 'relative',
            });

            const checkboxSpan = document.createElement('span');
            checkboxSpan.className = 'cm-formatting-task';
            checkboxSpan.setAttribute('data-task', style.symbol);
            checkboxSpan.textContent = `[${style.symbol}]`;
            item.appendChild(checkboxSpan);

            const tooltip = document.createElement('span');
            tooltip.textContent = style.description;
            tooltip.className = 'tooltip';
            tooltip.style.cssText = `
                visibility: hidden;
                background: var(--background-secondary);
                color: var(--text-normal);
                padding: 4px 8px;
                border-radius: 4px;
                position: absolute;
                zIndex: 1001;
                left: calc(100% + 8px);
                top: 50%;
                transform: translateY(-50%);
                opacity: 0;
                transition: opacity 0.2s;
                white-space: nowrap;
                text-align: center;
            `;
            item.appendChild(tooltip);

            item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--background-modifier-hover)';
                setTimeout(() => {
                    if (item.matches(':hover')) {
                        tooltip.style.visibility = 'visible';
                        tooltip.style.opacity = '1';
                    }
                }, 1000); // 1-second hover delay for tooltip
                console.log('Cursor entered menu item, clearing dismiss timer');
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                }
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = '';
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
                console.log('Cursor left menu item, starting dismiss timer');
                this.startDismissTimeout();
            });
            item.addEventListener('mouseup', () => {
                console.log(`Applying symbol '${style.symbol}'`);
                this.applyCheckboxStyle(editor, pos, style.symbol);
                this.hideMenu();
            });

            if (this.menuElement) {
                this.menuElement.appendChild(item);
            } else {
                console.error('Menu element is null during item append');
            }
        }

        const container = view.containerEl.querySelector('.markdown-source-view');
        if (!container) {
            console.error('Markdown source view not found');
            this.resetState();
            return;
        }
        const editorRect = container.getBoundingClientRect();

        const menuWidth = 30; // Original fixed width for positioning calculation
        const menuHeight = this.checkboxStyles.length * 32 + 8;
        let left = checkboxRect.left - editorRect.left - menuWidth - 5;
        if (left < 0) {
            left = checkboxRect.right - editorRect.left + 5;
        }
        let top = checkboxRect.top - editorRect.top;

        if (top + menuHeight > editorRect.height) {
            top = editorRect.height - menuHeight;
        }
        if (top < 0) {
            top = 0;
        }

        Object.assign(this.menuElement.style, {
            left: `${left}px`,
            top: `${top}px`,
        });

        const closeOnClickOutside = (e: MouseEvent) => {
            if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
                console.log('Mouse down outside menu detected, hiding menu immediately');
                this.hideMenu();
                document.removeEventListener('mousedown', closeOnClickOutside);
            }
        };
        document.addEventListener('mousedown', closeOnClickOutside);

        if (this.menuElement) {
            container.appendChild(this.menuElement);
        }
    }

    private startDismissTimeout() {
        if (this.menuTimeout) clearTimeout(this.menuTimeout);
        this.menuTimeout = setTimeout(() => {
            this.hideMenu();
            this.menuTimeout = null;
        }, this.menuTimeoutDuration);
    }

    private hideMenu() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
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
        const lineNumber = line.number - 1;
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