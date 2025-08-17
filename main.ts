import { Plugin, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, setTooltip, Platform, Notice } from 'obsidian';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { createPopper, Instance as PopperInstance, Placement } from '@popperjs/core';

/**
 * INTERFACES AND TYPES
 * Define the data structures used throughout the plugin
 */

/** Configuration settings for checkbox style behavior and appearance */
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };  // Which checkbox styles are enabled in the menu
    longPressDuration: number;              // Desktop long-press duration in milliseconds
    touchLongPressDuration: number;         // Mobile long-press duration in milliseconds
    enableHapticFeedback: boolean;          // Whether to provide haptic feedback on mobile
}

/** Internal state for tracking user interactions (mouse/touch events) */
interface WidgetState {
    timer: NodeJS.Timeout | null;    // Timer for long-press detection
    lastTarget: HTMLElement | null;  // Last checkbox element that was pressed
    touchStart?: {                   // Touch gesture tracking data
        x: number; 
        y: number; 
        time: number;
    };
}

/**
 * CONSTANTS AND CONFIGURATION
 * Central definition of all checkbox styles and behavioral parameters
 */

/** 
 * Master registry of all available checkbox styles
 * Each style has a symbol (the character inside [ ]) and a human-readable description
 */
const CHECKBOX_STYLES = [
    // Basic task states - commonly used in most task management systems
    { symbol: ' ', description: 'To-do' },
    { symbol: '/', description: 'Incomplete' },
    { symbol: 'x', description: 'Done' },
    { symbol: '-', description: 'Cancelled' },
    { symbol: '>', description: 'Forwarded' },
    { symbol: '<', description: 'Scheduling' },
    
    // Extended states for more detailed task tracking
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

/** 
 * Regex patterns for identifying and manipulating checkbox markdown
 * CHECKBOX_REGEX: Matches entire checkbox lines (- [ ] text or 1. [x] text)
 * CHECKBOX_SYMBOL_REGEX: Extracts just the checkbox symbol from a line
 */
const CHECKBOX_REGEX = /^\s*(?:-|\d+\.)\s*\[(.)\]\s*(.*)?$/;
const CHECKBOX_SYMBOL_REGEX = /(?:-|\d+\.)\s*\[(.)\]/;

/** Default plugin configuration - basic styles enabled by default */
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: Object.fromEntries(
        CHECKBOX_STYLES.map(style => [style.symbol, [' ', '/', 'x', '-'].includes(style.symbol)])
    ),
    longPressDuration: 350,        // Desktop: shorter duration for precise mouse control
    touchLongPressDuration: 500,   // Mobile: longer duration to avoid accidental activation
    enableHapticFeedback: true,
};

/** 
 * Touch/gesture detection thresholds
 * These prevent accidental menu activation during scrolling or imprecise touches
 */
const SCROLL_THRESHOLD = 10;      // Pixels of movement before canceling long-press
const TAP_TIME_THRESHOLD = 300;   // Maximum duration for a tap vs. long-press

/**
 * CODEMIRROR STATE EFFECTS
 * Define custom events for showing/hiding the style menu widget
 */

/** 
 * Effect to display the checkbox style menu
 * Contains all data needed to position and render the menu
 */
const showWidgetEffect = StateEffect.define<{ 
    pos: number;           // Document position where the checkbox was found
    target: HTMLElement;   // The actual checkbox DOM element
    view: EditorView;      // CodeMirror editor view for applying changes
}>({
    // Ensure the position stays valid when the document changes
    map: (val, change) => ({ 
        ...val,
        pos: change.mapPos(val.pos)
    })
});

/** Effect to hide the currently displayed style menu */
const hideWidgetEffect = StateEffect.define<void>();

/**
 * UTILITY FUNCTIONS
 * Reusable helper functions for common operations
 */

/** 
 * Triggers haptic feedback on mobile devices
 * Provides tactile confirmation when long-pressing checkboxes
 */
const triggerHapticFeedback = (duration = 50) => {
    if (Platform.isMobile && 'vibrate' in navigator) {
        navigator.vibrate(duration);
    }
};

/** 
 * Validates that an element is a legitimate checkbox target
 * Prevents the menu from appearing on checkboxes within the menu itself
 */
const isValidCheckboxTarget = (target: HTMLElement): boolean => {
    return target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu-widget');
};

/** 
 * Throttle utility for performance optimization
 * Limits how frequently a function can be called (useful for scroll/resize events)
 */
const throttle = <T extends (...args: any[]) => void>(func: T, delay: number): T => {
    let lastCall = 0;
    return ((...args: Parameters<T>) => {
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            return func(...args);
        }
    }) as T;
};

/** 
 * Debounce utility for reducing event noise
 * Delays function execution until after events stop firing (useful for scroll indicators)
 */
const debounce = <T extends (...args: any[]) => void>(func: T, delay: number): T => {
    let timeoutId: NodeJS.Timeout;
    return ((...args: Parameters<T>) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func(...args), delay);
    }) as T;
};

