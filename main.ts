import { Plugin, MarkdownView, Editor, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting } from 'obsidian';
import { EditorView } from '@codemirror/view';

// Extend Editor interface to include CodeMirror instance
interface CodeMirrorEditor extends Editor {
    cm?: EditorView;
}

// Define settings interface
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };
}

// Default settings
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: {
        ' ': true,
        '/': true,
        'x': true,
        '-': true,
        '>': false,
        '<': false,
        '?': false,
        '!': false,
        '*': false,
        '"': false,
        'l': false,
        'b': false,
        'i': false,
        'S': false,
        'I': false,
        'p': false,
        'c': false,
        'f': false,
        'k': false,
        'w': false,
        'u': false,
        'd': false,
    },
};

export default class CheckboxStyleMenuPlugin extends Plugin {
    settings: CheckboxStyleSettings;

    // Define available checkbox styles
    public checkboxStyles = [
        { symbol: ' ', description: 'To-do', enabled: true },
        { symbol: '/', description: 'Incomplete', enabled: true },
        { symbol: 'x', description: 'Done', enabled: true },
        { symbol: '-', description: 'Cancelled', enabled: true },
        { symbol: '>', description: 'Forwarded', enabled: false },
        { symbol: '<', description: 'Scheduling', enabled: false },
        { symbol: '?', description: 'Question', enabled: false },
        { symbol: '!', description: 'Important', enabled: false },
        { symbol: '*', description: 'Star', enabled: false },
        { symbol: '"', description: 'Quote', enabled: false },
        { symbol: 'l', description: 'Location', enabled: false },
        { symbol: 'b', description: 'Bookmark', enabled: false },
        { symbol: 'i', description: 'Information', enabled: false },
        { symbol: 'S', description: 'Savings', enabled: false },
        { symbol: 'I', description: 'Idea', enabled: false },
        { symbol: 'p', description: 'Pro', enabled: false },
        { symbol: 'c', description: 'Con', enabled: false },
        { symbol: 'f', description: 'Fire', enabled: false },
        { symbol: 'k', description: 'Key', enabled: false },
        { symbol: 'w', description: 'Win', enabled: false },
        { symbol: 'u', description: 'Up', enabled: false },
        { symbol: 'd', description: 'Down', enabled: false },
    ];
    private longPressDuration = 500; // Duration in ms for long press to trigger menu
    private menuTimeoutDuration = 2000; // Duration in ms before menu auto-dismisses
    private menuElement: HTMLElement | null = null; // Menu container element
    private overlayElement: HTMLElement | null = null; // Overlay to block checkbox interactions
    private menuTimeout: NodeJS.Timeout | null = null; // Timeout for menu dismissal
    private scrollListener: (() => void) | null = null; // Store scroll listener for cleanup

