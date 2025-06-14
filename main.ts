// main.ts
// Obsidian plugin to display a context menu for checkbox styles on long press
// Uses CodeMirror 6 and Obsidian API to interact with markdown checkboxes

import { Plugin, MarkdownView, Editor, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting } from 'obsidian';
import { EditorView } from '@codemirror/view';

// Extend Editor interface to include CodeMirror instance
interface CodeMirrorEditor extends Editor {
    cm?: EditorView;
}

// Define settings interface for checkbox styles
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };
}

// Define checkbox styles as the single source of truth
const checkboxStyles = [
    { symbol: ' ', description: 'To-do' },
    { symbol: '/', description: 'Incomplete' },
    { symbol: 'x', description: 'Done' },
    { symbol: '-', description: 'Cancelled' },
    { symbol: '>', description: 'Forwarded' },
    { symbol: '<', description: 'Scheduling' },
    { symbol: '?', description: 'Question' },
    { symbol: '!', description: 'Important' },
    { symbol: '*', description: 'Star' },
    { symbol: '"', description: 'Quote' },
    { symbol: 'l', description: 'Location' },
    { symbol: 'b', description: 'Bookmark' },
    { symbol: 'i', description: 'Information' },
    { symbol: 'S', description: 'Savings' },
    { symbol: 'I', description: 'Idea' },
    { symbol: 'p', description: 'Pro' },
    { symbol: 'c', description: 'Con' },
    { symbol: 'f', description: 'Fire' },
    { symbol: 'k', description: 'Key' },
    { symbol: 'w', description: 'Win' },
    { symbol: 'u', description: 'Up' },
    { symbol: 'd', description: 'Down' },
];

// Generate default settings from checkboxStyles
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: Object.fromEntries(
        checkboxStyles.map(style => [style.symbol, [' ', '/', 'x', '-'].includes(style.symbol)])
    ),
};

// Define static CSS for settings tab
const SETTINGS_STYLES = `
    .checkbox-style-toggles .setting-item {
        padding: 0px 0;
        display: flex;
        align-items: center;
    }
    .checkbox-style-toggles .task-list-item-checkbox {
        vertical-align: middle;
    }
`;

export default class CheckboxStyleMenuPlugin extends Plugin {
    settings: CheckboxStyleSettings;
    // Array of checkbox styles with dynamic enabled state
    public checkboxStyles = checkboxStyles.map(style => ({ ...style, enabled: false }));
    // Style element for settings tab
    private settingsStyleEl: HTMLStyleElement | null = null;

    // Duration for long press to trigger menu (ms)
    private longPressDuration = 350;
    // Duration before menu auto-dismisses (ms)
    private menuTimeoutDuration = 2000;
    // Menu container element
    private menuElement: HTMLElement | null = null;
    // Overlay to block checkbox interactions
    private overlayElement: HTMLElement | null = null;
    // Timeout for menu dismissal
    private menuTimeout: NodeJS.Timeout | null = null;
    // Store scroll listener for cleanup
    private scrollListener: (() => void) | null = null;
    // Timer for long press detection
    private timer: NodeJS.Timeout | null = null;
    // Flag for long press detection
    private isLongPress: boolean = false;
    // Store last mouse down event
    private lastMouseDownEvent: MouseEvent | null = null;
    // Reference to the active Markdown view
    private targetView: MarkdownView | null = null;