/**
 * TARGET CHECKBOX OVERLAY MANAGEMENT
 * Creates an invisible overlay over the target checkbox to prevent normal click behavior
 * while the style menu is open. This ensures the menu doesn't disappear when users
 * accidentally click the original checkbox.
 */
class OverlayManager {
    private overlayElement: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private popperInstance: PopperInstance | null = null;

    /**
     * Creates an invisible overlay that covers the target checkbox exactly
     * Uses Popper.js to maintain perfect positioning even during scrolling
     */
    create(checkbox: HTMLElement): HTMLElement {
        this.remove(); // Clean up any existing overlay
        
        const editorContainer = checkbox.closest('.cm-editor')!;
        
        // Create overlay with same dimensions as checkbox
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'checkbox-overlay';
        
        Object.assign(this.overlayElement.style, {
            position: 'absolute',
            width: `${checkbox.offsetWidth}px`,
            height: `${checkbox.offsetHeight}px`,
            zIndex: '499', // Just below the menu (500+) but above normal content
            pointerEvents: 'auto'
        });
        
        editorContainer.appendChild(this.overlayElement);
        
        // Use Popper.js to keep overlay perfectly aligned with checkbox
        this.setupPopper(checkbox);
        this.setupEventListeners();
        
        return this.overlayElement;
    }

    /**
     * Configures Popper.js to position the overlay exactly over the checkbox
     * Custom modifier ensures pixel-perfect alignment regardless of scrolling
     */
    private setupPopper(checkbox: HTMLElement) {
        if (!this.overlayElement) return;

        this.popperInstance = createPopper(checkbox, this.overlayElement, {
            placement: 'top-start', // Overridden by custom modifier
            strategy: 'absolute',
            modifiers: [
                {
                    // Custom modifier: position overlay exactly over reference element
                    name: 'exactOverlay',
                    enabled: true,
                    phase: 'main',
                    fn: ({ state }) => {
                        state.modifiersData.popperOffsets = {
                            x: state.rects.reference.x,
                            y: state.rects.reference.y,
                        };
                    },
                },
                // Disable standard Popper behaviors since we're doing exact positioning
                {
                    name: 'preventOverflow',
                    enabled: false,
                },
                {
                    name: 'flip',
                    enabled: false,
                },
                {
                    name: 'offset',
                    enabled: false,
                },
                {
                    name: 'computeStyles',
                    options: {
                        adaptive: false,
                        roundOffsets: false,
                    },
                },
                {
                    // Keep overlay positioned during scroll/resize events
                    name: 'eventListeners',
                    options: {
                        scroll: true,
                        resize: true,
                    },
                },
            ],
        });
    }

    /**
     * Sets up event handling for the overlay
     * Blocks normal checkbox interactions while allowing scroll behavior
     */
    private setupEventListeners() {
        if (!this.overlayElement) return;

        this.abortController = new AbortController();
        const { signal } = this.abortController;

        // Block all click/touch interactions on the overlay
        const preventEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        };
        
        ['mouseup', 'mousedown', 'click', 'touchstart', 'touchend', 'touchcancel']
            .forEach(eventType => {
                this.overlayElement!.addEventListener(eventType, preventEvent, 
                    { signal, passive: false });
            });

        if (!Platform.isMobile) {
            // Desktop: Temporarily disable pointer events during scrolling
            // This allows the scroll to pass through to the editor beneath
            const throttledHandler = throttle(() => {
                if (this.overlayElement) {
                    this.overlayElement.style.pointerEvents = 'none';
                    setTimeout(() => {
                        if (this.overlayElement) {
                            this.overlayElement.style.pointerEvents = 'auto';
                        }
                    }, 10);
                }
            }, 16);

            this.overlayElement.addEventListener('wheel', throttledHandler, { signal });
        } else {
            // Mobile: Remove overlay immediately when scrolling starts
            // Mobile scrolling is more gesture-based and less precise
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

        // Extra precision: force Popper updates during editor scrolling
        const editorContainer = this.overlayElement.closest('.cm-editor');
        if (editorContainer) {
            const updateOverlay = throttle(() => {
                this.popperInstance?.update();
            }, 16);
            
            editorContainer.addEventListener('scroll', updateOverlay, { signal, passive: true });
        }
    }

    /** Cleans up all overlay resources */
    remove() {
        this.abortController?.abort();
        this.abortController = null;
        
        if (this.popperInstance) {
            this.popperInstance.destroy();
            this.popperInstance = null;
        }
        
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
    }
}

/**
 * CHECKBOX STYLE MENU WIDGET
 * The main UI component that displays available checkbox styles
 * Handles rendering, positioning, user interaction, and style application
 */
class CheckboxStyleWidget {
    private menuElement: HTMLElement | null = null;
    private popperInstance: PopperInstance | null = null;
    private menuTimeout: NodeJS.Timeout | null = null;
    private abortController: AbortController | null = null;
    private cleanupScrollIndicators?: () => void;

    constructor(
        private plugin: CheckboxStyleMenuPlugin, 
        private linePos: number,      // Document position of the checkbox line
        private targetElement: HTMLElement  // The checkbox DOM element
    ) {}