    // Plugin initialization
    async onload() {
        // Load settings
        await this.loadSettings();
        // Initialize enabled states based on settings
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol];
        });

        // Register event listeners for mouse interactions
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));
        // Reset state when active leaf changes, unless a timer is active
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                console.log('Active leaf changed');
                if (!this.timer) {
                    this.resetState();
                }
            })
        );

        // Add settings tab
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));
    }

    // Save settings
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Load settings
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    // State variables for long press detection
    private timer: NodeJS.Timeout | null = null;
    private isLongPress: boolean = false;
    private lastMouseDownEvent: MouseEvent | null = null;
    private targetView: MarkdownView | null = null;

    // Handle mouse down event to detect long press on checkboxes
    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (target.matches('.task-list-item-checkbox')) {
            console.log('Mousedown on checkbox detected');
            this.lastMouseDownEvent = event;

            // Attempt to find the active MarkdownView
            this.targetView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!this.targetView) {
                // Fallback: search all markdown leaves if active view not found
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

            // Set timer for long press
            this.timer = setTimeout(() => {
                this.isLongPress = true;
                this.showStyleMenu(event, target);
                event.preventDefault();
            }, this.longPressDuration);
        }
    }

    // Handle mouse up to clear timer and reset long press state
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

    // Reset plugin state
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

    // Show the style menu when a checkbox is long-pressed
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

        // Get cursor position from DOM element
        const pos = editor.cm.posAtDOM(checkbox);
        if (pos === null || pos < 0 || pos > editor.cm.state.doc.length) {
            console.error('Invalid position from posAtDOM:', pos);
            this.resetState();
            return;
        }

        const line = editor.cm.state.doc.lineAt(pos);
        const lineNumber = line.number - 1;
        const text = line.text;

        // Verify the line is a checkbox
        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            this.resetState();
            return;
        }

        // Remove any existing menu and scroll listener
        this.hideMenu();

        // Create an overlay to prevent checkbox interaction
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

        // Create menu container
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'checkbox-style-menu markdown-source-view cm-s-obsidian';
        this.menuElement.setAttribute('role', 'menu');
        Object.assign(this.menuElement.style, {
            position: 'absolute',
            background: 'var(--background-primary)',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            zIndex: '1000',
            boxShadow: '0 2px 8px var(--background-modifier-box-shadow)',
            width: '30px', // Increased width for better centering
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '5px 0',
        });

        // Filter enabled styles
        const enabledStyles = this.checkboxStyles.filter(style => style.enabled);
        if (enabledStyles.length === 0) {
            console.warn('No enabled checkbox styles available');
            this.hideMenu();
            return;
        }

        // Generate markdown string for enabled checkbox styles
        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');

        // Render markdown directly into the menu container
        const renderChild = new MarkdownRenderChild(this.menuElement);
        this.addChild(renderChild);
        await MarkdownRenderer.render(
            this.app, // Pass the App instance
            markdown, // Markdown string
            this.menuElement, // Target element
            '', // sourcePath
            renderChild // Component
        );

        // Customize markdown preview to ensure centering
        const markdownPreview = this.menuElement.querySelector('.markdown-preview-view') as HTMLElement | null;
        if (markdownPreview) {
            Object.assign(markdownPreview.style, {
                margin: '0',
                padding: '0',
                width: '100%',
                boxSizing: 'border-box',
                display: 'flex',
                justifyContent: 'center',
            });
        }
        const ul = this.menuElement.querySelector('ul') as HTMLElement | null;
        if (ul) {
            Object.assign(ul.style, {
                listStyle: 'none',
                margin: '0',
                padding: '0',
                width: '100%',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
            });
        }

        // Make rendered checkboxes clickable and add tooltips
        const listItems = this.menuElement.querySelectorAll('li');
        listItems.forEach((li, index) => {
            Object.assign(li.style, {
                padding: '5px 0',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                position: 'relative',
                width: '100%',
                boxSizing: 'border-box',
            });

            // Center the checkbox within the list item
            const checkbox = li.querySelector('.task-list-item-checkbox') as HTMLElement | null;
            if (checkbox) {
                Object.assign(checkbox.style, {
                    margin: '0 auto',
                });
            }

            // Add tooltip
            const tooltip = document.createElement('span');
            tooltip.textContent = enabledStyles[index].description;
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
            li.appendChild(tooltip);

            // Add hover effects and tooltip behavior
            li.addEventListener('mouseenter', () => {
                li.style.background = 'var(--background-modifier-hover)';
                setTimeout(() => {
                    if (li.matches(':hover')) {
                        tooltip.style.visibility = 'visible';
                        tooltip.style.opacity = '1';
                    }
                }, 500); // half-second hover delay for tooltip
                console.log('Cursor entered menu item, clearing dismiss timer');
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                }
            });
            li.addEventListener('mouseleave', () => {
                li.style.background = '';
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
                console.log('Cursor left menu item, starting dismiss timer');
                this.startDismissTimeout();
            });

            // Add click event to apply style
            li.addEventListener('mouseup', () => {
                const symbol = enabledStyles[index].symbol;
                console.log(`Applying symbol '${symbol}'`);
                this.applyCheckboxStyle(editor, pos, symbol);
                this.hideMenu();
            });
        });

        // Position the menu relative to the checkbox
        const container = view.containerEl.querySelector('.markdown-source-view');
        if (!container) {
            console.error('Markdown source view not found');
            this.resetState();
            return;
        }
        const editorRect = container.getBoundingClientRect();
        const menuWidth = 30; // Updated to match new menu width
        const menuHeight = enabledStyles.length * 32 + 8; // Approximate height
        let left = checkboxRect.left - editorRect.left - menuWidth - 5;
        if (left < 0) {
            left = checkboxRect.right - editorRect.left + 5; // Position to the right if no space on left
        }
        let top = checkboxRect.top - editorRect.top;

        // Adjust vertical position if menu exceeds editor bounds
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

        // Handle clicks outside the menu to close it
        const closeOnClickOutside = (e: MouseEvent) => {
            if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
                console.log('Mouse down outside menu detected, hiding menu immediately');
                this.hideMenu();
                document.removeEventListener('mousedown', closeOnClickOutside);
            }
        };
        document.addEventListener('mousedown', closeOnClickOutside);

        // Add scroll event listener to CodeMirror's scrollDOM
        if (editor.cm && editor.cm.scrollDOM) {
            this.scrollListener = () => {
                console.log('Scroll event detected on CodeMirror scrollDOM, hiding menu immediately');
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                    console.log('Cleared menuTimeout in CodeMirror scroll handler');
                }
                this.hideMenu();
                editor.cm!.scrollDOM.removeEventListener('scroll', this.scrollListener!);
                this.scrollListener = null;
            };
            editor.cm.scrollDOM.addEventListener('scroll', this.scrollListener);
            console.log('Scroll listener attached to CodeMirror scrollDOM');
        }

        // Append menu to the editor container
        if (this.menuElement) {
            container.appendChild(this.menuElement);
        }
    }

    // Start timer to dismiss menu after inactivity
    private startDismissTimeout() {
        if (this.menuTimeout) clearTimeout(this.menuTimeout);
        this.menuTimeout = setTimeout(() => {
            console.log('Menu timeout triggered, hiding menu');
            this.hideMenu();
            this.menuTimeout = null;
        }, this.menuTimeoutDuration);
    }

    // Remove menu, overlay, and scroll listener from the DOM
    private hideMenu() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
        if (this.scrollListener && this.targetView && this.targetView.editor) {
            const editor = this.targetView.editor as CodeMirrorEditor;
            if (editor.cm && editor.cm.scrollDOM) {
                editor.cm.scrollDOM.removeEventListener('scroll', this.scrollListener);
                console.log('Scroll listener removed from CodeMirror scrollDOM');
            }
            this.scrollListener = null;
        }
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
            console.log('Cleared menuTimeout in hideMenu');
        }
        console.log('Menu and overlay removed');
    }

    // Check if a line is a valid checkbox line
    private isCheckboxLine(line: string): boolean {
        const isValid = /^\s*-\s*\[[ \/\-x><?!*\"lbiSIpcfkwud]\]\s*(.*)?$/.test(line);
        console.log(`Checking line: "${line}" -> Valid: ${isValid}`);
        return isValid;
    }

    // Apply selected checkbox style to the editor
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

        // Replace the checkbox symbol
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

// Settings tab
class CheckboxStyleSettingTab extends PluginSettingTab {
    plugin: CheckboxStyleMenuPlugin;
    private styleEl: HTMLStyleElement | null = null;

    constructor(app: App, plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Checkbox Style Menu Settings' });

        // Create a container for all toggles
        const toggleContainer = containerEl.createEl('div', {
            cls: 'checkbox-style-toggles',
        });

        // Add custom CSS to remove dividing lines and adjust styling
        this.styleEl = document.createElement('style');
        this.styleEl.textContent = `
            .checkbox-style-toggles .setting-item {
                border-top: none !important;
                padding: 0px 0;
                display: flex;
                align-items: center;
            }
            .checkbox-style-toggles .setting-item-name {
                margin-bottom: 0px;
                display: flex;
                align-items: center;
                gap: 0px;
            }
            .checkbox-style-toggles .markdown-preview-view {
                padding: 0;
                margin: 0;
                display: inline-flex;
                align-items: center;
                line-height: normal;
            }
            .checkbox-style-toggles .markdown-preview-view ul,
            .checkbox-style-toggles .markdown-preview-view li {
                margin: 0;
                padding: 0;
                display: inline-flex;
                align-items: center;
                line-height: normal;
            }
            .checkbox-style-toggles .task-list-item-checkbox {
                margin: 0 8px 0 0;
                vertical-align: middle;
            }
        `;
        document.head.appendChild(this.styleEl);

        // Create a toggle for each checkbox style
        this.plugin.checkboxStyles.forEach(style => {
            const setting = new Setting(toggleContainer);
            const fragment = document.createDocumentFragment();
            const nameContainer = document.createElement('div');
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian'; // Mimic editor context

            // Render the checkbox and description as a single markdown string
            const markdown = `- [${style.symbol}] ${style.description}`;
            const renderChild = new MarkdownRenderChild(nameContainer);
            this.plugin.addChild(renderChild);
            MarkdownRenderer.render(
                this.app,
                markdown,
                nameContainer,
                '', // sourcePath
                renderChild
            );

            // Ensure the rendered elements have editor-like classes
            const previewView = nameContainer.querySelector('.markdown-preview-view');
            if (previewView) {
                previewView.classList.add('cm-s-obsidian', 'mod-cm6', 'markdown-rendered');
            }

            // Append nameContainer to fragment
            fragment.appendChild(nameContainer);

            setting.setName(fragment);
            setting.addToggle(toggle => toggle
                .setValue(this.plugin.settings.styles[style.symbol])
                .onChange(async (value) => {
                    this.plugin.settings.styles[style.symbol] = value;
                    style.enabled = value;
                    await this.plugin.saveSettings();
                    console.log(`Toggled ${style.description} (${style.symbol}) to ${value}`);
                }));
        });
    }

    hide(): void {
        // Cleanup style element when settings tab is closed
        if (this.styleEl) {
            this.styleEl.remove();
            this.styleEl = null;
        }
        super.hide();
    }
}