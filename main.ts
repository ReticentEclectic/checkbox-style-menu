//Main.ts for Checkbox Style Menu

import { Plugin, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, setTooltip, Platform, Notice } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, WidgetType } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';


// Plugin settings interface for checkbox style configuration
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };  // Which checkbox styles are enabled
    longPressDuration: number;              // Desktop long press duration (ms)
    touchLongPressDuration: number;         // Mobile long press duration (ms)
    enableHapticFeedback: boolean;          // Mobile haptic feedback setting
}

// Consolidated widget state
interface WidgetState {
    isVisible: boolean;
    position: number;
    timer: NodeJS.Timeout | null;
    lastTarget: HTMLElement | null;
    touchStart?: { x: number; y: number; time: number };
}

/**
 * CONSTANTS AND CONFIGURATION
 */

// Master list of available checkbox styles - single source of truth
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

// Pre-compiled regex patterns for performance
const CHECKBOX_REGEX = /^\s*(?:-|\d+\.)\s*\[(.)\]\s*(.*)?$/;        // Matches both "- [ ]" and "1. [ ]"
const CHECKBOX_SYMBOL_REGEX = /(?:-|\d+\.)\s*\[(.)\]/;              // Matches checkbox part in both formats

// Default plugin settings with validation
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: Object.fromEntries(
        CHECKBOX_STYLES.map(style => [style.symbol, [' ', '/', 'x', '-'].includes(style.symbol)])
    ),
    longPressDuration: 350,         // Desktop long press (ms)
    touchLongPressDuration: 500,    // Mobile long press (ms)
    enableHapticFeedback: true,     // Mobile haptic feedback
};

// CSS styles for the menu widget and settings panel
const SETTINGS_STYLES = `
    /* Menu widget CSS custom properties for theming */
    .checkbox-style-menu-widget {
        --menu-bg: var(--background-primary);
        --menu-border: var(--background-modifier-border);
        --menu-shadow: var(--background-modifier-box-shadow);
        --menu-hover: var(--background-modifier-hover);
    }
    
    /* Settings panel styles */
    .checkbox-style-toggles .setting-item-name ul {
        margin: 0;
    }
    
    .checkbox-style-toggles .setting-item-name li {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--font-text-size);
    }
    
    .checkbox-style-toggles .setting-item-name .task-list-item-checkbox {
        flex-shrink: 0;
    }
    
    /* Mobile-specific styling */
    @media (max-width: 768px) {
        .checkbox-style-toggles .setting-item-name li {
            font-size: calc(var(--font-text-size) * 1.1);
        }
        
        .checkbox-style-toggles .setting-item-name .task-list-item-checkbox {
            transform: scale(1.2);
        }
    }
`;

/**
 * CODEMIRROR STATE EFFECTS
 * Used to communicate with CodeMirror's state management system
 */

// State effect for showing the widget menu
const showWidgetEffect = StateEffect.define<{ 
    pos: number; 
    line: number; 
}>({
    map: (val, change) => ({ 
        pos: change.mapPos(val.pos), 
        line: val.line
    })
});

// State effect for hiding the widget menu
const hideWidgetEffect = StateEffect.define<void>();

/**
 * PERFORMANCE UTILITIES
 */

// Simplified DOM cache for expensive calculations only
class SimpleDOMCache {
    private static cache = new WeakMap<HTMLElement, { rect: DOMRect; timestamp: number }>();
    private static readonly CACHE_TTL = 100; // Cache time-to-live in milliseconds
    
    /**
     * Get cached bounding rectangle or calculate and cache new one
     * @param element - HTML element to get bounds for
     * @returns Cached or fresh DOMRect
     */
    static getCheckboxRect(element: HTMLElement): DOMRect {
        // Use element's position in DOM as cache key
        const cached = this.cache.get(element);
        const now = Date.now();
        
        if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
            return cached.rect;
        }
        
        const rect = element.getBoundingClientRect();
        this.cache.set(element, { rect, timestamp: now });
        return rect;
    }
    
    /**
     * Create a throttled version of a function
     * @param func - Function to throttle
     * @param delay - Minimum delay between executions (ms)
     * @returns Throttled function
     */
    static throttle<T extends (...args: any[]) => void>(func: T, delay: number): T {
        let lastCall = 0;
        return ((...args: Parameters<T>) => {
            const now = Date.now();
            if (now - lastCall >= delay) {
                lastCall = now;
                return func(...args);
            }
        }) as T;
    }
}

/**
 * WIDGET POOL FOR PERFORMANCE
 * Reuses widget instances to reduce garbage collection
 */
class WidgetPool {
    private static pool: CheckboxStyleWidget[] = [];
    private static readonly MAX_POOL_SIZE = 3;
    
    static get(plugin: CheckboxStyleMenuPlugin, pos: number): CheckboxStyleWidget {
        const widget = this.pool.pop() || new CheckboxStyleWidget(plugin, pos);
        widget.reset(pos);
        return widget;
    }
    
    static release(widget: CheckboxStyleWidget) {
        if (this.pool.length < this.MAX_POOL_SIZE) {
            widget.cleanup();
            this.pool.push(widget);
        }
    }
    
    static clear() {
        this.pool.forEach(widget => widget.destroy());
        this.pool = [];
    }
}