    /** Main entry point: creates and displays the style menu */
    async show(view: EditorView) {
        await this.createMenu();
        this.setupPopper();           // Position the menu relative to checkbox
        this.setupScrollIndicators(); // Add scroll hints for mobile horizontal scrolling
        this.setupEventListeners(view);
        this.startDismissTimeout(view, Platform.isMobile ? 3000 : 2000); // Auto-hide timer
    }

    /** Hides the menu and cleans up all resources */
    hide(view: EditorView) {
        this.cleanup();
        // Remove any orphaned tooltips that might still be showing
        document.querySelectorAll('.tooltip, [class*="tooltip"]').forEach(el => el.remove());
        view.dispatch({ effects: hideWidgetEffect.of(undefined) });
    }

    /**
     * Creates the menu DOM structure and populates it with enabled checkbox styles
     * Uses Obsidian's markdown renderer to ensure consistent checkbox appearance
     */
    private async createMenu() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'checkbox-style-menu-widget';
        this.menuElement.setAttribute('role', 'menu'); // Accessibility

        // Get only the styles that are enabled in settings
        const enabledStyles = this.plugin.getEnabledStyles();
        if (enabledStyles.length === 0) {
            this.menuElement.textContent = 'No styles enabled';
        } else {
            await this.renderMenuContent(enabledStyles);
        }
        
