// main.ts
// Obsidian plugin to display a context menu for checkbox styles on long press
// Uses CodeMirror 6 widgets for native integration

import { Plugin, MarkdownView, Editor, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, WorkspaceLeaf, setTooltip, Platform } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, EditorState } from '@codemirror/state';

// Extend Editor interface to include CodeMirror instance
interface CodeMirrorEditor extends Editor {
    cm?: EditorView;
}

// Define settings interface for checkbox styles
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };
    longPressDuration: number;
    touchLongPressDuration: number; // Separate duration for mobile
    enableHapticFeedback: boolean;
}

// Define checkbox styles as the single source of truth
const CHECKBOX_STYLES = [
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
] as const;

// Pre-compile regex for better performance
const CHECKBOX_REGEX = /^\s*-\s*\[(.)\]\s*(.*)?$/;
const CHECKBOX_SYMBOL_REGEX = /-\s*\[(.)\]/;

// Generate default settings from checkboxStyles
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: Object.fromEntries(
        CHECKBOX_STYLES.map(style => [style.symbol, [' ', '/', 'x', '-'].includes(style.symbol)])
    ),
    longPressDuration: 350,
    touchLongPressDuration: 500, // Longer for touch devices
    enableHapticFeedback: true,
};

// Define static CSS for settings tab with CSS custom properties for better theming
const SETTINGS_STYLES = `
    .checkbox-style-toggles .setting-item {
        padding: 0px 0;
        display: flex;
        align-items: center;
    }
    .checkbox-style-toggles .task-list-item-checkbox {
        vertical-align: middle;
    }
    .checkbox-style-menu-widget {
        --menu-bg: var(--background-primary);
        --menu-border: var(--background-modifier-border);
        --menu-shadow: var(--background-modifier-box-shadow);
        --menu-hover: var(--background-modifier-hover);
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

// Utility functions for better code organization
class OverlayManager {
    private overlayElement: HTMLElement | null = null;

    create(checkbox: HTMLElement): HTMLElement {
        this.remove();
        
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
            background: 'transparent', // Testing color 'rgba(255, 118, 118, 0.5)',
            cursor: 'default',
            pointerEvents: 'auto'
        });
        
        this.setupEventListeners(checkboxRect);
        document.body.appendChild(this.overlayElement);
        
        return this.overlayElement;
    }

    private setupEventListeners(checkboxRect: DOMRect, onInteraction?: () => void) {
        if (!this.overlayElement) return;

        // Simple approach: just prevent checkbox interactions
        const preventCheckboxEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        };
        
        // Prevent checkbox interactions
        ['mouseup', 'mousedown', 'click', 'touchstart', 'touchend'].forEach(eventType => {
            this.overlayElement!.addEventListener(eventType, preventCheckboxEvent);
        });
        
        // Handle scroll events properly
        this.overlayElement.addEventListener('wheel', (e) => {
            this.overlayElement!.style.pointerEvents = 'none';
            setTimeout(() => {
                if (this.overlayElement) {
                    this.overlayElement.style.pointerEvents = 'auto';
                }
            }, 10);
        });

        // Mobile-specific touch handling
        if (Platform.isMobile) {
            const initialY = checkboxRect.top;
            this.overlayElement.addEventListener('touchmove', (e) => {
                // Allow scrolling on mobile
                if (Math.abs(e.touches[0].clientY - initialY) > 10) {
                    this.remove();
                }
            });
        }
    }

    remove() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
    }

    get element() {
        return this.overlayElement;
    }
}

// Widget class for the checkbox style menu
class CheckboxStyleWidget extends WidgetType {
    private plugin: CheckboxStyleMenuPlugin;
    private linePos: number;
    private menuTimeout: NodeJS.Timeout | null = null;
    private element: HTMLElement | null = null;
    private overlayManager: OverlayManager;
    private tooltipElements: HTMLElement[] = []

    constructor(plugin: CheckboxStyleMenuPlugin, linePos: number, overlayManager: OverlayManager) {
        super();
        this.plugin = plugin;
        this.linePos = linePos;
        this.overlayManager = overlayManager;
    }

    eq(other: CheckboxStyleWidget) {
        return this.linePos === other.linePos;
    }

    private hideWidget(view: EditorView) {
        // Force cleanup of any visible tooltips
        const tooltips = document.querySelectorAll('.tooltip, [class*="tooltip"]');
        tooltips.forEach(tooltip => {
            if (tooltip.parentNode) {
                tooltip.parentNode.removeChild(tooltip);
            }
        });
        
        this.overlayManager.remove();
        view.dispatch({
            effects: hideWidgetEffect.of(undefined)
        });
    }

    destroy() {
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
        
        // Clean up tooltips by removing any visible tooltip elements
        this.tooltipElements.forEach(tooltip => {
            if (tooltip.parentNode) {
                tooltip.parentNode.removeChild(tooltip);
            }
        });
        this.tooltipElements = [];
        
        // Also clean up any tooltips attached to menu items
        if (this.element) {
            const tooltips = document.querySelectorAll('.tooltip, [class*="tooltip"]');
            tooltips.forEach(tooltip => {
                if (tooltip.parentNode) {
                    tooltip.parentNode.removeChild(tooltip);
                }
            });
        }

        // Clean up scroll indicators
        if ((this as any).cleanupScrollIndicators) {
            (this as any).cleanupScrollIndicators();
        }
        if ((this as any).cleanupScrollGradients) {
            (this as any).cleanupScrollGradients();
        }
        
        // Clean up global interaction handler if it exists
        if ((this as any).globalInteractionHandler && (this as any).globalInteractionEventType) {
            document.removeEventListener(
                (this as any).globalInteractionEventType, 
                (this as any).globalInteractionHandler, 
                true
            );
        }
        
        this.overlayManager.remove();
    }

    private positionMenu(view: EditorView, container: HTMLElement, menu: HTMLElement) {
        const line = view.state.doc.lineAt(this.linePos);
        const lineDOM = view.domAtPos(line.from);
        
        const lineElement = lineDOM.node.nodeType === Node.ELEMENT_NODE 
            ? (lineDOM.node as HTMLElement).closest('.cm-line')
            : lineDOM.node.parentElement?.closest('.cm-line');
        
        const checkbox = lineElement?.querySelector('.task-list-item-checkbox') as HTMLElement;
        
        if (!checkbox || !lineElement) {
            container.style.cssText += 'transform: translateX(-100%); margin-left: -8px;';
            return;
        }
        
        const checkboxRect = checkbox.getBoundingClientRect();
        const lineRect = lineElement.getBoundingClientRect();
        const editorRect = view.scrollDOM.getBoundingClientRect();
        
        const checkboxLeft = checkboxRect.left - lineRect.left;
        
        if (Platform.isMobile) {
            // Mobile: position above the line, starting from the left edge of the document
            const padding = 16;
            
            // Use editor width as constraint
            const editorWidth = editorRect.width;
            const maxMenuWidth = editorWidth - (padding * 2);
            
            // Set max width on menu to constrain it to document width
            menu.style.maxWidth = `${maxMenuWidth}px`;
            
            // Position menu at the left edge of the document (with padding)
            // Convert editor-relative position to line-relative position
            const lineLeftRelativeToEditor = lineRect.left - editorRect.left;
            const relativeLeft = padding - lineLeftRelativeToEditor;
            
            container.style.cssText += `
                left: ${relativeLeft}px; 
                top: -50px;
                transform: none;
            `;
        } else {
            // Desktop: position to the side as before
            const menuWidth = menu.offsetWidth;
            const availableLeft = checkboxRect.left - editorRect.left;
            const availableRight = editorRect.right - checkboxRect.right;
            const spacing = 8;
            
            const useRightSide = menuWidth > availableLeft - spacing && availableRight > menuWidth + spacing;
            
            if (useRightSide) {
                container.style.cssText += `left: ${checkboxLeft + checkboxRect.width + spacing}px;`;
            } else {
                container.style.cssText += `left: ${checkboxLeft - spacing}px; transform: translateX(-100%);`;
            }
        }
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('div');
        container.className = 'checkbox-style-menu-widget';
        
        // Mobile-responsive styling
        const isMobile = Platform.isMobile;
        container.style.cssText = `
            position: absolute;
            z-index: 1000;
            margin: 0;
            display: flex;
            justify-content: flex-start;
            top: -3px;
            left: 0;
            pointer-events: none;
            ${isMobile ? 'transform: scale(1.1);' : ''}
        `;

        const menu = document.createElement('div');
        menu.className = 'checkbox-style-menu markdown-source-view cm-s-obsidian';
        menu.setAttribute('role', 'menu');
        
        // Enhanced styling with CSS custom properties
        menu.style.cssText = `
            background: var(--menu-bg);
            border: 1px solid var(--menu-border);
            border-radius: ${isMobile ? '6px' : '4px'};
            box-shadow: 0 2px 8px var(--menu-shadow);
            display: flex;
            justify-content: center;
            align-items: center;
            padding: ${isMobile ? '6px 4px' : '4px 3px'};
            pointer-events: auto;
            visibility: hidden;
            min-width: ${isMobile ? '44px' : 'auto'};
            position: relative;
            ${isMobile ? `
                max-width: calc(100vw - 32px);
                overflow: visible; /* Changed from hidden to allow indicators */
                white-space: nowrap;
            ` : ''}
        `;

        this.element = menu;
        this.renderMenuContent(view, menu);
        this.setupEventListeners(view, menu);
        
        container.appendChild(menu);
        
        requestAnimationFrame(() => {
            this.positionMenu(view, container, menu);
            menu.style.visibility = 'visible';
        });
        
        return container;
    }

    private async renderMenuContent(view: EditorView, menu: HTMLElement) {
        const enabledStyles = this.getEnabledStyles();
        if (enabledStyles.length === 0) {
            menu.textContent = 'No styles enabled';
            return;
        }

        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');
        const renderChild = new MarkdownRenderChild(menu);
        this.plugin.addChild(renderChild);
        
        await MarkdownRenderer.render(
            this.plugin.app,
            markdown,
            menu,
            '',
            renderChild
        );

        this.styleRenderedMarkdown(menu, enabledStyles);
    }

    private getEnabledStyles() {
        return this.plugin.checkboxStyles.filter(style => style.enabled);
    }

    private styleRenderedMarkdown(menu: HTMLElement, enabledStyles: any[]) {
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
            const isMobile = Platform.isMobile;
            ul.style.cssText = `
                list-style: none;
                margin: 0;
                padding: 0;
                width: 100%;
                box-sizing: border-box;
                display: flex;
                ${isMobile ? 'flex-direction: row;' : 'flex-direction: column;'}
                align-items: center;
                gap: ${isMobile ? '8px' : '2px'};
                ${isMobile ? `
                    overflow-x: auto; 
                    padding: 0 4px;
                    /* Hide scrollbar */
                    scrollbar-width: none;
                    -ms-overflow-style: none;
                    scroll-behavior: smooth;
                    /* Add momentum scrolling for iOS */
                    -webkit-overflow-scrolling: touch;
                ` : ''}
            `;
            
            // Hide webkit scrollbar for mobile
            if (isMobile) {
                const style = document.createElement('style');
                style.textContent = `
                    .checkbox-style-menu ul::-webkit-scrollbar {
                        display: none;
                    }
                `;
                document.head.appendChild(style);
            }
        }

        this.setupListItemStyles(menu, enabledStyles);
        
        // Add scroll indicators for mobile
        if (Platform.isMobile && ul) {
            this.addScrollIndicators(menu, ul);
        }
    }

    // Scroll indicators
    private addScrollIndicators(menu: HTMLElement, scrollContainer: HTMLElement) {
        // Create left indicator
        const leftIndicator = document.createElement('div');
        leftIndicator.className = 'scroll-indicator scroll-indicator-left';
        leftIndicator.innerHTML = '‹';
        leftIndicator.style.cssText = `
            position: absolute;
            left: -2px;
            top: 50%;
            transform: translateY(-50%);
            background: linear-gradient(to right, var(--menu-bg) 60%, transparent);
            color: var(--text-muted);
            font-size: 16px;
            font-weight: bold;
            padding: 0 6px;
            pointer-events: none;
            z-index: 1001;
            opacity: 0;
            transition: opacity 0.2s ease;
            height: 100%;
            display: flex;
            align-items: center;
            border-radius: 4px 0 0 4px;
        `;

        // Create right indicator
        const rightIndicator = document.createElement('div');
        rightIndicator.className = 'scroll-indicator scroll-indicator-right';
        rightIndicator.innerHTML = '›';
        rightIndicator.style.cssText = `
            position: absolute;
            right: -2px;
            top: 50%;
            transform: translateY(-50%);
            background: linear-gradient(to left, var(--menu-bg) 60%, transparent);
            color: var(--text-muted);
            font-size: 16px;
            font-weight: bold;
            padding: 0 6px;
            pointer-events: none;
            z-index: 1001;
            opacity: 0;
            transition: opacity 0.2s ease;
            height: 100%;
            display: flex;
            align-items: center;
            border-radius: 0 4px 4px 0;
        `;

        // Position menu relatively to contain absolute indicators
        menu.style.position = 'relative';
        
        menu.appendChild(leftIndicator);
        menu.appendChild(rightIndicator);

        // Function to update indicator visibility
        const updateIndicators = () => {
            const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
            const canScrollLeft = scrollLeft > 5;
            const canScrollRight = scrollLeft < scrollWidth - clientWidth - 5;

            leftIndicator.style.opacity = canScrollLeft ? '1' : '0';
            rightIndicator.style.opacity = canScrollRight ? '1' : '0';
        };

        // Initial check
        setTimeout(updateIndicators, 100);
        
        // Update on scroll
        scrollContainer.addEventListener('scroll', updateIndicators);
        
        // Update on resize (orientation change)
        window.addEventListener('resize', updateIndicators);
        
        // Cleanup function (you'd call this in destroy method)
        (this as any).cleanupScrollIndicators = () => {
            scrollContainer.removeEventListener('scroll', updateIndicators);
            window.removeEventListener('resize', updateIndicators);
        };
    }

    private setupListItemStyles(menu: HTMLElement, enabledStyles: any[]) {
        const listItems = menu.querySelectorAll('li');
        const isMobile = Platform.isMobile;
        
        listItems.forEach((li, index) => {
            li.style.cssText = `
                padding: ${isMobile ? '4px 6px' : '2px 2px'};
                margin: ${isMobile ? '0' : '2px 0px'};
                cursor: pointer;
                display: flex;
                justify-content: center;
                align-items: center;
                position: relative;
                ${isMobile ? 'flex-shrink: 0; width: auto;' : 'width: 100%;'}
                box-sizing: border-box;
                min-height: ${isMobile ? '44px' : 'auto'};
                ${isMobile ? 'min-width: 44px;' : ''}
                border-radius: 2px;
                transition: background-color 0.1s ease;
            `;

            const checkbox = li.querySelector('.task-list-item-checkbox') as HTMLElement | null;
            if (checkbox) {
                checkbox.style.margin = '0 auto';
                if (isMobile) {
                    checkbox.style.transform = 'scale(1.2)';
                }
            }

            // Enhanced tooltip with better positioning for mobile
            this.plugin.app.workspace.onLayoutReady(() => {
                setTooltip(li as HTMLElement, enabledStyles[index].description, {
                    placement: isMobile ? 'top' : 'right'
                });
            });

            li.setAttribute('data-style-index', index.toString());
            li.setAttribute('role', 'menuitem');
        });
    }

    private setupEventListeners(view: EditorView, menu: HTMLElement) {
        const isMobile = Platform.isMobile;
        
        // Enhanced hover effects (desktop only)
        if (!isMobile) {
            menu.addEventListener('mouseenter', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    li.style.background = 'var(--menu-hover)';
                }
            }, true);

            menu.addEventListener('mouseleave', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    li.style.background = '';
                }
            }, true);
        }

        if (isMobile) {
            // Mobile touch handling with scroll support
            let touchStartPos: { x: number; y: number } | null = null;
            let touchStartTime: number = 0;
            const scrollThreshold = 10; // pixels
            const tapTimeThreshold = 300; // milliseconds

            menu.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                touchStartPos = { x: touch.clientX, y: touch.clientY };
                touchStartTime = Date.now();
                // Don't prevent default - allow scrolling to work
            });

            menu.addEventListener('touchend', (e) => {
                if (!touchStartPos) return;

                const touch = e.changedTouches[0];
                const touchEndTime = Date.now();
                const deltaX = Math.abs(touch.clientX - touchStartPos.x);
                const deltaY = Math.abs(touch.clientY - touchStartPos.y);
                const touchDuration = touchEndTime - touchStartTime;

                // Only treat as a tap if:
                // 1. Touch didn't move much (not a scroll)
                // 2. Touch was quick (not a long press)
                const isTap = deltaX < scrollThreshold && 
                            deltaY < scrollThreshold && 
                            touchDuration < tapTimeThreshold;

                if (isTap) {
                    const li = (e.target as HTMLElement).closest('li');
                    if (li) {
                        e.preventDefault(); // Only prevent default for actual taps
                        e.stopPropagation();
                        
                        const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
                        const enabledStyles = this.getEnabledStyles();
                        const symbol = enabledStyles[index].symbol;
                        
                        // Haptic feedback
                        if (this.plugin.settings.enableHapticFeedback && 'vibrate' in navigator) {
                            navigator.vibrate(50);
                        }
                        
                        this.applyCheckboxStyle(view, symbol);
                        this.hideWidget(view);
                    }
                }

                touchStartPos = null;
            });

            // Add visual feedback for touches on mobile
            menu.addEventListener('touchstart', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    li.style.background = 'var(--menu-hover)';
                }
            });

            menu.addEventListener('touchend', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    // Clear background after a short delay to show the feedback
                    setTimeout(() => {
                        li.style.background = '';
                    }, 150);
                }
            });

            menu.addEventListener('touchcancel', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    li.style.background = '';
                }
                touchStartPos = null;
            });

        } else {
            // Desktop click handling
            menu.addEventListener('mouseup', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    e.stopPropagation();
                    e.preventDefault();
                    
                    const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
                    const enabledStyles = this.getEnabledStyles();
                    const symbol = enabledStyles[index].symbol;
                    
                    this.applyCheckboxStyle(view, symbol);
                    this.hideWidget(view);
                }
            });
        }

        this.setupMenuTimeouts(view, menu);
    }

    private setupMenuTimeouts(view: EditorView, menu: HTMLElement) {
        // Use global click/tap listener for both mobile and desktop
        const eventType = Platform.isMobile ? 'touchstart' : 'mousedown';
        const dismissTimeout = Platform.isMobile ? 3000 : 2000;
        
        // Start timeout immediately
        this.startDismissTimeout(view, dismissTimeout);
        
        // Add global listener to dismiss menu when clicking/tapping outside
        const handleGlobalInteraction = (e: Event) => {
            if (!menu.contains(e.target as Node)) {
                this.hideWidget(view);
                document.removeEventListener(eventType, handleGlobalInteraction, true);
            }
        };

        // Handle overlay events
        const overlayElement = this.overlayManager.element;
        if (overlayElement) {
            overlayElement.addEventListener('mouseenter', () => {
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                }
            });

            overlayElement.addEventListener('mouseleave', () => {
                this.startDismissTimeout(view, dismissTimeout);
                this.overlayManager.remove();
            });
        }
        
        // Add listener with capture to catch interactions before they reach other elements
        document.addEventListener(eventType, handleGlobalInteraction, true);
        
        // Store reference to clean up later
        (this as any).globalInteractionHandler = handleGlobalInteraction;
        (this as any).globalInteractionEventType = eventType;

        // Desktop: Also clear timeout on hover
        if (!Platform.isMobile) {
            menu.addEventListener('mouseenter', () => {
                if (this.menuTimeout) {
                    clearTimeout(this.menuTimeout);
                    this.menuTimeout = null;
                }
            });

            menu.addEventListener('mouseleave', () => {
                this.startDismissTimeout(view, dismissTimeout);
            });
        }
    }

    private startDismissTimeout(view: EditorView, delay: number) {
        if (this.menuTimeout) clearTimeout(this.menuTimeout);
        this.menuTimeout = setTimeout(() => {
            this.hideWidget(view);
        }, delay);
    }

    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const state = view.state;
        const line = state.doc.lineAt(this.linePos);
        const text = line.text;

        if (!this.plugin.isCheckboxLine(text)) {
            return;
        }

        const match = text.match(CHECKBOX_SYMBOL_REGEX);
        if (!match) {
            return;
        }

        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const from = line.from + startIndex;
        const to = from + 1;

        view.dispatch({
            changes: { from, to, insert: symbol },
        });
    }
}

// State field to manage widget decorations
const checkboxWidgetState = StateField.define<{
    decorations: DecorationSet;
    overlayManager: OverlayManager;
}>({
    create() {
        return {
            decorations: Decoration.none,
            overlayManager: new OverlayManager()
        };
    },
    update(state, tr) {
        let decorations = state.decorations.map(tr.changes);

        for (let effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                const { pos } = effect.value;
                const widget = Decoration.widget({
                    widget: new CheckboxStyleWidget(
                        tr.state.field(pluginInstanceField), 
                        pos,
                        state.overlayManager
                    ),
                    side: 1
                });
                decorations = Decoration.set([widget.range(pos)]);
            } else if (effect.is(hideWidgetEffect)) {
                decorations = Decoration.none;
                state.overlayManager.remove();
            }
        }

        return {
            decorations,
            overlayManager: state.overlayManager
        };
    },
    provide: f => EditorView.decorations.from(f, state => state.decorations)
});

// Field to store plugin instance for widget access
const pluginInstanceField = StateField.define<CheckboxStyleMenuPlugin>({
    create() {
        return null as any;
    },
    update(value) {
        return value;
    }
});

// Enhanced view plugin with mobile support
const checkboxViewPlugin = ViewPlugin.fromClass(class {
    private timer: NodeJS.Timeout | null = null;
    private isLongPress = false;
    private lastTarget: HTMLElement | null = null;
    private startPos: { x: number; y: number } | null = null;

    constructor(private view: EditorView) {
        this.setupEventListeners();
    }

    destroy() {
        this.removeEventListeners();
        this.cleanupTimer();
    }

    private setupEventListeners() {
        if (Platform.isMobile) {
            this.view.dom.addEventListener('touchstart', this.handleTouchStart, { passive: false });
            this.view.dom.addEventListener('touchend', this.handleTouchEnd, { passive: false });
            this.view.dom.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        } else {
            this.view.dom.addEventListener('mousedown', this.handleMouseDown);
            this.view.dom.addEventListener('mouseup', this.handleMouseUp);
        }
    }

    private removeEventListeners() {
        if (Platform.isMobile) {
            this.view.dom.removeEventListener('touchstart', this.handleTouchStart);
            this.view.dom.removeEventListener('touchend', this.handleTouchEnd);
            this.view.dom.removeEventListener('touchmove', this.handleTouchMove);
        } else {
            this.view.dom.removeEventListener('mousedown', this.handleMouseDown);
            this.view.dom.removeEventListener('mouseup', this.handleMouseUp);
        }
    }

    private cleanupTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private isCheckboxTarget(target: HTMLElement): boolean {
        return target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu');
    }

    private handleLongPress(target: HTMLElement, clientX: number, clientY: number) {
        const pos = this.view.posAtDOM(target);
        if (pos === null || pos < 0 || pos > this.view.state.doc.length) {
            return;
        }

        const line = this.view.state.doc.lineAt(pos);
        const plugin = this.view.state.field(pluginInstanceField);
        
        if (!plugin.isCheckboxLine(line.text)) {
            return;
        }

        this.isLongPress = true;
        
        // Haptic feedback for mobile
        if (Platform.isMobile && plugin.settings.enableHapticFeedback && 'vibrate' in navigator) {
            navigator.vibrate(75);
        }

        // Hide any existing widget
        this.view.dispatch({
            effects: hideWidgetEffect.of(undefined)
        });

        // Create overlay and show widget
        const overlayManager = this.view.state.field(checkboxWidgetState).overlayManager;
        overlayManager.create(target);

        this.view.dispatch({
            effects: showWidgetEffect.of({ 
                pos: pos, 
                line: line.number - 1
            })
        });
    }

    // Mouse event handlers
    handleMouseDown = (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        
        if (this.isCheckboxTarget(target)) {
            this.lastTarget = target;
            this.cleanupTimer();
            
            const plugin = this.view.state.field(pluginInstanceField);
            this.timer = setTimeout(() => {
                if (this.lastTarget === target) {
                    this.handleLongPress(target, event.clientX, event.clientY);
                    event.preventDefault();
                }
            }, plugin.settings.longPressDuration);
        }
    };

    handleMouseUp = () => {
        this.cleanupTimer();
        this.isLongPress = false;
        this.lastTarget = null;
    };

    // Touch event handlers
    handleTouchStart = (event: TouchEvent) => {
        const target = event.target as HTMLElement;
        
        if (this.isCheckboxTarget(target) && event.touches.length === 1) {
            const touch = event.touches[0];
            this.lastTarget = target;
            this.startPos = { x: touch.clientX, y: touch.clientY };
            this.cleanupTimer();
            
            const plugin = this.view.state.field(pluginInstanceField);
            this.timer = setTimeout(() => {
                if (this.lastTarget === target) {
                    this.handleLongPress(target, touch.clientX, touch.clientY);
                    event.preventDefault();
                }
            }, plugin.settings.touchLongPressDuration);
        }
    };

    handleTouchMove = (event: TouchEvent) => {
        if (this.startPos && event.touches.length === 1) {
            const touch = event.touches[0];
            const deltaX = Math.abs(touch.clientX - this.startPos.x);
            const deltaY = Math.abs(touch.clientY - this.startPos.y);
            
            // Cancel long press if user moves finger too much (scrolling)
            if (deltaX > 10 || deltaY > 10) {
                this.cleanupTimer();
                this.lastTarget = null;
                this.startPos = null;
            }
        }
    };

    handleTouchEnd = () => {
        this.cleanupTimer();
        this.isLongPress = false;
        this.lastTarget = null;
        this.startPos = null;
    };
});

export default class CheckboxStyleMenuPlugin extends Plugin {
    settings: CheckboxStyleSettings;
    public checkboxStyles = CHECKBOX_STYLES.map(style => ({ ...style, enabled: false }));
    private settingsStyleEl: HTMLStyleElement | null = null;

    async onload() {
        await this.loadSettings();
        
        // Initialize enabled states
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol] ?? false;
        });

        this.createSettingsStyles();
        this.registerEditorExtensions();
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));

        console.log('Loaded Checkbox Style Menu');
    }

    onunload() {
        this.removeSettingsStyles();
        console.log('Unloaded Checkbox Style Menu');
    }

    private createSettingsStyles() {
        this.settingsStyleEl = document.createElement('style');
        this.settingsStyleEl.textContent = SETTINGS_STYLES;
        document.head.appendChild(this.settingsStyleEl);
    }

    private removeSettingsStyles() {
        if (this.settingsStyleEl) {
            this.settingsStyleEl.remove();
            this.settingsStyleEl = null;
        }
    }

    private registerEditorExtensions() {
        this.registerEditorExtension([
            checkboxWidgetState,
            checkboxViewPlugin,
            pluginInstanceField.init(() => this)
        ]);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    public isCheckboxLine(line: string): boolean {
        return CHECKBOX_REGEX.test(line);
    }
}

// Enhanced settings tab with mobile considerations
class CheckboxStyleSettingTab extends PluginSettingTab {
    plugin: CheckboxStyleMenuPlugin;

    constructor(app: App, plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Checkbox Style Menu Settings' });

        this.addDurationSettings(containerEl);
        this.addMobileSettings(containerEl);
        this.addStyleToggles(containerEl);
    }

    private addDurationSettings(containerEl: HTMLElement) {
        // Desktop long press duration
        this.createDurationSetting(
            containerEl,
            'Long press duration (Desktop)',
            'How long to hold down the mouse button on a checkbox before the style menu appears',
            'longPressDuration',
            100,
            1000
        );

        // Mobile long press duration
        this.createDurationSetting(
            containerEl,
            'Long press duration (Mobile)',
            'How long to hold touch on a checkbox before the style menu appears on mobile devices',
            'touchLongPressDuration',
            200,
            1500
        );
    }

    private addMobileSettings(containerEl: HTMLElement) {
        if (Platform.isMobile) {
            new Setting(containerEl)
                .setName('Enable haptic feedback')
                .setDesc('Provide haptic feedback when long pressing checkboxes on mobile devices')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableHapticFeedback)
                    .onChange(async (value) => {
                        this.plugin.settings.enableHapticFeedback = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }

    private createDurationSetting(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        settingKey: keyof CheckboxStyleSettings,
        min: number,
        max: number
    ) {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc);
        
        let sliderComponent: any;
        let textComponent: any;
        
        setting
            .addSlider(slider => {
                sliderComponent = slider;
                return slider
                    .setLimits(min, max, 50)
                    .setValue(this.plugin.settings[settingKey] as number)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        (this.plugin.settings[settingKey] as number) = value;
                        await this.plugin.saveSettings();
                        textComponent.setValue(value.toString());
                    });
            })
            .addText(text => {
                textComponent = text;
                return text
                    .setPlaceholder((settingKey === 'longPressDuration' ? '350' : '500'))
                    .setValue((this.plugin.settings[settingKey] as number).toString())
                    .onChange(async (value) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue >= min && numValue <= max) {
                            (this.plugin.settings[settingKey] as number) = numValue;
                            await this.plugin.saveSettings();
                            sliderComponent.setValue(numValue);
                        }
                    });
            });
    }

    private addStyleToggles(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Checkbox Styles' });
        containerEl.createEl('p', { 
            text: 'Choose which checkbox styles to show in the menu:', 
            cls: 'setting-item-description' 
        });

        const toggleContainer = containerEl.createEl('div', {
            cls: 'checkbox-style-toggles',
        });

        this.plugin.checkboxStyles.forEach(style => {
            const setting = new Setting(toggleContainer);
            const fragment = document.createDocumentFragment();
            const nameContainer = document.createElement('div');
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian';

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
                }));
        });
    }
}