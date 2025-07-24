// main.ts
// Obsidian plugin to display a context menu for checkbox styles on long press
// Uses CodeMirror 6 widgets for native integration

import { Plugin, MarkdownView, Editor, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, WorkspaceLeaf, setTooltip } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, EditorState } from '@codemirror/state';

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

// State effect for showing the widget & overlay cleanup
const showWidgetEffect = StateEffect.define<{ 
    pos: number; 
    line: number; 
    overlayHandler?: () => void;
    overlayElement?: HTMLElement;
}>({
    map: (val, change) => ({ 
        pos: change.mapPos(val.pos), 
        line: val.line,
        overlayHandler: val.overlayHandler,
        overlayElement: val.overlayElement
    })
});

// State effect for hiding the widget
const hideWidgetEffect = StateEffect.define<void>();

// Widget class for the checkbox style menu
class CheckboxStyleWidget extends WidgetType {
    private plugin: CheckboxStyleMenuPlugin;
    private linePos: number;
    private menuTimeout: NodeJS.Timeout | null = null;
    private element: HTMLElement | null = null;
    private overlayHandler?: () => void;
    private overlayElement?: HTMLElement; // Reference to overlay

    constructor(plugin: CheckboxStyleMenuPlugin, linePos: number, overlayHandler?: () => void, overlayElement?: HTMLElement) {
        super();
        this.plugin = plugin;
        this.linePos = linePos;
        this.overlayHandler = overlayHandler;
        this.overlayElement = overlayElement;
    }

    eq(other: CheckboxStyleWidget) {
        return this.linePos === other.linePos;
    }

    private hideWidget(view: EditorView) {
        // Remove overlay when hiding widget
        if (this.overlayHandler) {
            this.overlayHandler();
        }
        
        view.dispatch({
            effects: hideWidgetEffect.of(undefined)
        });
    }

    destroy() {
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
        
        // Clean up overlay when widget is destroyed
        if (this.overlayHandler) {
            this.overlayHandler();
        }
    }

    private positionMenu(view: EditorView, container: HTMLElement, menu: HTMLElement) {
        const line = view.state.doc.lineAt(this.linePos);
        const lineDOM = view.domAtPos(line.from);
        
        // Find the checkbox within the line
        const lineElement = lineDOM.node.nodeType === Node.ELEMENT_NODE 
            ? (lineDOM.node as HTMLElement).closest('.cm-line')
            : lineDOM.node.parentElement?.closest('.cm-line');
        
        const checkbox = lineElement?.querySelector('.task-list-item-checkbox') as HTMLElement;
        
        if (!checkbox || !lineElement) {
            // Fallback to left positioning
            container.style.cssText += 'transform: translateX(-100%); margin-left: -8px;';
            return;
        }
        
        // Calculate positions relative to the line
        const checkboxRect = checkbox.getBoundingClientRect();
        const lineRect = lineElement.getBoundingClientRect();
        const editorRect = view.scrollDOM.getBoundingClientRect();
        
        const checkboxLeft = checkboxRect.left - lineRect.left;
        const menuWidth = menu.offsetWidth;
        const availableLeft = checkboxRect.left - editorRect.left;
        const availableRight = editorRect.right - checkboxRect.right;
        
        // Simple decision: use right if left doesn't have enough space
        const useRightSide = menuWidth > availableLeft - 10 && availableRight > menuWidth + 10;
        
        if (useRightSide) {
            container.style.cssText += `left: ${checkboxLeft + checkboxRect.width + 8}px;`;
        } else {
            container.style.cssText += `left: ${checkboxLeft - 8}px; transform: translateX(-100%);`;
        }
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('div');
        container.className = 'checkbox-style-menu-widget';
        container.style.cssText = `
            position: absolute;
            z-index: 1000;
            margin: 0;
            display: flex;
            justify-content: flex-start;
            top: -3px;
            left: 0;
            pointer-events: none;
        `;

        const menu = document.createElement('div');
        menu.className = 'checkbox-style-menu markdown-source-view cm-s-obsidian';
        menu.setAttribute('role', 'menu');
        menu.style.cssText = `
            background: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px var(--background-modifier-box-shadow);
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 4px 3px;
            pointer-events: auto;
            visibility: hidden; /* Hide initially until positioned */
        `;

        this.element = menu;
        
        // Render content and setup event listeners first
        this.renderMenuContent(view, menu);
        this.setupEventListeners(view, menu);
        
        container.appendChild(menu);
        
        // Position the menu after it's been added to DOM and rendered
        // Use requestAnimationFrame to ensure the browser has laid out the menu
        requestAnimationFrame(() => {
            this.positionMenu(view, container, menu);
            menu.style.visibility = 'visible'; // Show after positioning
        });
        
        return container;
    }