/**
 * OVERLAY MANAGEMENT
 * Simplified overlay that prevents checkbox clicks during menu display
 */
class OverlayManager {
    private overlayElement: HTMLElement | null = null;
    private abortController: AbortController | null = null;

    /**
     * Create overlay element positioned over the checkbox
     * @param checkbox - The checkbox element to overlay
     * @returns The created overlay element
     */
    create(checkbox: HTMLElement): HTMLElement {
        this.remove(); // Clean up any existing overlay
        
        const checkboxRect = SimpleDOMCache.getCheckboxRect(checkbox);
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'checkbox-overlay';
        
        // Position overlay exactly over the checkbox
        Object.assign(this.overlayElement.style, {
            position: 'fixed',
            top: `${checkboxRect.top}px`,
            left: `${checkboxRect.left}px`,
            width: `${checkboxRect.width}px`,
            height: `${checkboxRect.height}px`,
            zIndex: '999',
            background: 'transparent',
            cursor: 'default',
            pointerEvents: 'auto'
        });
        
        this.setupEventListeners();
        document.body.appendChild(this.overlayElement);
        
        return this.overlayElement;
    }

    /**
     * Set up event listeners to prevent checkbox interaction
     */
    private setupEventListeners() {
        if (!this.overlayElement) return;

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        // Prevent all checkbox click events
        const preventEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        };
        
        // Block all interaction events
        ['mouseup', 'mousedown', 'click', 'touchstart', 'touchend', 'touchcancel'].forEach(eventType => {
            this.overlayElement!.addEventListener(eventType, preventEvent, { signal, passive: false });
        });
        
        // Handle scroll with throttling
        const throttledWheelHandler = SimpleDOMCache.throttle(() => {
            if (this.overlayElement) {
                this.overlayElement.style.pointerEvents = 'none';
                setTimeout(() => {
                    if (this.overlayElement) {
                        this.overlayElement.style.pointerEvents = 'auto';
                    }
                }, 10);
            }
        }, 16);

        this.overlayElement.addEventListener('wheel', throttledWheelHandler, { signal });
        
        // Mobile scroll detection
        if (Platform.isMobile) {
            let startY = 0;
            
            this.overlayElement.addEventListener('touchstart', (e: TouchEvent) => {
                startY = e.touches[0].clientY;
            }, { signal });
            
            this.overlayElement.addEventListener('touchmove', (e: TouchEvent) => {
                const currentY = e.touches[0].clientY;
                if (Math.abs(currentY - startY) > 10) {
                    this.remove();
                }
            }, { signal });
        }
    }

    /**
     * Remove overlay and clean up all event listeners
     */
    remove() {
        if (this.abortController) {
            this.abortController.abort(); // Removes all listeners at once
            this.abortController = null;
        }
        
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
    }

    /**
     * Get the current overlay element
     */
    get element() {
        return this.overlayElement;
    }
}

/**
 * CHECKBOX STYLE MENU WIDGET
 * CodeMirror widget that displays the checkbox style selection menu
 */
class CheckboxStyleWidget extends WidgetType {
    private plugin: CheckboxStyleMenuPlugin;
    private linePos: number;
    private menuTimeout: NodeJS.Timeout | null = null;
    private abortController: AbortController | null = null;
    private enabledStyles: Array<{ symbol: string; description: string; enabled: boolean }> | null = null;

    constructor(plugin: CheckboxStyleMenuPlugin, linePos: number) {
        super();
        this.plugin = plugin;
        this.linePos = linePos;
    }

    /**
     * Reset widget for reuse (performance optimization)
     */
    reset(linePos: number) {
        this.cleanup();
        this.linePos = linePos;
        this.enabledStyles = null; // Force refresh of enabled styles
    }

    /**
     * Check if this widget is equivalent to another (for CodeMirror optimization)
     */
    eq(other: CheckboxStyleWidget) {
        return this.linePos === other.linePos;
    }

    /**
     * Hide the widget and clean up
     * @param view - CodeMirror editor view
     */
    private hideWidget(view: EditorView) {
        // Clean up any lingering tooltips
        document.querySelectorAll('.tooltip, [class*="tooltip"]').forEach(tooltip => {
            tooltip.remove();
        });
        
        view.dispatch({
            effects: hideWidgetEffect.of(undefined)
        });
    }

    /**
     * Clean up widget resources without destroying
     */
    cleanup() {
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
        
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
    }

    /**
     * Full cleanup and destruction
     */
    destroy() {
        this.cleanup();
        this.enabledStyles = null;
    }