        // Append to editor container to ensure proper positioning context
        const editorContainer = this.targetElement.closest('.cm-editor')!;
        editorContainer.appendChild(this.menuElement);
    }

    /**
     * Configures Popper.js positioning for the menu
     * Different strategies for mobile vs desktop to optimize for different input methods
     */
    private setupPopper() {
        if (!this.menuElement) return;

        // Mobile: menu above checkbox (more thumb-friendly)
        // Desktop: menu to the left (doesn't obscure content)
        const placement: Placement = Platform.isMobile ? 'top-start' : 'left-start';
        
        const baseModifiers = [
            { 
                name: 'offset', 
                options: { 
                    offset: Platform.isMobile ? [0, 12] : [-8, 6] // Spacing from checkbox
                } 
            },
            { 
                name: 'flip', 
                options: { 
                    // Fallback positions if primary placement doesn't fit
                    fallbackPlacements: Platform.isMobile ? 
                        ['bottom-start'] : ['right-start'] 
                } 
            },
            { 
                name: 'preventOverflow', 
                enabled: Platform.isMobile,  // Only constrain mobile menus to viewport
                options: { 
                    boundary: 'viewport'
                } 
            },
        ];

        /**
         * Mobile-specific alignment modifier
         * Aligns the first checkbox in the menu with the target checkbox
         * This creates a more intuitive visual connection for users
         */
        const mobileAlignModifier = Platform.isMobile ? [{
            name: 'mobileCheckboxAlign',
            enabled: true,
            phase: 'main' as const,
            fn: (data: { state: any }) => {
                // Wait for DOM to be fully rendered before measuring
                requestAnimationFrame(() => {
                    const ul = this.menuElement?.querySelector('ul');
                    const firstLi = ul?.querySelector('li:first-child');
                    const firstCheckbox = firstLi?.querySelector('.task-list-item-checkbox');
                    
                    if (firstCheckbox && this.menuElement && ul) {
                        // Calculate horizontal offset to align checkbox centers
                        const checkboxRect = firstCheckbox.getBoundingClientRect();
                        const checkboxCenterX = checkboxRect.left + (checkboxRect.width / 2);
                        const targetRect = this.targetElement.getBoundingClientRect();
                        const targetCenterX = targetRect.left + (targetRect.width / 2);
                        
                        const offsetX = targetCenterX - checkboxCenterX;
                        
                        // Apply alignment offset
                        const currentX = parseFloat(this.menuElement.style.left) || 0;
                        const newX = currentX + offsetX;
                        this.menuElement.style.left = `${newX}px`;
                        
                        // Constrain menu width to available line space
                        const targetLine = this.targetElement.closest('.cm-line');
                        
                        if (targetLine) {
                            const lineRect = targetLine.getBoundingClientRect();
                            const availableWidth = lineRect.right - newX;
                            
                            if (availableWidth > 0) {
                                this.menuElement.style.maxWidth = `${availableWidth}px`;
                                this.menuElement.style.width = `auto`;
                                ul.style.maxWidth = '100%';
                                ul.style.width = 'auto';
                            }
                        }
                    }
                });
                
                return data.state;
            }
        }] : [];

        const config = {
            placement,
            modifiers: [...baseModifiers, ...mobileAlignModifier],
        };

        this.popperInstance = createPopper(this.targetElement, this.menuElement, config);
    }

    /**
     * Sets up scroll indicators for mobile horizontal scrolling
     * Shows arrows (‹ ›) when there are more styles available off-screen
     */
    private setupScrollIndicators() {
        if (!Platform.isMobile || !this.menuElement) return;

        const ul = this.menuElement.querySelector('ul');
        if (!ul) return;

        // Updates the visibility of left/right scroll indicators
        const updateScrollIndicators = () => {
            requestAnimationFrame(() => {
                if (!ul || !this.menuElement) return; // Ensure elements still exist
                
                const { scrollLeft, scrollWidth, clientWidth } = ul;
                const canScrollLeft = scrollLeft > 5;  // Small threshold for rounding errors
                const canScrollRight = scrollLeft < scrollWidth - clientWidth - 5;

                // CSS classes control indicator visibility and styling
                this.menuElement.classList.toggle('has-scroll-left', canScrollLeft);
                this.menuElement.classList.toggle('has-scroll-right', canScrollRight);
            });
        };

        // Initial check after DOM settles
        setTimeout(updateScrollIndicators, 50);

        // Debounced scroll updates for performance
        const debouncedScrollUpdate = debounce(updateScrollIndicators, 16);
        ul.addEventListener('scroll', debouncedScrollUpdate, { passive: true });

        // Update indicators when menu size changes
        const resizeObserver = new ResizeObserver(updateScrollIndicators);
        resizeObserver.observe(ul);

        // Cleanup function to remove listeners when widget is destroyed
        this.cleanupScrollIndicators = () => {
            ul.removeEventListener('scroll', debouncedScrollUpdate);
            resizeObserver.disconnect();
        };
    }

    /**
     * Renders the menu content using Obsidian's markdown system
     * This ensures checkboxes look identical to those in normal documents
     */
    private async renderMenuContent(enabledStyles: any[]) {
        if (!this.menuElement) return;

        // Create markdown list of checkboxes
        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');
        const renderChild = new MarkdownRenderChild(this.menuElement);
        this.plugin.addChild(renderChild);
        
        // Let Obsidian render the markdown (creates proper checkbox elements)
        await MarkdownRenderer.render(this.plugin.app, markdown, this.menuElement, '', renderChild);

        // Add metadata and tooltips to each rendered list item
        this.menuElement.querySelectorAll('li').forEach((li, index) => {
            li.setAttribute('data-style-index', index.toString()); // For click handling
            li.setAttribute('role', 'menuitem'); // Accessibility
            li.setAttribute('tabindex', '0');     // Keyboard navigation
            
            // Show descriptive tooltip on hover
            setTooltip(li as HTMLElement, enabledStyles[index].description, {
                placement: Platform.isMobile ? 'top' : 'right'
            });
        });
    }

    /**
     * Sets up all event handling for menu interaction and dismissal
     * Different strategies for mobile vs desktop input methods
     */
    private setupEventListeners(view: EditorView) {
        if (!this.menuElement) return;

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        // Mobile-specific: hide menu on orientation change
        if (Platform.isMobile) {
            window.addEventListener('orientationchange', () => {
                this.hide(view);
            }, { signal });
            
            // Fallback for devices that don't fire orientationchange
            window.addEventListener('resize', () => {
                this.hide(view);
            }, { signal });
        }

        // Platform-specific interaction handling
        if (Platform.isMobile) {
            this.setupTouchHandling(view, signal);
        } else {
            // Desktop: simple click handling
            this.menuElement.addEventListener('mouseup', (e: MouseEvent) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    e.stopPropagation();
                    e.preventDefault();
                    this.handleStyleSelection(view, li);
                }
            }, { signal });

            // Desktop: handle scrolling over the menu
            const throttledHandler = throttle(() => {
                if (this.menuElement) {
                    // Temporarily disable pointer events during scroll
                    this.menuElement.style.pointerEvents = 'none';
                    setTimeout(() => {
                        if (this.menuElement) {
                            this.menuElement.style.pointerEvents = 'auto';
                        }
                    }, 10);
                }
            }, 16);

            const editorContainer = this.menuElement.closest('.cm-editor');
            if (editorContainer) {
                editorContainer.addEventListener('wheel', throttledHandler, { signal });
            }
        }

        this.setupTimeoutHandling(view, signal);
    }

    /**
     * Handles touch interactions for mobile devices
     * Implements proper tap detection vs scrolling gestures
     */
    private setupTouchHandling(view: EditorView, signal: AbortSignal) {
        if (!this.menuElement) return;

        let touchStart: { x: number; y: number; time: number } | null = null;

        // Record initial touch position and time
        this.menuElement.addEventListener('touchstart', (e: TouchEvent) => {
            const touch = e.touches[0];
            touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        }, { signal, passive: false });

        // Validate that touch end is actually a tap (not a scroll/drag)
        this.menuElement.addEventListener('touchend', (e: TouchEvent) => {
            const li = (e.target as HTMLElement).closest('li');
            if (!touchStart || !li) return;

            const touch = e.changedTouches[0];
            const deltaX = Math.abs(touch.clientX - touchStart.x);
            const deltaY = Math.abs(touch.clientY - touchStart.y);
            const duration = Date.now() - touchStart.time;

            // Only process as tap if movement is minimal and duration is short
            if (deltaX < SCROLL_THRESHOLD && deltaY < SCROLL_THRESHOLD && duration < TAP_TIME_THRESHOLD) {
                e.preventDefault();
                e.stopPropagation();
                this.handleStyleSelection(view, li);
            }
            touchStart = null;
        }, { signal, passive: false });

        this.menuElement.addEventListener('touchcancel', () => {
            touchStart = null;
        }, { signal, passive: true });
    }

    /**
     * Handles menu auto-dismissal and outside-click behavior
     * Platform-specific timeout management for optimal UX
     */
    private setupTimeoutHandling(view: EditorView, signal: AbortSignal) {
        if (!this.menuElement) return;

        const eventType = Platform.isMobile ? 'touchstart' : 'mousedown';

        // Hide menu when user interacts outside of it
        document.addEventListener(eventType, (e: Event) => {
            if (!this.menuElement?.contains(e.target as Node) && e.target !== this.targetElement) {
                this.hide(view);
            }
        }, { signal, capture: true });

        // Platform-specific timeout behavior
        if (Platform.isMobile) {
            // Mobile: pause auto-hide during interaction, resume after
            this.menuElement.addEventListener('touchstart', () => this.clearTimeout(), { signal });
            this.menuElement.addEventListener('touchend', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (!li) { // Only restart timer if user didn't select a style
                    setTimeout(() => this.startDismissTimeout(view, 3000), 100);
                }
            }, { signal });
        } else {
            // Desktop: pause auto-hide while hovering
            this.menuElement.addEventListener('mouseenter', () => this.clearTimeout(), { signal });
            this.menuElement.addEventListener('mouseleave', () => this.startDismissTimeout(view, 2000), { signal });
        }
    }

    /**
     * Processes a user's style selection and applies it to the checkbox
     * Provides haptic feedback and updates the document
     */
    private handleStyleSelection(view: EditorView, li: HTMLElement) {
        const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
        const symbol = this.plugin.getEnabledStyles()[index].symbol;
        
        // Provide tactile feedback on mobile
        if (this.plugin.settings.enableHapticFeedback) {
            triggerHapticFeedback();
        }
        
        this.applyCheckboxStyle(view, symbol);
        this.hide(view);
    }

    /** Auto-dismiss timeout management */
    private clearTimeout() {
        if (this.menuTimeout) {
            clearTimeout(this.menuTimeout);
            this.menuTimeout = null;
        }
    }

    private startDismissTimeout(view: EditorView, delay: number) {
        this.clearTimeout();
        this.menuTimeout = setTimeout(() => this.hide(view), delay);
    }

    /**
     * Updates the checkbox symbol in the document
     * Uses CodeMirror's transaction system for proper undo/redo support
     */
    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const line = view.state.doc.lineAt(this.linePos);
        
        // Validate that the line still contains a checkbox
        if (!this.plugin.isCheckboxLine(line.text)) return;

        const match = line.text.match(CHECKBOX_SYMBOL_REGEX);
        if (!match) return;

        // Calculate exact position of the symbol within the checkbox syntax
        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const from = line.from + startIndex;

        // Create a transaction to replace just the symbol character
        view.dispatch({
            changes: { from, to: from + 1, insert: symbol }
        });
    }

    /** Cleanup all resources when widget is destroyed */
    private cleanup() {
        this.clearTimeout();
        this.abortController?.abort();
        this.abortController = null;
        
        this.cleanupScrollIndicators?.();
        this.cleanupScrollIndicators = undefined;
        
        if (this.popperInstance) {
            this.popperInstance.destroy();
            this.popperInstance = null;
        }
        
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    destroy() {
        this.cleanup();
    }
}