    private async renderMenuContent(view: EditorView, menu: HTMLElement) {
        // Filter enabled styles
        const enabledStyles = this.plugin.checkboxStyles.filter(style => style.enabled);
        if (enabledStyles.length === 0) {
            menu.textContent = 'No styles enabled';
            return;
        }

        // Generate markdown string for enabled checkbox styles
        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');

        // Render markdown directly into the menu
        const renderChild = new MarkdownRenderChild(menu);
        this.plugin.addChild(renderChild);
        await MarkdownRenderer.render(
            this.plugin.app,
            markdown,
            menu,
            '',
            renderChild
        );

        // Style the rendered markdown
        this.styleRenderedMarkdown(menu, enabledStyles);
    }

    private styleRenderedMarkdown(menu: HTMLElement, enabledStyles: any[]) {
        // Customize markdown preview
        const markdownPreview = menu.querySelector('.markdown-preview-view') as HTMLElement | null;
        if (markdownPreview) {
            markdownPreview.style.cssText = `
                margin: 0;
                padding: 0;
                width: 100%;
                box-sizing: border-box;
                display: flex;
                justify-content: center;
            `;
        }

        const ul = menu.querySelector('ul') as HTMLElement | null;
        if (ul) {
            ul.style.cssText = `
                list-style: none;
                margin: 0;
                padding: 0;
                width: 100%;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                align-items: center;
            `;
        }

        // Style list items and add Obsidian-style tooltips with positioning
        const listItems = menu.querySelectorAll('li');
        listItems.forEach((li, index) => {
            li.style.cssText = `
                padding: 2px 2px;
                margin: 2px 0px;
                cursor: pointer;
                display: flex;
                justify-content: center;
                align-items: center;
                position: relative;
                width: 100%;
                box-sizing: border-box;
            `;

            // Center the checkbox
            const checkbox = li.querySelector('.task-list-item-checkbox') as HTMLElement | null;
            if (checkbox) {
                checkbox.style.margin = '0 auto';
            }

            // Use Obsidian's setTooltip function with positioning options
            // This gives us native styling with better control over positioning
            this.plugin.app.workspace.onLayoutReady(() => {
                setTooltip(li as HTMLElement, enabledStyles[index].description, {
                    placement: 'right'
                });
            });

            // Add data attribute for event delegation
            li.setAttribute('data-style-index', index.toString());
        });
    }

    private setupEventListeners(view: EditorView, menu: HTMLElement) {
        let hoverTimeout: NodeJS.Timeout | null = null;

        // Mouse enter/leave for hover effects - use Obsidian's native tooltip system
        menu.addEventListener('mouseenter', (e) => {
            const li = (e.target as HTMLElement).closest('li');
            if (li) {
                li.style.background = 'var(--background-modifier-hover)';
            }
        }, true);

        menu.addEventListener('mouseleave', (e) => {
            const li = (e.target as HTMLElement).closest('li');
            if (li) {
                li.style.background = '';
            }
        }, true);

        // Click handler for style selection
        menu.addEventListener('mouseup', (e) => {
            const li = (e.target as HTMLElement).closest('li');
            if (li) {
                e.stopPropagation();
                const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
                const enabledStyles = this.plugin.checkboxStyles.filter(style => style.enabled);
                const symbol = enabledStyles[index].symbol;
                console.log(`Applying symbol '${symbol}' via widget`);
                this.applyCheckboxStyle(view, symbol);
                this.hideWidget(view);
            }
        });

        // Menu-level event listeners for timeout management
        menu.addEventListener('mouseenter', () => {
            console.log('Mouse entered menu, clearing timeout');
            if (this.menuTimeout) {
                clearTimeout(this.menuTimeout);
                this.menuTimeout = null;
            }
        });

        menu.addEventListener('mouseleave', () => {
            console.log('Mouse left menu, starting timeout');
            this.startDismissTimeout(view);
        });

        // Set up overlay event listeners if overlay exists
        if (this.overlayElement) {
            this.overlayElement.addEventListener('mouseenter', () => {
                console.log('Mouse entered overlay, clearing timeout');
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                }
            });

            this.overlayElement.addEventListener('mouseleave', () => {
                console.log('Mouse left overlay, starting timeout and dismissing overlay');
                this.startDismissTimeout(view);
                // Remove the overlay when mouse leaves it
                if (this.overlayHandler) {
                    this.overlayHandler();
                }
            });

            // Add click handler to dismiss menu when overlay is clicked
            this.overlayElement.addEventListener('click', (e) => {
                console.log('Overlay clicked, dismissing widget menu');
                e.preventDefault();
                e.stopPropagation();
                this.hideWidget(view);
            });
        }