    /**
     * Simplified positioning that maintains all current behavior
     */
    private positionMenu(view: EditorView, container: HTMLElement, menu: HTMLElement) {
        const line = view.state.doc.lineAt(this.linePos);
        const lineDOM = view.domAtPos(line.from);
        
        const lineElement = lineDOM.node.nodeType === Node.ELEMENT_NODE 
            ? (lineDOM.node as HTMLElement).closest('.cm-line') as HTMLElement | null
            : lineDOM.node.parentElement?.closest('.cm-line') as HTMLElement | null;
        
        const checkbox = lineElement?.querySelector('.task-list-item-checkbox') as HTMLElement;
        
        if (!checkbox || !lineElement) {
            // Fallback positioning
            container.style.cssText += 'transform: translateX(-100%); margin-left: -8px;';
            return;
        }
        
        const checkboxRect = SimpleDOMCache.getCheckboxRect(checkbox);
        const editorRect = SimpleDOMCache.getCheckboxRect(view.scrollDOM);
        
        if (Platform.isMobile) {
            this.positionForMobile(container, menu, checkboxRect, editorRect, lineElement);
        } else {
            this.positionForDesktop(container, menu, checkboxRect, editorRect, lineElement);
        }
        
        this.adjustForViewportBounds(container, menu, editorRect);
    }

    /**
     * Mobile positioning: Above checkbox (or below if no room), left-aligned with horizontal scroll
     */
    private positionForMobile(container: HTMLElement, menu: HTMLElement, checkboxRect: DOMRect, editorRect: DOMRect, lineElement: HTMLElement) {
        const menuHeight = menu.offsetHeight || 60;
        const lineRect = SimpleDOMCache.getCheckboxRect(lineElement);
        
        // Calculate position relative to the line element (since container is positioned relative to it)
        const checkboxTopInLine = checkboxRect.top - lineRect.top;
        const checkboxBottomInLine = checkboxTopInLine + checkboxRect.height;
        
        // Calculate available space relative to editor bounds
        const spaceAbove = checkboxRect.top - editorRect.top;
        const spaceBelow = editorRect.bottom - checkboxRect.bottom;
        
        // Determine if we should position above or below
        const shouldPositionAbove = spaceAbove >= menuHeight + 20 || spaceAbove > spaceBelow;
        
        let top: number;
        if (shouldPositionAbove) {
            // Position above checkbox with spacing
            top = checkboxTopInLine - menuHeight - 12;
        } else {
            // Position below checkbox with spacing
            top = checkboxBottomInLine + 8;
        }
        
        // Align first menu item horizontally with the checkbox (like desktop does vertically)
        const menuOffset = 22;
        const checkboxLeftInLine = checkboxRect.left - lineRect.left;
        const left = checkboxLeftInLine - menuOffset;
        
        container.style.cssText += `
            position: absolute;
            top: ${top}px;
            left: ${left}px;
            transform: none;
        `;
        
        // Use the remaining line width from checkbox position as the content boundary
        const maxWidth = lineRect.width - checkboxLeftInLine + menuOffset + 16;
        menu.style.maxWidth = `${maxWidth}px`;
    }

    /**
     * Desktop positioning: First item aligned with checkbox, left-preferred with right fallback
     */
    private positionForDesktop(container: HTMLElement, menu: HTMLElement, checkboxRect: DOMRect, editorRect: DOMRect, lineElement: HTMLElement) {
        const lineRect = SimpleDOMCache.getCheckboxRect(lineElement);
        const checkboxLeft = checkboxRect.left - lineRect.left;
        const menuWidth = menu.offsetWidth;
        const spacing = 8;
        
        // Check available space on both sides
        const availableLeft = checkboxRect.left - editorRect.left;
        const availableRight = editorRect.right - checkboxRect.right;
        
        // Prefer left side, use right if insufficient space on left
        const useRightSide = menuWidth > availableLeft - spacing && availableRight > menuWidth + spacing;
        
        // Vertical alignment: first menu item aligns with checkbox center
        const verticalOffset = -3;
        
        if (useRightSide) {
            // Position to right of checkbox
            container.style.cssText += `
                left: ${checkboxLeft + checkboxRect.width + spacing}px;
                top: ${verticalOffset}px;
                transform: none;
            `;
        } else {
            // Position to left of checkbox
            container.style.cssText += `
                left: ${checkboxLeft - spacing}px; 
                top: ${verticalOffset}px;
                transform: translateX(-100%);
            `;
        }
    }

    /**
     * Simplified viewport bounds checking
     */
    private adjustForViewportBounds(container: HTMLElement, menu: HTMLElement, editorRect: DOMRect) {
        // Only adjust for mobile overflow
        if (!Platform.isMobile) return;
        
        requestAnimationFrame(() => {
            const menuRect = menu.getBoundingClientRect();
            
            // Adjust if menu overflows viewport
            if (menuRect.bottom > window.innerHeight) {
                const overflow = menuRect.bottom - window.innerHeight;
                const currentTop = parseFloat(container.style.top) || 0;
                container.style.top = `${currentTop - overflow - 8}px`;
            }
            
            if (menuRect.top < 0) {
                container.style.top = '8px';
            }
        });
    }

    /**
     * Create the DOM element for the widget
     * @param view - CodeMirror editor view
     * @returns The widget's DOM element
     */
    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('div');
        container.className = 'checkbox-style-menu-widget';
        
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
                overflow: visible;
                white-space: nowrap;
            ` : ''}
        `;

        this.renderMenuContent(view, menu);
        this.setupEventListeners(view, menu);
        
        container.appendChild(menu);
        
        // Position and show menu after DOM is ready
        requestAnimationFrame(() => {
            this.positionMenu(view, container, menu);
            menu.style.visibility = 'visible';
        });
        