/**
 * CODEMIRROR STATE MANAGEMENT
 * Integrates the checkbox widget with CodeMirror's state system
 * This ensures the widget properly responds to document changes and editor lifecycle events
 */

/** 
 * Manages the global state of checkbox widgets and overlays
 * Only one widget can be active at a time per editor
 */
const checkboxWidgetState = StateField.define<{
    widget: CheckboxStyleWidget | null;
    overlayManager: OverlayManager;
}>({
    create: () => ({ widget: null, overlayManager: new OverlayManager() }),
    update(state, tr) {
        let { widget, overlayManager } = state;

        // Process any widget-related effects in this transaction
        for (let effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                // Show new widget (destroy any existing one first)
                const { pos, target, view } = effect.value;
                const plugin = tr.state.field(pluginInstanceField);
                if (!plugin) return state;
                
                widget?.destroy();
                widget = new CheckboxStyleWidget(plugin, pos, target);
                widget.show(view);
                
            } else if (effect.is(hideWidgetEffect)) {
                // Hide current widget and clean up overlay
                widget?.destroy();
                widget = null;
                overlayManager.remove();
            }
        }

        return { widget, overlayManager };
    }
});

/** Provides widgets access to the main plugin instance */
const pluginInstanceField = StateField.define<CheckboxStyleMenuPlugin | null>({
    create: () => null,
    update: (value) => value
});

/**
 * INTERACTION HANDLER
 * Detects long-press gestures on checkboxes and triggers the style menu
 * Handles both mouse (desktop) and touch (mobile) input methods
 */
class InteractionHandler {
    private state: WidgetState = { timer: null, lastTarget: null };
    private abortController: AbortController | null = null;

    constructor(private view: EditorView, private plugin: CheckboxStyleMenuPlugin) {
        this.setupEventListeners();
    }