        // Don't start timeout immediately - wait for mouse to leave overlay or menu
        console.log('Event listeners set up, timeout will start when mouse leaves overlay/menu');
    }

    private startDismissTimeout(view: EditorView) {
        if (this.menuTimeout) clearTimeout(this.menuTimeout);
        this.menuTimeout = setTimeout(() => {
            console.log('Widget menu timeout triggered');
            this.hideWidget(view);
        }, 2000); // 2 second timeout
    }

    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const state = view.state;
        const line = state.doc.lineAt(this.linePos);
        const text = line.text;

        if (!this.plugin.isCheckboxLine(text)) {
            console.error(`Line is not a checkbox: "${text}"`);
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

        // Apply the change
        view.dispatch({
            changes: { from, to, insert: symbol },
        });

        console.log(`Symbol replaced with '${symbol}' via widget`);
    }
}

// State field to manage widget decorations & pass the overlay handler to the widget
const checkboxWidgetState = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);

        for (let effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                const { pos, line, overlayHandler, overlayElement } = effect.value;
                const widget = Decoration.widget({
                    widget: new CheckboxStyleWidget(
                        tr.state.field(pluginInstanceField), 
                        pos, 
                        overlayHandler, 
                        overlayElement
                    ),
                    side: 1
                });
                decorations = Decoration.set([widget.range(pos)]);
            } else if (effect.is(hideWidgetEffect)) {
                decorations = Decoration.none;
            }
        }

        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

// Field to store plugin instance for widget access
const pluginInstanceField = StateField.define<CheckboxStyleMenuPlugin>({
    create() {
        return null as any; // Will be set when plugin loads
    },
    update(value) {
        return value;
    }
});