        return container;
    }

    /**
     * Render markdown content for the menu items
     * @param view - CodeMirror editor view
     * @param menu - Menu element to render into
     */
    private async renderMenuContent(view: EditorView, menu: HTMLElement) {
        const enabledStyles = this.getEnabledStyles();
        if (enabledStyles.length === 0) {
            menu.textContent = 'No styles enabled';
            return;
        }

        // Create markdown list of checkbox styles
        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');
        const renderChild = new MarkdownRenderChild(menu);
        this.plugin.addChild(renderChild);
        
        // Render markdown using Obsidian's renderer
        await MarkdownRenderer.render(
            this.plugin.app,
            markdown,
            menu,
            '',
            renderChild
        );

        this.styleRenderedMarkdown(menu, enabledStyles);
    }

    /**
     * Get list of enabled checkbox styles (cached for performance)
     * @returns Array of enabled checkbox styles
     */
    private getEnabledStyles() {
        if (!this.enabledStyles) {
            this.enabledStyles = this.plugin.checkboxStyles.filter(style => style.enabled);
        }
        return this.enabledStyles;
    }

    /**
     * Apply custom styling to the rendered markdown menu
     * @param menu - Menu element
     * @param enabledStyles - Array of enabled styles
     */
    private styleRenderedMarkdown(menu: HTMLElement, enabledStyles: any[]) {
        // Style the markdown preview container
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

        // Style the list container
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
                    scrollbar-width: none;
                    -ms-overflow-style: none;
                    scroll-behavior: smooth;
                    -webkit-overflow-scrolling: touch;
                ` : ''}
            `;
            
            // Hide scrollbars on mobile
            if (isMobile) {
                this.addScrollbarStyles();
            }
        }

        this.setupListItemStyles(menu, enabledStyles);
        
        // Add scroll indicators for mobile horizontal scrolling
        if (Platform.isMobile && ul) {
            this.addScrollIndicators(menu, ul);
        }
    }

    /**
     * Add styles to hide scrollbars on mobile
     */
    private addScrollbarStyles() {
        if (!document.getElementById('checkbox-menu-styles')) {
            const style = document.createElement('style');
            style.id = 'checkbox-menu-styles';
            style.textContent = `
                .checkbox-style-menu ul::-webkit-scrollbar {
                    display: none;
                }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * Add scroll indicators for mobile horizontal menu scrolling
     * @param menu - Menu container
     * @param scrollContainer - Scrollable list container
     */
    private addScrollIndicators(menu: HTMLElement, scrollContainer: HTMLElement) {
        const createIndicator = (direction: 'left' | 'right') => {
            const indicator = document.createElement('div');
            indicator.className = `scroll-indicator scroll-indicator-${direction}`;
            indicator.textContent = direction === 'left' ? '‹' : '›';
            indicator.style.cssText = `
                position: absolute;
                ${direction}: 0px;
                top: 50%;
                transform: translateY(-50%);
                background: linear-gradient(to ${direction === 'left' ? 'right' : 'left'}, var(--menu-bg) 60%, transparent);
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
                border-radius: ${direction === 'left' ? '4px 0 0 4px' : '0 4px 4px 0'};
            `;
            return indicator;
        };

        const leftIndicator = createIndicator('left');
        const rightIndicator = createIndicator('right');

        menu.style.position = 'relative';
        menu.appendChild(leftIndicator);
        menu.appendChild(rightIndicator);

        // Throttled function to update indicator visibility
        const updateIndicators = SimpleDOMCache.throttle(() => {
            const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
            const canScrollLeft = scrollLeft > 5;
            const canScrollRight = scrollLeft < scrollWidth - clientWidth - 5;

            leftIndicator.style.opacity = canScrollLeft ? '1' : '0';
            rightIndicator.style.opacity = canScrollRight ? '1' : '0';
        }, 16);

        // Setup with AbortController for easy cleanup
        this.abortController = this.abortController || new AbortController();
        const signal = this.abortController.signal;

        setTimeout(updateIndicators, 100);
        scrollContainer.addEventListener('scroll', updateIndicators, { signal, passive: true });
        window.addEventListener('resize', updateIndicators, { signal, passive: true });
    }

    /**
     * Style individual list items (checkbox buttons)
     * @param menu - Menu container
     * @param enabledStyles - Array of enabled styles
     */
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

            // Style the checkbox element
            const checkbox = li.querySelector('.task-list-item-checkbox') as HTMLElement | null;
            if (checkbox) {
                checkbox.style.margin = '0 auto';
                if (isMobile) {
                    checkbox.style.transform = 'scale(1.2)';
                }
            }

            // Add tooltip with style description
            this.plugin.app.workspace.onLayoutReady(() => {
                setTooltip(li as HTMLElement, enabledStyles[index].description, {
                    placement: isMobile ? 'top' : 'right'
                });
            });

            // Set accessibility and data attributes
            li.setAttribute('data-style-index', index.toString());
            li.setAttribute('role', 'menuitem');
        });
    }

    /**
     * Consolidated event listener setup using AbortController
     * @param view - CodeMirror editor view
     * @param menu - Menu element
     */
    private setupEventListeners(view: EditorView, menu: HTMLElement) {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const isMobile = Platform.isMobile;
        
        // Desktop hover effects
        if (!isMobile) {
            menu.addEventListener('mouseenter', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) li.style.background = 'var(--menu-hover)';
            }, { signal, capture: true });

            menu.addEventListener('mouseleave', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) li.style.background = '';
            }, { signal, capture: true });
        }

        // Platform-specific interaction handling
        if (isMobile) {
            this.setupMobileTouchHandling(view, menu, signal);
        } else {
            this.setupDesktopClickHandling(view, menu, signal);
        }

        this.setupMenuTimeouts(view, menu, signal);
    }

    /**
     * Simplified mobile touch handling
     * @param view - CodeMirror editor view
     * @param menu - Menu element
     * @param signal - AbortController signal for cleanup
     */
    private setupMobileTouchHandling(view: EditorView, menu: HTMLElement, signal: AbortSignal) {
        let touchStart: { x: number; y: number; time: number } | null = null;
        const scrollThreshold = 10;
        const tapTimeThreshold = 300;

        menu.addEventListener('touchstart', (e: TouchEvent) => {
            const touch = e.touches[0];
            touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
            
            const li = (e.target as HTMLElement).closest('li');
            if (li) li.style.background = 'var(--menu-hover)';
        }, { signal, passive: false });

        menu.addEventListener('touchend', (e: TouchEvent) => {
            const li = (e.target as HTMLElement).closest('li');
            if (li) {
                setTimeout(() => li.style.background = '', 150);
            }

            if (!touchStart || !li) return;

            const touch = e.changedTouches[0];
            const touchEnd = { x: touch.clientX, y: touch.clientY, time: Date.now() };
            
            const deltaX = Math.abs(touchEnd.x - touchStart.x);
            const deltaY = Math.abs(touchEnd.y - touchStart.y);
            const duration = touchEnd.time - touchStart.time;

            // Check if this was a tap vs scroll gesture
            const isTap = deltaX < scrollThreshold && 
                        deltaY < scrollThreshold && 
                        duration < tapTimeThreshold;

            if (isTap) {
                e.preventDefault();
                e.stopPropagation();
                
                const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
                const enabledStyles = this.getEnabledStyles();
                const symbol = enabledStyles[index].symbol;
                
                // Provide haptic feedback if enabled
                if (this.plugin.settings.enableHapticFeedback && 'vibrate' in navigator) {
                    navigator.vibrate(50);
                }
                
                this.applyCheckboxStyle(view, symbol);
                this.hideWidget(view);
            }

            touchStart = null;
        }, { signal, passive: false });

        menu.addEventListener('touchcancel', () => {
            const li = menu.querySelector('li[style*="background"]') as HTMLElement;
            if (li) li.style.background = '';
            touchStart = null;
        }, { signal, passive: true });
    }

    /**
     * Simplified desktop click handling
     * @param view - CodeMirror editor view
     * @param menu - Menu element
     * @param signal - AbortController signal for cleanup
     */
    private setupDesktopClickHandling(view: EditorView, menu: HTMLElement, signal: AbortSignal) {
        menu.addEventListener('mouseup', (e: MouseEvent) => {
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
        }, { signal });
    }

    /**
     * Simplified timeout handling
     * @param view - CodeMirror editor view
     * @param menu - Menu element
     * @param signal - AbortController signal for cleanup
     */
    private setupMenuTimeouts(view: EditorView, menu: HTMLElement, signal: AbortSignal) {
        const eventType = Platform.isMobile ? 'touchstart' : 'mousedown';
        const dismissTimeout = Platform.isMobile ? 3000 : 2000;
        
        this.startDismissTimeout(view, dismissTimeout);

        const editorContainer = view.dom.closest('.workspace-leaf') || view.dom;
        
        // Hide menu when clicking outside
        const handleGlobalInteraction = (e: Event) => {
            if (!menu.contains(e.target as Node)) {
                this.hideWidget(view);
            }
        };

        editorContainer.addEventListener(eventType, handleGlobalInteraction, { signal, capture: true });
        
        // Platform-specific timeout management
        if (Platform.isMobile) {
            menu.addEventListener('touchstart', () => this.clearTimeout(), { signal });
            menu.addEventListener('touchend', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (!li) { // Only restart timeout if not selecting a style
                    setTimeout(() => this.startDismissTimeout(view, dismissTimeout), 100);
                }
            }, { signal });
        } else {
            menu.addEventListener('mouseenter', () => this.clearTimeout(), { signal });
            menu.addEventListener('mouseleave', () => this.startDismissTimeout(view, dismissTimeout), { signal });
        }
    }

    /**
     * Clear the dismiss timeout
     */
    private clearTimeout() {
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
    }

    /**
     * Start the auto-dismiss timeout
     * @param view - CodeMirror editor view
     * @param delay - Delay in milliseconds
     */
    private startDismissTimeout(view: EditorView, delay: number) {
        this.clearTimeout();
        this.menuTimeout = setTimeout(() => {
            this.hideWidget(view);
        }, delay);
    }

    /**
     * Apply the selected checkbox style to the current line
     * @param view - CodeMirror editor view
     * @param symbol - Checkbox symbol to apply
     */
    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const state = view.state;
        const line = state.doc.lineAt(this.linePos);
        const text = line.text;

        // Verify this is actually a checkbox line
        if (!this.plugin.isCheckboxLine(text)) {
            return;
        }

        // Find the checkbox symbol position
        const match = text.match(CHECKBOX_SYMBOL_REGEX);
        if (!match) {
            return;
        }

        // Calculate exact position of the symbol to replace
        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const from = line.from + startIndex;
        const to = from + 1;

        // Apply the change to the document
        view.dispatch({
            changes: { from, to, insert: symbol },
        });
    }
}

/**
 * CODEMIRROR STATE MANAGEMENT
 */

// State field to manage widget decorations and overlay
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

        // Handle state effects
        for (let effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                const { pos } = effect.value;
                const widget = Decoration.widget({
                    widget: WidgetPool.get(tr.state.field(pluginInstanceField), pos),
                    side: 1
                });
                decorations = Decoration.set([widget.range(pos)]);
            } else if (effect.is(hideWidgetEffect)) {
                // Return widget to pool if possible
                const currentWidget = state.decorations.iter().value;
                if (currentWidget && 'widget' in currentWidget.spec && currentWidget.spec.widget instanceof CheckboxStyleWidget) {
                    WidgetPool.release(currentWidget.spec.widget as CheckboxStyleWidget);
                }
                
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

/**
 * INTERACTION HANDLER
 * Consolidated long press detection for both platforms
 */
class InteractionHandler {
    private state: WidgetState = {
        isVisible: false,
        position: -1,
        timer: null,
        lastTarget: null
    };
    private abortController: AbortController | null = null;

    constructor(private view: EditorView, private plugin: CheckboxStyleMenuPlugin) {
        this.setupEventListeners();
    }

    /**
     * Set up platform-appropriate event listeners
     */
    private setupEventListeners() {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        if (Platform.isMobile) {
            this.view.dom.addEventListener('touchstart', this.handleTouchStart.bind(this), { signal, passive: false });
            this.view.dom.addEventListener('touchend', this.handleTouchEnd.bind(this), { signal, passive: false });
            this.view.dom.addEventListener('touchmove', this.handleTouchMove.bind(this), { signal, passive: false });
        } else {
            this.view.dom.addEventListener('mousedown', this.handleMouseDown.bind(this), { signal });
            this.view.dom.addEventListener('mouseup', this.handleMouseUp.bind(this), { signal });
        }
    }

    /**
     * Clean up event listeners and timers
     */
    destroy() {
        this.clearTimer();
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Update consolidated state
     */
    private updateState(updates: Partial<WidgetState>) {
        Object.assign(this.state, updates);
    }

    /**
     * Clear any active timer
     */
    private clearTimer() {
        if (this.state.timer) {
            clearTimeout(this.state.timer);
            this.updateState({ timer: null });
        }
    }

    /**
     * Check if target is a handleable checkbox
     */
    private isCheckboxTarget(target: HTMLElement): boolean {
        return target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu');
    }

    /**
     * Handle long press detection and show menu
     */
    private handleLongPress(target: HTMLElement) {
        try {
            const pos = this.view.posAtDOM(target);
            if (pos === null || pos < 0 || pos > this.view.state.doc.length) {
                return;
            }

            const line = this.view.state.doc.lineAt(pos);
            
            // Verify this is actually a checkbox line
            if (!this.plugin.isCheckboxLine(line.text)) {
                return;
            }

            this.updateState({ isVisible: true, position: pos });
            
            // Provide haptic feedback on mobile
            if (Platform.isMobile && this.plugin.settings.enableHapticFeedback && 'vibrate' in navigator) {
                navigator.vibrate(75);
            }

            // Hide any existing widget first
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
        } catch (error) {
            console.error('Error in handleLongPress:', error);
        }
    }

    /**
     * MOUSE EVENT HANDLERS (Desktop)
     */
    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        
        if (this.isCheckboxTarget(target)) {
            this.updateState({ lastTarget: target });
            this.clearTimer();
            
            const timer = setTimeout(() => {
                if (this.state.lastTarget === target) {
                    this.handleLongPress(target);
                    event.preventDefault();
                }
            }, this.plugin.settings.longPressDuration);
            
            this.updateState({ timer });
        }
    }

    private handleMouseUp() {
        this.clearTimer();
        this.updateState({ lastTarget: null });
    }

    /**
     * TOUCH EVENT HANDLERS (Mobile)
     */
    private handleTouchStart(event: TouchEvent) {
        const target = event.target as HTMLElement;
        
        if (this.isCheckboxTarget(target) && event.touches.length === 1) {
            const touch = event.touches[0];
            this.updateState({ 
                lastTarget: target,
                touchStart: { x: touch.clientX, y: touch.clientY, time: Date.now() }
            });
            this.clearTimer();
            
            const timer = setTimeout(() => {
                if (this.state.lastTarget === target) {
                    this.handleLongPress(target);
                    event.preventDefault();
                }
            }, this.plugin.settings.touchLongPressDuration);
            
            this.updateState({ timer });
        }
    }

    private handleTouchMove(event: TouchEvent) {
        if (this.state.touchStart && event.touches.length === 1) {
            const touch = event.touches[0];
            const deltaX = Math.abs(touch.clientX - this.state.touchStart.x);
            const deltaY = Math.abs(touch.clientY - this.state.touchStart.y);
            
            // Cancel long press if user moves finger too much (indicating scroll)
            if (deltaX > 10 || deltaY > 10) {
                this.clearTimer();
                this.updateState({ lastTarget: null, touchStart: undefined });
            }
        }
    }

    private handleTouchEnd() {
        this.clearTimer();
        this.updateState({ lastTarget: null, touchStart: undefined });
    }
}

/**
 * CODEMIRROR VIEW PLUGIN
 * Simplified view plugin using the interaction handler
 */
const checkboxViewPlugin = ViewPlugin.fromClass(class {
    private interactionHandler: InteractionHandler;

    constructor(private view: EditorView) {
        const plugin = this.view.state.field(pluginInstanceField);
        this.interactionHandler = new InteractionHandler(view, plugin);
    }

    /**
     * Clean up when view plugin is destroyed
     */
    destroy() {
        this.interactionHandler.destroy();
    }
});

/**
 * MAIN PLUGIN CLASS
 */
export default class CheckboxStyleMenuPlugin extends Plugin {
    settings: CheckboxStyleSettings;
    public checkboxStyles = CHECKBOX_STYLES.map(style => ({ ...style, enabled: false }));
    private settingsStyleEl: HTMLStyleElement | null = null;

    /**
     * Plugin initialization
     */
    async onload() {
        await this.loadSettings();
        
        // Initialize enabled states from settings
        this.updateCheckboxStyles();

        // Set up UI and CodeMirror integration
        this.createSettingsStyles();
        this.registerEditorExtensions();
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));

        console.log('Loaded Checkbox Style Menu');
    }

    /**
     * Plugin cleanup
     */
    onunload() {
        // Clear widget pool and caches
        WidgetPool.clear();

        const dynamicStyle = document.getElementById('checkbox-menu-styles');
        if (dynamicStyle) {
            dynamicStyle.remove();
        }
        
        this.removeSettingsStyles();
        console.log('Unloaded Checkbox Style Menu');
    }

    /**
     * Update checkbox styles enabled state from settings
     */
    private updateCheckboxStyles() {
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol] ?? false;
        });
    }

    /**
     * Inject CSS styles for settings panel
     */
    private createSettingsStyles() {
        this.settingsStyleEl = document.createElement('style');
        this.settingsStyleEl.textContent = SETTINGS_STYLES;
        document.head.appendChild(this.settingsStyleEl);
    }

    /**
     * Remove injected CSS styles
     */
    private removeSettingsStyles() {
        if (this.settingsStyleEl) {
            this.settingsStyleEl.remove();
            this.settingsStyleEl = null;
        }
    }

    /**
     * Register CodeMirror extensions for the editor
     */
    private registerEditorExtensions() {
        this.registerEditorExtension([
            checkboxWidgetState,
            checkboxViewPlugin,
            pluginInstanceField.init(() => this)
        ]);
    }

    /**
     * Save plugin settings with validation and update cached states
     */
    async saveSettings() {
        // Validate settings before saving
        this.settings.longPressDuration = Math.max(100, Math.min(1000, this.settings.longPressDuration));
        this.settings.touchLongPressDuration = Math.max(200, Math.min(1500, this.settings.touchLongPressDuration));
        
        await this.saveData(this.settings);
        this.updateCheckboxStyles(); // Update cached enabled states
    }

    /**
     * Load plugin settings with validation and defaults
     */
    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...data,
            // Validate styles object exists and has valid structure
            styles: this.validateStylesObject(data?.styles),
            // Validate numeric ranges with more robust checking
            longPressDuration: this.validateDuration(data?.longPressDuration, 100, 1000, 350),
            touchLongPressDuration: this.validateDuration(data?.touchLongPressDuration, 200, 1500, 500),
            enableHapticFeedback: typeof data?.enableHapticFeedback === 'boolean' ? data.enableHapticFeedback : true
        };
    }

    private validateDuration(value: any, min: number, max: number, defaultValue: number): number {
        const num = typeof value === 'number' ? value : parseInt(value);
        return !isNaN(num) && num >= min && num <= max ? num : defaultValue;
    }

    private validateStylesObject(styles: any): { [symbol: string]: boolean } {
        if (!styles || typeof styles !== 'object') {
            return DEFAULT_SETTINGS.styles;
        }
        
        // Ensure all expected styles exist
        const validated: { [symbol: string]: boolean } = {};
        CHECKBOX_STYLES.forEach(style => {
            validated[style.symbol] = typeof styles[style.symbol] === 'boolean' ? 
                styles[style.symbol] : 
                DEFAULT_SETTINGS.styles[style.symbol];
        });
        
        return validated;
    }

    /**
     * Check if a line contains a checkbox
     * @param line - Text line to check
     * @returns True if line contains a checkbox
     */
    public isCheckboxLine(line: string): boolean {
        return CHECKBOX_REGEX.test(line);
    }
}

/**
 * CORRECTED SETTINGS TAB CLASS
 * Following proper Obsidian guidelines and simplified style organization
 */
class CheckboxStyleSettingTab extends PluginSettingTab {
    plugin: CheckboxStyleMenuPlugin;

    constructor(app: App, plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Build the settings UI following Obsidian guidelines
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ✅ FIXED: No h1 - Obsidian handles the main title automatically
        // ✅ FIXED: Direct settings, no unnecessary sections for simple settings

        this.addDurationSettings(containerEl);
        this.addMobileSettings(containerEl);
        this.addStyleToggles(containerEl);
    }

    /**
     * ✅ CORRECTED: Simple duration settings without sections
     */
    private addDurationSettings(containerEl: HTMLElement): void {
        // Desktop long press duration
        this.createDurationSetting(
            containerEl,
            'Long-press duration (Desktop)',
            'Hold a checkbox this long to open its style menu.',
            'longPressDuration',
            100,
            1000
        );

        // Mobile long press duration
        this.createDurationSetting(
            containerEl,
            'Long-press duration (Mobile)',
            'Hold a checkbox this long to open its style menu.',
            'touchLongPressDuration',
            200,
            1500
        );
    }

    /**
     * ✅ CORRECTED: Simple mobile settings
     */
    private addMobileSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Enable haptic feedback')
            .setDesc('Provide haptic feedback when long pressing checkboxes on mobile.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableHapticFeedback)
                .onChange(async (value) => {
                    this.plugin.settings.enableHapticFeedback = value;
                    await this.plugin.saveSettings();
                }));
    }

    /**
     * ✅ CORRECTED: Simplified style organization as requested
     */
    private addStyleToggles(containerEl: HTMLElement): void {
        // ✅ Main heading for the style section
        containerEl.createEl('h2', { text: 'Choose which styles to show in the menu:' });

        const toggleContainer = containerEl.createDiv({
            cls: 'checkbox-style-toggles',
        });

        // ✅ SIMPLIFIED: Basic styles group
        this.addStyleCategory(toggleContainer, 'Basic', [
            { symbol: ' ', description: 'To-do' },
            { symbol: '/', description: 'Incomplete' },
            { symbol: 'x', description: 'Done' },
            { symbol: '-', description: 'Cancelled' },
            { symbol: '>', description: 'Forwarded' },
            { symbol: '<', description: 'Scheduling' }
        ]);

        // ✅ SIMPLIFIED: Extras group
        this.addStyleCategory(toggleContainer, 'Extras', [
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
            { symbol: 'd', description: 'Down' }
        ]);

        // ✅ OPTIONAL: Add reset button if you want it
        this.addResetButton(containerEl);
    }

    /**
     * ✅ SIMPLIFIED: Style category with just h3 subheading
     */
    private addStyleCategory(containerEl: HTMLElement, categoryName: string, styles: Array<{symbol: string, description: string}>): void {
        // ✅ Simple h3 subheading for categories
        containerEl.createEl('h3', { text: categoryName });
        
        // Process each style in the category synchronously - no need for async batching
        styles.forEach((style) => {
            this.createStyleToggle(containerEl, style);
        });
    }

    /**
     * ✅ OPTIONAL: Simple reset button
     */
    private addResetButton(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Reset all checkbox style selections to default')
            .addButton(button => button
                .setButtonText('Reset')
                .onClick(async () => {
                    // Reset to default styles
                    this.plugin.settings.styles = { ...DEFAULT_SETTINGS.styles };
                    await this.plugin.saveSettings();
                    this.display(); // Reload settings display
                    new Notice('Checkbox styles reset to default');
                }));
    }

    /**
     * ✅ CORRECTED: Duration setting (keeping your improved version)
     */
    private createDurationSetting(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        settingKey: keyof CheckboxStyleSettings,
        min: number,
        max: number
    ): void {
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
    
    /**
     * ✅ SIMPLIFIED: Style toggle creation without async complexity
     */
    private createStyleToggle(container: HTMLElement, style: {symbol: string, description: string}): void {
        try {
            const setting = new Setting(container);
            
            // Create the markdown preview container
            const nameContainer = container.createDiv();
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian';
            
            const markdown = `- [${style.symbol}] ${style.description}`;
            const renderChild = new MarkdownRenderChild(nameContainer);
            this.plugin.addChild(renderChild);
            
            // Render the checkbox style using Obsidian's markdown renderer
            MarkdownRenderer.render(
                this.app,
                markdown,
                nameContainer,
                '',
                renderChild
            ).then(() => {
                // Create document fragment for the setting name
                const nameFragment = document.createDocumentFragment();
                nameFragment.appendChild(nameContainer);
                
                // Configure the setting with toggle control
                setting.setName(nameFragment);
                setting.addToggle(toggle => toggle
                    .setValue(this.plugin.settings.styles[style.symbol] ?? false)
                    .onChange(async (value) => {
                        this.plugin.settings.styles[style.symbol] = value;
                        // Update plugin's cached state immediately
                        const styleObj = this.plugin.checkboxStyles.find(s => s.symbol === style.symbol);
                        if (styleObj) {
                            styleObj.enabled = value;
                        }
                        await this.plugin.saveSettings();
                    }));
            });
        } catch (error) {
            // Fallback simple toggle
            new Setting(container)
                .setName(`${style.description} [${style.symbol}]`)
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.styles[style.symbol] ?? false)
                    .onChange(async (value) => {
                        this.plugin.settings.styles[style.symbol] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}