    /**
     * Registers platform-appropriate event listeners
     * Desktop: mousedown/mouseup for precise cursor interaction
     * Mobile: touchstart/touchend/touchmove for finger-friendly gestures
     */
    private setupEventListeners() {
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        if (Platform.isMobile) {
            this.view.dom.addEventListener('touchstart', this.handleTouchStart.bind(this), { signal, passive: false });
            this.view.dom.addEventListener('touchend', this.handleTouchEnd.bind(this), { signal, passive: false });
            this.view.dom.addEventListener('touchmove', this.handleTouchMove.bind(this), { signal, passive: false });
        } else {
            this.view.dom.addEventListener('mousedown', this.handleMouseDown.bind(this), { signal });
            this.view.dom.addEventListener('mouseup', this.handleMouseUp.bind(this), { signal });
        }
    }

    /** Clean up event listeners when handler is destroyed */
    destroy() {
        this.clearTimer();
        this.abortController?.abort();
        this.abortController = null;
    }

    /** Cancels any active long-press timer */
    private clearTimer() {
        if (this.state.timer) {
            clearTimeout(this.state.timer);
            this.state.timer = null;
        }
    }

    /**
     * Handles successful long-press detection
     * Creates overlay to prevent normal checkbox behavior and shows the style menu
     */
    private handleLongPress(target: HTMLElement) {
        try {
            // Convert DOM element position to document position
            const pos = this.view.posAtDOM(target);
            if (pos === null || pos < 0 || pos > this.view.state.doc.length) return;

            // Verify this is actually a checkbox line in the document
            const line = this.view.state.doc.lineAt(pos);
            if (!this.plugin.isCheckboxLine(line.text)) return;

            // Provide haptic feedback for successful activation
            if (this.plugin.settings.enableHapticFeedback) {
                triggerHapticFeedback(75); // Slightly longer pulse for confirmation
            }

            // Hide any existing widget first
            this.view.dispatch({ effects: hideWidgetEffect.of(undefined) });
            
            // Create overlay to intercept clicks on the original checkbox
            const overlayManager = this.view.state.field(checkboxWidgetState).overlayManager;
            overlayManager.create(target);

            // Show the style menu widget
            this.view.dispatch({
                effects: showWidgetEffect.of({ pos, target, view: this.view })
            });
        } catch (error) {
            console.error('Error in handleLongPress:', error);
        }
    }

    /**
     * DESKTOP MOUSE INTERACTION HANDLERS
     * Simpler interaction model: hold down mouse button for specified duration
     */

    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        
        if (isValidCheckboxTarget(target)) {
            this.state.lastTarget = target;
            this.clearTimer();
            
            // Start long-press timer
            this.state.timer = setTimeout(() => {
                if (this.state.lastTarget === target) { // Ensure mouse is still on same element
                    this.handleLongPress(target);
                    event.preventDefault(); // Prevent normal click behavior
                }
            }, this.plugin.settings.longPressDuration);
        }
    }

    private handleMouseUp() {
        // Mouse released - cancel any pending long-press
        this.clearTimer();
        this.state.lastTarget = null;
    }

    /**
     * MOBILE TOUCH INTERACTION HANDLERS
     * More complex: must distinguish between taps, scrolls, and long-presses
     */

    private handleTouchStart(event: TouchEvent) {
        const target = event.target as HTMLElement;
        
        // Only handle single-finger touches on valid checkboxes
        if (isValidCheckboxTarget(target) && event.touches.length === 1) {
            const touch = event.touches[0];
            this.state.lastTarget = target;
            
            // Record initial touch data for gesture recognition
            this.state.touchStart = { 
                x: touch.clientX, 
                y: touch.clientY, 
                time: Date.now() 
            };
            this.clearTimer();
            
            // Start long-press timer (longer duration for mobile)
            this.state.timer = setTimeout(() => {
                if (this.state.lastTarget === target) {
                    this.handleLongPress(target);
                    event.preventDefault();
                }
            }, this.plugin.settings.touchLongPressDuration);
        }
    }

    /**
     * Cancels long-press if user starts scrolling
     * Prevents accidental menu activation during normal scrolling
     */
    private handleTouchMove(event: TouchEvent) {
        if (this.state.touchStart && event.touches.length === 1) {
            const touch = event.touches[0];
            const deltaX = Math.abs(touch.clientX - this.state.touchStart.x);
            const deltaY = Math.abs(touch.clientY - this.state.touchStart.y);
            
            // If finger moved too far, this is a scroll gesture, not a long-press
            if (deltaX > SCROLL_THRESHOLD || deltaY > SCROLL_THRESHOLD) {
                this.clearTimer();
                this.state.lastTarget = null;
                this.state.touchStart = undefined;
            }
        }
    }

    private handleTouchEnd() {
        // Touch ended - cancel any pending long-press
        this.clearTimer();
        this.state.lastTarget = null;
        this.state.touchStart = undefined;
    }
}

/**
 * CODEMIRROR VIEW PLUGIN
 * Integrates the interaction handler into CodeMirror's plugin system
 * Ensures proper lifecycle management and access to plugin instance
 */