    // Initialize plugin on load
    async onload() {
        // Load saved settings
        await this.loadSettings();
        // Initialize enabled states based on settings
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol] ?? false;
        });

        // Create and append static styles for settings tab
        this.settingsStyleEl = document.createElement('style');
        this.settingsStyleEl.textContent = SETTINGS_STYLES;
        document.head.appendChild(this.settingsStyleEl);
        console.log('Settings tab styles appended to document head');

        // Register event listeners for mouse interactions
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));

        // Reset state when active leaf changes, only if no menu or interaction is active
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                console.log('Active leaf changed');
                if (!this.timer && !this.menuElement && !this.isLongPress) {
                    this.resetState();
                }
            })
        );

        // Add settings tab for configuring checkbox styles
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));
    }

    // Clean up when plugin is unloaded
    onunload() {
        // Remove menu and associated listeners
        this.hideMenu();
        // Remove global document listeners
        document.removeEventListener('mousedown', this.handleMouseDown);
        document.removeEventListener('mouseup', this.handleMouseUp);
        // Remove settings tab styles
        if (this.settingsStyleEl) {
            this.settingsStyleEl.remove();
            this.settingsStyleEl = null;
            console.log('Settings tab styles removed from document head');
        }
        console.log('Plugin unloaded and global listeners removed');
    }

    // Save settings to persistent storage
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Load settings from persistent storage
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    // Clear all timers (long press and menu timeout)
    private clearTimers() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            console.log('Long press timer cleared');
        }
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
            console.log('Menu timeout cleared');
        }
    }

    // Reset interaction-related state (long press and mouse event)
    private resetInteractionState() {
        this.isLongPress = false;
        this.lastMouseDownEvent = null;
        console.log('Interaction state reset');
    }

    // Reset all plugin state, including timers, menu, and view
    private resetState() {
        this.clearTimers();
        this.resetInteractionState();
        this.targetView = null;
        this.hideMenu();
        console.log('Full plugin state reset');
    }

    // Handle mouse down event to detect long press on note checkboxes (exclude menu checkboxes)
    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        // Only handle checkboxes that are not part of the style menu
        if (target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu')) {
            console.log('Mousedown on note checkbox detected');
            // If a menu is already visible, hide it to allow a new menu for this checkbox
            if (this.menuElement) {
                this.hideMenu();
            }
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

    // Handle mouse up to clear long press timer, only if menu is not visible
    private handleMouseUp(event: MouseEvent) {
        // Only clear timers and reset state if no menu is active
        if (this.timer && !this.menuElement) {
            this.clearTimers();
        }
        if (this.isLongPress && !this.menuElement) {
            this.resetInteractionState();
        }
    }

    // Show the style menu when a checkbox is long-pressed
    private async showStyleMenu(event: MouseEvent, checkbox: HTMLElement) {
        const view = this.targetView || this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            console.error('No active Markdown view found');
            this.clearTimers();
            return;
        }

        const editor = view.editor as CodeMirrorEditor;
        if (!editor.cm) {
            console.error('No CodeMirror instance found');
            this.clearTimers();
            return;
        }

        // Get cursor position from DOM element
        const pos = editor.cm.posAtDOM(checkbox);
        if (pos === null || pos < 0 || pos > editor.cm.state.doc.length) {
            console.error('Invalid position from posAtDOM:', pos);
            this.clearTimers();
            return;
        }

        const line = editor.cm.state.doc.lineAt(pos);
        const lineNumber = line.number - 1;
        const text = line.text;

        // Verify the line is a checkbox
        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            this.clearTimers();
            return;
        }

        // Remove any existing menu and listeners
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
            e.stopPropagation(); // Prevent global mouseup handler
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
            'border-radius': '4px',
            'z-index': '1000',
            'box-shadow': '0 2px 8px var(--background-modifier-box-shadow)',
            display: 'flex',
            'justify-content': 'center',
            'align-items': 'center',
            padding: '4px 3px',
        });

        // Add cursor listeners to the menu container for dismiss timer management
        this.menuElement.addEventListener('mouseenter', () => {
            console.log('Cursor entered menu, clearing dismiss timer');
            if (this.menuTimeout) {
                clearTimeout(this.menuTimeout);
                this.menuTimeout = null;
            }
        });
        this.menuElement.addEventListener('mouseleave', () => {
            console.log('Cursor left menu, starting dismiss timer');
            this.startDismissTimeout();
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
            this.app,
            markdown,
            this.menuElement,
            '',
            renderChild
        );

        // Customize markdown preview to ensure centering
        const markdownPreview = this.menuElement.querySelector('.markdown-preview-view') as HTMLElement | null;
        if (markdownPreview) {
            Object.assign(markdownPreview.style, {
                margin: '0',
                padding: '0',
                width: '100%',
                'box-sizing': 'border-box',
                display: 'flex',
                'justify-content': 'center',
            });
        }
        const ul = this.menuElement.querySelector('ul') as HTMLElement | null;
        if (ul) {
            Object.assign(ul.style, {
                'list-style': 'none',
                margin: '0',
                padding: '0',
                width: '100%',
                'box-sizing': 'border-box',
                display: 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
            });
        }

        // Make rendered checkboxes clickable and add tooltips
        const listItems = this.menuElement.querySelectorAll('li');
        listItems.forEach((li, index) => {
            Object.assign(li.style, {
                padding: '2px 2px',
                margin: '2px 0px',
                cursor: 'pointer',
                display: 'flex',
                'justify-content': 'center',
                'align-items': 'center',
                position: 'relative',
                width: '100%',
                'box-sizing': 'border-box',
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
                z-index: 1001;
                left: calc(100% + 8px);
                top: 50%;
                transform: translateY(-50%);
                opacity: 0;
                transition: opacity 0.2s;
                white-space: nowrap;
                text-align: center;
            `;
            li.appendChild(tooltip);

            // Add hover effects and tooltip behavior for individual items
            li.addEventListener('mouseenter', () => {
                li.style.background = 'var(--background-modifier-hover)';
                setTimeout(() => {
                    if (li.matches(':hover')) {
                        tooltip.style.visibility = 'visible';
                        tooltip.style.opacity = '1';
                    }
                }, 500); // Half-second hover delay for tooltip
            });
            li.addEventListener('mouseleave', () => {
                li.style.background = '';
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
            });

            // Add click event to apply style using stored editor and pos
            li.addEventListener('mouseup', (e) => {
                e.stopPropagation(); // Prevent triggering global mouseup or mousedown
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
            this.clearTimers();
            return;
        }
        const editorRect = container.getBoundingClientRect();

        // Temporarily append menu to measure dimensions
        Object.assign(this.menuElement.style, {
            visibility: 'hidden',
            left: '0px',
            top: '0px',
        });
        container.appendChild(this.menuElement);
        const menuWidth = this.menuElement.offsetWidth || 30; // Fallback to 30px
        const menuHeight = this.menuElement.offsetHeight || 40; // Fallback to approximate minimum
        this.menuElement.style.visibility = ''; // Restore visibility

        // Calculate position
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

        // Add scroll event listener to CodeMirror's scrollDOM only when menu is open
        if (editor.cm && editor.cm.scrollDOM) {
            this.scrollListener = () => {
                console.log('Scroll event detected on CodeMirror scrollDOM, hiding menu immediately');
                this.hideMenu();
            };
            editor.cm.scrollDOM.addEventListener('scroll', this.scrollListener);
            console.log('Scroll listener attached to CodeMirror scrollDOM');
        }

        // Add listener for clicks outside the menu to close it
        const closeOnClickOutside = (e: MouseEvent) => {
            if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
                console.log('Mouse down outside menu detected, hiding menu immediately');
                this.hideMenu();
                document.removeEventListener('mousedown', closeOnClickOutside);
            }
        };
        document.addEventListener('mousedown', closeOnClickOutside);

        console.log(`Menu positioned with width: ${menuWidth}px, height: ${menuHeight}px at left: ${left}px, top: ${top}px`);
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

    // Remove menu, overlay, and all associated listeners from the DOM
    private hideMenu() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
        // Remove scroll listener if it exists
        if (this.scrollListener && this.targetView && this.targetView.editor) {
            const editor = this.targetView.editor as CodeMirrorEditor;
            if (editor.cm && editor.cm.scrollDOM) {
                editor.cm.scrollDOM.removeEventListener('scroll', this.scrollListener);
                console.log('Scroll listener removed from CodeMirror scrollDOM');
            }
            this.scrollListener = null;
        }
        this.clearTimers();
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

        const view = editor.cm;
        const state = view.state;
        const line = state.doc.lineAt(pos);
        const lineNumber = line.number - 1;
        const text = line.text;

        if (!this.isCheckboxLine(text)) {
            console.error(`Line ${lineNumber} is not a checkbox: "${text}"`);
            return;
        }

        // Find the checkbox symbol position
        const match = text.match(/-\s*\[(.)\]/);
        if (!match) {
            console.error('No checkbox pattern found in line');
            return;
        }

        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const from = line.from + startIndex;
        const to = from + 1;

        // Dispatch a transaction with changes only, preserving selection
        view.dispatch({
            changes: { from, to, insert: symbol },
        });

        console.log(`Symbol replaced at line ${lineNumber}, ch ${startIndex} with '${symbol}', scroll preserved`);
    }
}

// Settings tab for configuring checkbox styles
class CheckboxStyleSettingTab extends PluginSettingTab {
    plugin: CheckboxStyleMenuPlugin;

    constructor(app: App, plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Display settings UI
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Checkbox Style Menu Settings' });

        // Create a container for all toggles
        const toggleContainer = containerEl.createEl('div', {
            cls: 'checkbox-style-toggles',
        });

        // Create a toggle for each checkbox style
        this.plugin.checkboxStyles.forEach(style => {
            const setting = new Setting(toggleContainer);
            const fragment = document.createDocumentFragment();
            const nameContainer = document.createElement('div');
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian';

            // Render the checkbox and description as markdown
            const markdown = `- [${style.symbol}] ${style.description}`;
            const renderChild = new MarkdownRenderChild(nameContainer);
            this.plugin.addChild(renderChild);
            MarkdownRenderer.render(
                this.app,
                markdown,
                nameContainer,
                '',
                renderChild
            );

            // Ensure editor-like styling for rendered elements
            const previewView = nameContainer.querySelector('.markdown-preview-view');
            if (previewView) {
                previewView.classList.add('cm-s-obsidian', 'mod-cm6', 'markdown-rendered');
            }

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
}