// View plugin to handle mouse events
const checkboxViewPlugin = ViewPlugin.fromClass(class {
    private longPressDuration = 350;
    private timer: NodeJS.Timeout | null = null;
    private isLongPress = false;
    private lastTarget: HTMLElement | null = null;
    private overlayElement: HTMLElement | null = null;

    constructor(private view: EditorView) {
        this.view.dom.addEventListener('mousedown', this.handleMouseDown);
        this.view.dom.addEventListener('mouseup', this.handleMouseUp);
    }

    destroy() {
        this.view.dom.removeEventListener('mousedown', this.handleMouseDown);
        this.view.dom.removeEventListener('mouseup', this.handleMouseUp);
        this.removeOverlay();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private createOverlay(checkbox: HTMLElement) {
        // Remove any existing overlay first
        this.removeOverlay();
        
        // Create an invisible overlay that just handles event prevention
        // but allows scrolling to pass through
        const checkboxRect = checkbox.getBoundingClientRect();
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'checkbox-overlay';
        Object.assign(this.overlayElement.style, {
            position: 'fixed',
            top: `${checkboxRect.top}px`,
            left: `${checkboxRect.left}px`,
            width: `${checkboxRect.width}px`,
            height: `${checkboxRect.height}px`,
            zIndex: '999',
            background: 'transparent', // Make it invisible
            cursor: 'default',
            pointerEvents: 'auto' // Allow pointer events on the overlay
        });
        
        // Add event listeners to prevent checkbox interactions
        const preventCheckboxEvent = (e: Event) => {
            // Prevent the event from reaching the checkbox underneath
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            console.log(`Checkbox ${e.type} prevented by overlay`);
            return false;
        };
        
        // Prevent click events that would change the checkbox
        this.overlayElement.addEventListener('mouseup', preventCheckboxEvent);
        this.overlayElement.addEventListener('mousedown', preventCheckboxEvent);
        
        // Key: Allow wheel events to pass through by not preventing them
        // and by setting pointer-events appropriately
        this.overlayElement.addEventListener('wheel', (e) => {
            // Let wheel events pass through to the document underneath
            // by temporarily disabling pointer events on the overlay
            this.overlayElement!.style.pointerEvents = 'none';
            
            // Re-enable pointer events after a brief moment
            setTimeout(() => {
                if (this.overlayElement) {
                    this.overlayElement.style.pointerEvents = 'auto';
                }
            }, 10);
        });
        
        document.body.appendChild(this.overlayElement);
        console.log('Overlay created to prevent checkbox interaction while allowing scroll');
    }
    
    private removeOverlay() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
            console.log('Overlay removed');
        }
    }

    handleMouseDown = (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        
        // Only handle checkboxes that are not part of the style menu
        if (target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu')) {
            console.log('Mousedown on checkbox detected in widget plugin');
            
            // Store the target for overlay creation
            this.lastTarget = target;
            
            // Hide any existing widget and remove overlay
            this.view.dispatch({
                effects: hideWidgetEffect.of(undefined)
            });
            this.removeOverlay();

            // Get cursor position from DOM element
            const pos = this.view.posAtDOM(target);
            if (pos === null || pos < 0 || pos > this.view.state.doc.length) {
                console.error('Invalid position from posAtDOM:', pos);
                return;
            }

            const line = this.view.state.doc.lineAt(pos);
            const plugin = this.view.state.field(pluginInstanceField);
            
            if (!plugin.isCheckboxLine(line.text)) {
                console.error(`Line is not a checkbox: "${line.text}"`);
                return;
            }

            // Set timer for long press
            this.timer = setTimeout(() => {
                this.isLongPress = true;
                console.log('Long press detected, showing widget and creating overlay');
                
                // Create overlay to prevent checkbox interaction
                if (this.lastTarget) {
                    this.createOverlay(this.lastTarget);
                }
                
                // Show widget at the end of the line, passing overlay element only if it exists
                this.view.dispatch({
                    effects: showWidgetEffect.of({ 
                        pos: pos, 
                        line: line.number - 1,
                        overlayHandler: () => this.removeOverlay(),
                        ...(this.overlayElement && { overlayElement: this.overlayElement })
                    })
                });
                
                event.preventDefault();
            }, this.longPressDuration);
        }
    };

    handleMouseUp = (event: MouseEvent) => {
        // Clear the timer if it exists
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        
        // Reset state
        if (this.isLongPress) {
            this.isLongPress = false;
        }
        this.lastTarget = null;
    };
});

export default class CheckboxStyleMenuPlugin extends Plugin {
    settings: CheckboxStyleSettings;
    // Array of checkbox styles with dynamic enabled state
    public checkboxStyles = checkboxStyles.map(style => ({ ...style, enabled: false }));
    // Style element for settings tab
    private settingsStyleEl: HTMLStyleElement | null = null;

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

        // Register CodeMirror extensions for all markdown views
        this.registerEditorExtension([
            checkboxWidgetState,
            checkboxViewPlugin,
            pluginInstanceField.init(() => this)
        ]);

        // Add settings tab for configuring checkbox styles
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));

        console.log('Checkbox Style Menu Plugin loaded with CM6 widgets');
    }

    // Clean up when plugin is unloaded
    onunload() {
        // Remove settings tab styles
        if (this.settingsStyleEl) {
            this.settingsStyleEl.remove();
            this.settingsStyleEl = null;
            console.log('Settings tab styles removed from document head');
        }
        console.log('Plugin unloaded');
    }

    // Save settings to persistent storage
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Load settings from persistent storage
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    // Check if a line is a valid checkbox line
    public isCheckboxLine(line: string): boolean {
        const isValid = /^\s*-\s*\[[ \/\-x><?!*\"lbiSIpcfkwud]\]\s*(.*)?$/.test(line);
        console.log(`Checking line: "${line}" -> Valid: ${isValid}`);
        return isValid;
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