const checkboxViewPlugin = ViewPlugin.fromClass(class {
    private interactionHandler: InteractionHandler | null = null;

    constructor(private view: EditorView) {
        // Get plugin instance from editor state
        const plugin = this.view.state.field(pluginInstanceField);
        if (plugin) {
            this.interactionHandler = new InteractionHandler(view, plugin);
        }
    }

    destroy() {
        this.interactionHandler?.destroy();
    }
});

/**
 * MAIN PLUGIN CLASS
 * Coordinates all components and manages plugin lifecycle
 * Handles settings, registration with Obsidian, and provides public API
 */
export default class CheckboxStyleMenuPlugin extends Plugin {
    settings!: CheckboxStyleSettings;
    public checkboxStyles = CHECKBOX_STYLES.map(style => ({ ...style, enabled: false }));
    
    /** 
     * Performance optimization: cache enabled styles to avoid filtering repeatedly
     * Invalidated whenever settings change
     */
    private cachedEnabledStyles: Array<{ symbol: string; description: string; enabled: boolean }> | null = null;

    async onload() {
        await this.loadSettings();
        this.updateCheckboxStyles();      // Apply loaded settings to style definitions
        this.registerEditorExtensions();  // Hook into CodeMirror
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this)); // Add settings UI
        
        console.log('Loaded Checkbox Style Menu');
    }

    onunload() {
        console.log('Unloaded Checkbox Style Menu');
    }

    /**
     * Public API: Get list of currently enabled checkbox styles
     * Uses caching for performance since this is called frequently during menu rendering
     */
    getEnabledStyles(): Array<{ symbol: string; description: string; enabled: boolean }> {
        if (!this.cachedEnabledStyles) {
            this.cachedEnabledStyles = this.checkboxStyles.filter(style => style.enabled);
        }
        return this.cachedEnabledStyles;
    }

    /**
     * Updates internal style definitions based on current settings
     * Invalidates cache to ensure fresh data on next access
     */
    private updateCheckboxStyles() {
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol] ?? false;
        });
        
        // Force cache refresh on next access
        this.cachedEnabledStyles = null;
    }

    /**
     * Registers all CodeMirror extensions with the editor
     * Order matters: state fields must be registered before plugins that use them
     */
    private registerEditorExtensions() {
        this.registerEditorExtension([
            checkboxWidgetState,              // Manages widget lifecycle
            checkboxViewPlugin,               // Handles user interactions
            pluginInstanceField.init(() => this)  // Provides plugin access to extensions
        ]);
    }

    /**
     * Persists settings to disk with validation and cache invalidation
     * Clamps numeric values to prevent invalid configurations
     */
    async saveSettings() {
        // Ensure duration values are within valid ranges
        this.settings.longPressDuration = Math.max(100, Math.min(1000, this.settings.longPressDuration));
        this.settings.touchLongPressDuration = Math.max(200, Math.min(1500, this.settings.touchLongPressDuration));
        
        await this.saveData(this.settings);
        this.updateCheckboxStyles(); // Apply changes and invalidate cache
    }

    /**
     * Loads settings from disk with comprehensive validation
     * Provides fallback values for missing or invalid data
     */
    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...data,
            // Validate each setting individually with proper fallbacks
            styles: this.validateStylesObject(data?.styles),
            longPressDuration: this.validateDuration(data?.longPressDuration, 100, 1000, 350),
            touchLongPressDuration: this.validateDuration(data?.touchLongPressDuration, 200, 1500, 500),
            enableHapticFeedback: data?.enableHapticFeedback ?? true
        };
    }

    /**
     * Validates numeric duration settings with range checking
     * Returns default value if input is invalid or out of range
     */
    private validateDuration(value: any, min: number, max: number, defaultValue: number): number {
        const num = typeof value === 'number' ? value : parseInt(value);
        return !isNaN(num) && num >= min && num <= max ? num : defaultValue;
    }

    /**
     * Validates the styles configuration object
     * Ensures all known styles have boolean values, provides defaults for missing styles
     */
    private validateStylesObject(styles: any): { [symbol: string]: boolean } {
        if (!styles || typeof styles !== 'object') {
            return DEFAULT_SETTINGS.styles;
        }
        
        const validated: { [symbol: string]: boolean } = {};
        CHECKBOX_STYLES.forEach(style => {
            validated[style.symbol] = typeof styles[style.symbol] === 'boolean' ? 
                styles[style.symbol] : DEFAULT_SETTINGS.styles[style.symbol];
        });
        
        return validated;
    }

    /**
     * Public API: Check if a line of text contains a checkbox
     * Used by interaction handlers to validate targets
     */
    public isCheckboxLine(line: string): boolean {
        return CHECKBOX_REGEX.test(line);
    }
}

/**
 * SETTINGS TAB CLASS
 * Provides the user interface for configuring plugin behavior
 * Integrates with Obsidian's settings system and provides live preview
 */
class CheckboxStyleSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
    }

    /** Main entry point: builds the entire settings UI */
    display(): void {
        this.containerEl.empty();
        this.addDurationSettings();      // Long-press timing controls
        this.addMobileSettings();        // Mobile-specific options
        this.addStyleToggles();          // Individual style enable/disable
    }

    /**
     * Creates duration slider controls for both desktop and mobile
     * Provides both slider and text input for precise control
     */
    private addDurationSettings(): void {
        this.createDurationSetting(
            'Long-press duration (Desktop)',
            'Hold a checkbox this long to open its style menu.',
            'longPressDuration',
            100, 1000
        );

        this.createDurationSetting(
            'Long-press duration (Mobile)',
            'Hold a checkbox this long to open its style menu.',
            'touchLongPressDuration',
            200, 1500
        );
    }

    /** Adds mobile-specific settings like haptic feedback */
    private addMobileSettings(): void {
        new Setting(this.containerEl)
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
     * Creates the checkbox style selection interface
     * Groups styles into categories and provides visual previews
     */
    private addStyleToggles(): void {
        this.containerEl.createEl('h2', { text: 'Choose which styles to show in the menu:' });

        const toggleContainer = this.containerEl.createDiv({ cls: 'checkbox-style-toggles' });

        // Organize styles into logical groups
        this.addStyleCategory(toggleContainer, 'Basic', CHECKBOX_STYLES.slice(0, 6));   // Common task states
        this.addStyleCategory(toggleContainer, 'Extras', CHECKBOX_STYLES.slice(6));     // Extended/specialized states

        this.addResetButton(); // Convenience function to restore defaults
    }

    /**
     * Creates a visually grouped section of style toggles
     * Each category gets its own heading for better organization
     */
    private addStyleCategory(container: HTMLElement, categoryName: string, styles: typeof CHECKBOX_STYLES[number][]): void {
        container.createEl('h3', { text: categoryName });
        styles.forEach(style => this.createStyleToggle(container, style));
    }

    /** Adds a button to reset all style selections to plugin defaults */
    private addResetButton(): void {
        new Setting(this.containerEl)
            .setName('Reset all checkbox style selections to default')
            .addButton(button => button
                .setButtonText('Reset')
                .onClick(async () => {
                    this.plugin.settings.styles = { ...DEFAULT_SETTINGS.styles };
                    await this.plugin.saveSettings();
                    this.display(); // Refresh UI to show changes
                    new Notice('Checkbox styles reset to default');
                }));
    }

    /**
     * Creates a dual-input control (slider + text field) for duration settings
     * Provides immediate visual feedback and precise numeric control
     */
    private createDurationSetting(name: string, desc: string, key: keyof CheckboxStyleSettings, min: number, max: number): void {
        const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
        
        let sliderComponent: any;
        let textComponent: any;
        
        setting
            .addSlider(slider => {
                sliderComponent = slider;
                return slider
                    .setLimits(min, max, 50) // min, max, step
                    .setValue(this.plugin.settings[key] as number)
                    .setDynamicTooltip() // Shows current value while dragging
                    .onChange(async (value) => {
                        (this.plugin.settings[key] as number) = value;
                        await this.plugin.saveSettings();
                        textComponent.setValue(value.toString()); // Sync text input
                    });
            })
            .addText(text => {
                textComponent = text;
                return text
                    .setPlaceholder(key === 'longPressDuration' ? '350' : '500')
                    .setValue((this.plugin.settings[key] as number).toString())
                    .onChange(async (value) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue >= min && numValue <= max) {
                            (this.plugin.settings[key] as number) = numValue;
                            await this.plugin.saveSettings();
                            sliderComponent.setValue(numValue); // Sync slider
                        }
                    });
            });
    }
    
    /**
     * Creates a toggle control for an individual checkbox style
     * Attempts to render the actual checkbox for visual preview, falls back to text if needed
     */
    private createStyleToggle(container: HTMLElement, style: typeof CHECKBOX_STYLES[number]): void {
        try {
            const setting = new Setting(container);
            
            // Create container for rendered markdown preview
            const nameContainer = container.createDiv();
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian';
            
            // Render actual checkbox using Obsidian's markdown system
            const markdown = `- [${style.symbol}] ${style.description}`;
            const renderChild = new MarkdownRenderChild(nameContainer);
            this.plugin.addChild(renderChild);
            
            // Async rendering with fallback error handling
            MarkdownRenderer.render(this.app, markdown, nameContainer, '', renderChild)
                .then(() => {
                    // Use rendered content as setting name
                    const nameFragment = document.createDocumentFragment();
                    nameFragment.appendChild(nameContainer);
                    
                    setting.setName(nameFragment);
                    setting.addToggle(toggle => toggle
                        .setValue(this.plugin.settings.styles[style.symbol] ?? false)
                        .onChange(async (value) => {
                            this.plugin.settings.styles[style.symbol] = value;
                            
                            // Update internal state immediately for consistency
                            const styleObj = this.plugin.checkboxStyles.find(s => s.symbol === style.symbol);
                            if (styleObj) styleObj.enabled = value;
                            
                            await this.plugin.saveSettings();
                        }));
                });
        } catch (error) {
            // Fallback: simple text-based toggle if markdown rendering fails
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