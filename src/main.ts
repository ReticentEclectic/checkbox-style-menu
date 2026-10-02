import { Plugin, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, SliderComponent, TextComponent, Editor, MarkdownView, MarkdownFileInfo, setTooltip, Platform, Notice, debounce } from 'obsidian';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { createPopper, Instance as PopperInstance, Placement } from '@popperjs/core';
import { 
    isTasksPluginInstalled,
    shouldUseClickForToggle, 
    maybeShowTasksNotice,
    applyStyleViaClick,
    logCompatibilityDecision,
    validateAndFixCompatibilitySettings,
    createCompatibilityWatcher,
    getTasksCompatibilityUIInfo
} from './plugin-compatibility';

/**
 * INTERFACES AND TYPES
 * Define the data structures used throughout the plugin
 */

/** Configuration settings for checkbox style behavior and appearance */
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };                 // Which checkbox styles are enabled in the menu
    triggerMethod: 'long-press' | 'right-click' | 'both';  // How to trigger the menu
    longPressDuration: number;                             // Desktop long-press duration in milliseconds
    touchLongPressDuration: number;                        // Mobile long-press duration in milliseconds
    enableHapticFeedback: boolean;                         // Whether to provide haptic feedback on mobile
    enableTasksCompatibility: boolean;                     // Whether to integrate with Tasks plugin
    hasShownTasksNotice: boolean;                          // Track if we've shown the one-time notice
    cycleEnabled: boolean;                                 // Whether to override the default click-to-toggle cycle
    cycleStates: string[];                                 // Ordered sequence of symbols a plain click cycles through
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
    cycleTarget: HTMLElement | null;    // Checkbox mousedown'd while the click-cycle is enabled
    cycleWasLongPress: boolean;         // Whether that mousedown escalated into a long-press
}

/**
 * Obsidian's public `Editor` type doesn't expose the underlying CodeMirror 6
 * `EditorView` instance backing it - there's no official, documented way to get
 * from an Editor down to the raw CM6 view. This narrow interface documents
 * exactly the one undocumented field we depend on (openMenuAtCursor), so the
 * rest of `Editor` stays fully type-checked instead of being opted out of
 * checking entirely via a blanket `any` cast.
 */
interface EditorWithCM extends Editor {
    cm?: EditorView;
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
    triggerMethod: 'both',             // Default to both methods for maximum flexibility
    longPressDuration: 350,            // Desktop: shorter duration for precise mouse control
    touchLongPressDuration: 500,       // Mobile: longer duration to avoid accidental activation
    enableHapticFeedback: true,        // Haptic feedback on mobile enabled by default
    enableTasksCompatibility: false,   // Off by default - user must opt-in for Tasks integration
    hasShownTasksNotice: false,        // Haven't shown the notice yet
    cycleEnabled: false,               // Off by default - preserves Obsidian's native [ ] <-> [x] toggle
    cycleStates: [' ', 'x'],           // Mirrors the default cycle as a sensible starting point when enabled
};

/** 
 * Touch/gesture detection thresholds
 * These prevent accidental menu activation during scrolling or imprecise touches
 */
const SCROLL_THRESHOLD = 10;      // Pixels of movement before canceling long-press
const TAP_TIME_THRESHOLD = 300;   // Maximum duration for a tap vs. long-press
const MOBILE_MENU_GUTTER = 8;     // Px kept between the mobile menu and the screen edges (keep in sync with styles.css)

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
    triggeredBy: 'long-press' | 'right-click' | 'hotkey'; // How the menu was triggered
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
 * Given the current checkbox symbol and a configured cycle, returns the next symbol.
 * If the current symbol isn't part of the cycle (e.g. hand-typed, or set by another
 * plugin), falls back to the first item in the cycle rather than getting stuck.
 */
const getNextCycleSymbol = (current: string, cycle: string[]): string => {
    const idx = cycle.indexOf(current);
    if (idx === -1) return cycle[0];
    return cycle[(idx + 1) % cycle.length];
};

/**
 * Writes a single checkbox symbol directly into the document at the given position.
 * Standalone counterpart to CheckboxStyleWidget.applyCheckboxStyleDirect, used by the
 * click-to-cycle feature which has no widget/menu instance to operate through.
 * Returns false (no-op) if the position isn't actually on a checkbox line.
 */
const writeCheckboxSymbolAtPos = (view: EditorView, pos: number, symbol: string): boolean => {
    const line = view.state.doc.lineAt(pos);
    if (!CHECKBOX_REGEX.test(line.text)) return false;

    const match = line.text.match(CHECKBOX_SYMBOL_REGEX);
    if (!match) return false;

    const startIndex = match.index! + match[0].indexOf('[') + 1;
    const from = line.from + startIndex;

    view.dispatch({
        changes: { from, to: from + 1, insert: symbol }
    });
    return true;
};

/** 
 * Throttle utility for performance optimization
 * Limits how frequently a function can be called (useful for scroll/resize events)
 */
const throttle = <T extends (...args: unknown[]) => void>(func: T, delay: number): T => {
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
 * TARGET CHECKBOX OVERLAY MANAGEMENT
 * Creates an invisible overlay over the target checkbox to prevent normal click behavior
 * while the style menu is open. This prevents the target checkbox from getting toggled
 * accidentally from clicks or touches while the menu is active.
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
            e.preventDefault(); // Prevent checkbox toggle
            if (e.type !== 'mouseup') {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
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
        private targetElement: HTMLElement,  // The checkbox DOM element
        private triggeredBy: 'long-press' | 'right-click' | 'hotkey' // How the menu was triggered
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
        
        // Mobile: line the menu's first checkbox up with the target checkbox. Measured once,
        // before Popper runs (the menu is already in the DOM by now), as the horizontal shift
        // from Popper's 'top-start' spot (menu's left edge = target's left edge) that puts
        // the two checkbox centers on the same vertical line. Passed to Popper as the offset
        // modifier's "skidding" so preventOverflow sees it and can correct for it - unlike the
        // old post-hoc `style.left` nudge, which ran after preventOverflow and undid it.
        const alignSkidding = Platform.isMobile ? this.measureFirstCheckboxSkidding() : 0;

        const baseModifiers = [
            { 
                name: 'offset', 
                options: { 
                    offset: Platform.isMobile ? [alignSkidding, 12] : [-8, 6] // Spacing from checkbox
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
                    boundary: 'viewport',
                    padding: MOBILE_MENU_GUTTER // Keep a small gutter from the screen edges
                } 
            },
        ];

        /**
         * All mobile horizontal positioning goes through Popper: 'top-start' + the alignment
         * skidding above, then preventOverflow keeps the menu MOBILE_MENU_GUTTER inside the
         * viewport. So a short menu stays aligned with the target until it reaches the right
         * edge and then stops moving, while a long menu (width capped in styles.css to the
         * viewport minus both gutters) fills the screen and scrolls.
         *
         * The earlier version did this alignment as a `style.left` nudge in a rAF after
         * Popper ran, plus a max-width computed from the target line's right edge. The nudge
         * pushed the menu back out of the region preventOverflow had just kept it in, and the
         * width cap mixed a viewport coordinate with a container-relative offset - that
         * combination was the off-screen bug for short menus at deep indents.
         */
        const config = {
            placement,
            modifiers: baseModifiers,
        };

        this.popperInstance = createPopper(this.targetElement, this.menuElement, config);
    }

    /**
     * Horizontal shift (px, negative = left) that moves the menu from Popper's 'top-start'
     * position so its first checkbox is centered over the target checkbox. Both centers are
     * measured relative to their own boxes, so it doesn't matter where the menu currently is.
     * Returns 0 if there's no checkbox to align to (e.g. "No styles enabled").
     */
    private measureFirstCheckboxSkidding(): number {
        if (!this.menuElement) return 0;

        const firstCheckbox = this.menuElement.querySelector('li .task-list-item-checkbox');
        if (!firstCheckbox) return 0;

        const menuRect = this.menuElement.getBoundingClientRect();
        const checkboxRect = firstCheckbox.getBoundingClientRect();
        const targetRect = this.targetElement.getBoundingClientRect();

        const checkboxCenterInMenu = (checkboxRect.left - menuRect.left) + checkboxRect.width / 2;
        return (targetRect.width / 2) - checkboxCenterInMenu;
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
    private async renderMenuContent(enabledStyles: Array<{ symbol: string; description: string; enabled: boolean }>) {
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
            // Desktop: Choose event based on trigger method
            const eventType = this.triggeredBy === 'long-press'
                ? "mouseup"
                : "click";
            
            this.menuElement.addEventListener(eventType, (e: MouseEvent) => {
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
     * Gets the current checkbox symbol from the line
     * Used to determine whether a click or text change should be used
     */
    private getCurrentSymbol(view: EditorView): string | null {
        const line = view.state.doc.lineAt(this.linePos);
        const match = line.text.match(CHECKBOX_SYMBOL_REGEX);
        return match ? match[1] : null;
    }

    /**
     * Applies checkbox style by directly changing the markdown text
     * 
     * This method is used for custom checkbox symbols (like [!], [>], etc.)
     * or when Tasks compatibility is disabled. It provides precise control
     * over the exact symbol that gets inserted.
     * 
     * Uses CodeMirror's transaction system for proper undo/redo support.
     */
    private applyCheckboxStyleDirect(view: EditorView, symbol: string) {
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

    /**
     * Main checkbox style application method
     * 
     * Intelligently chooses between native click events and direct text changes
     * based on the current state, target state, and Tasks compatibility setting.
     * 
     * Strategy:
     * - When Tasks compatibility is enabled AND a click will work: use click
     *   (This allows Tasks to detect the change and add done dates)
     * - For all other cases: use direct text change
     *   (This gives precise control over the symbol)
     * 
     * The compatibility module handles the complex logic of determining when
     * clicks will produce the correct result based on Obsidian's native behavior.
     */
    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const currentSymbol = this.getCurrentSymbol(view);
        
        if (!currentSymbol) {
            console.error('Checkbox Style Menu: Could not determine current symbol');
            return;
        }

        // No-op case: user selected the current state
        // Just dismiss the menu without making any changes
        if (currentSymbol === symbol) {
            console.log('Checkbox Style Menu: No change needed (already at target state)');
            this.hide(view);
            return;
        }

        // Show the one-time Tasks integration notice if appropriate
        // This is delegated to the compatibility module
        maybeShowTasksNotice(
            this.plugin.app,
            symbol,
            {
                enableTasksCompatibility: this.plugin.settings.enableTasksCompatibility,
                hasShownTasksNotice: this.plugin.settings.hasShownTasksNotice
            },
            async () => {
                this.plugin.settings.hasShownTasksNotice = true;
                await this.plugin.saveSettings();
            }
        );

        // IMPORTANT: Determine if Tasks plugin is actually installed and active before proceeding
        // Do not rely on enableTasksCompatibility alone
        // Editor extensions can outlive plugin enable/disable events
        const tasksActuallyAvailable =
            this.plugin.settings.enableTasksCompatibility &&
            isTasksPluginInstalled(this.plugin.app);

        // Use the compatibility module to determine the best approach
        // This encapsulates all the complex logic about when clicks work
        const useClick = shouldUseClickForToggle(
            currentSymbol,
            symbol,
            tasksActuallyAvailable
        );

        // Optional: Log the decision for debugging purposes
        logCompatibilityDecision(currentSymbol, symbol, useClick, false);

        if (useClick) {
            // Delegate to compatibility module for click-based application
            const overlayManager = view.state.field(checkboxWidgetState).overlayManager;
            applyStyleViaClick(this.targetElement, overlayManager);
            
            // Hide menu after short delay to allow click to process
            setTimeout(() => {
                this.hide(view);
            }, 20);
        } else {
            // Use direct text change for precise control
            this.applyCheckboxStyleDirect(view, symbol);
            this.hide(view);
        }
    }

    /**
     * Cleanup all resources when widget is destroyed
     * Ensures no memory leaks or orphaned event listeners
     */
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
        let widget = state.widget;
        const overlayManager = state.overlayManager;

        // Process any widget-related effects in this transaction
        for (const effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                // Show new widget (destroy any existing one first)
                const { pos, target, view, triggeredBy } = effect.value;
                const plugin = tr.state.field(pluginInstanceField);
                if (!plugin) return state;
                
                widget?.destroy();
                widget = new CheckboxStyleWidget(plugin, pos, target, triggeredBy);
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
 * Detects long-press and right-click gestures on checkboxes and triggers the style menu
 * Handles both mouse (desktop) and touch (mobile) input methods
 */
class InteractionHandler {
    private state: WidgetState = { timer: null, lastTarget: null, cycleTarget: null, cycleWasLongPress: false };
    private abortController: AbortController | null = null;

    constructor(private view: EditorView, private plugin: CheckboxStyleMenuPlugin) {
        this.setupEventListeners();
    }

    /**
     * Registers platform-appropriate event listeners
     * Desktop: mousedown/mouseup for long-press + contextmenu for right-click
     * Mobile: touchstart/touchend/touchmove for finger-friendly gestures
     * 
     * On desktop, checks settings dynamically so changes take effect immediately
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
            this.view.dom.addEventListener('contextmenu', this.handleContextMenu.bind(this), { signal });
        }

        // Click-to-cycle: Obsidian wires its native checkbox toggle to 'mousedown'/'touchstart'
        // (not 'click') for Live Preview widgets, so preventDefault has to happen there - by
        // 'click' time the native toggle has already run and already touched the DOM. We still
        // also suppress the trailing 'click' so the browser doesn't flash the native state
        // first. Registered in the capture phase so we run before Obsidian's own handler.
        if (Platform.isMobile) {
            this.view.dom.addEventListener('touchstart', this.handleCyclePress.bind(this), { signal, capture: true, passive: false });
        } else {
            this.view.dom.addEventListener('mousedown', this.handleCyclePress.bind(this), { signal, capture: true });
        }
        this.view.dom.addEventListener('click', this.handleCycleClickSuppress.bind(this), { signal, capture: true });
    }

    /**
     * Preempts Obsidian's native checkbox toggle the moment it actually fires. The
     * symbol change itself is applied on release (handleMouseUp/handleTouchEnd) once
     * it's known whether this turned into a long-press rather than a plain tap/click.
     */
    private handleCyclePress(event: MouseEvent | TouchEvent) {
        if (!this.plugin.settings.cycleEnabled) return;
        if ('button' in event && event.button !== 0) return; // Left click only; leave right-click to handleContextMenu

        const target = event.target as HTMLElement;
        if (!isValidCheckboxTarget(target)) return;
        if (this.plugin.settings.cycleStates.length < 2) return; // Not a usable cycle

        event.preventDefault();
        this.state.cycleTarget = target;
        this.state.cycleWasLongPress = false;
    }

    /** Suppresses the trailing click's default action, mirroring the preemption above */
    private handleCycleClickSuppress(event: MouseEvent) {
        if (!this.plugin.settings.cycleEnabled) return;

        const target = event.target as HTMLElement;
        if (!isValidCheckboxTarget(target)) return;
        if (this.plugin.settings.cycleStates.length < 2) return;

        event.preventDefault();
        event.stopPropagation();
    }

    /** Writes the next symbol in the configured cycle for the given checkbox */
    private applyCycleStep(target: HTMLElement) {
        const cycle = this.plugin.settings.cycleStates;

        const pos = this.view.posAtDOM(target);
        if (pos === null || pos < 0 || pos > this.view.state.doc.length) return;

        const line = this.view.state.doc.lineAt(pos);
        const match = line.text.match(CHECKBOX_SYMBOL_REGEX);
        if (!match) return;

        const nextSymbol = getNextCycleSymbol(match[1], cycle);
        writeCheckboxSymbolAtPos(this.view, pos, nextSymbol);
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
     * Delegates to the centralized menu trigger method
     */
    private handleLongPress(target: HTMLElement) {
        const pos = this.view.posAtDOM(target);
        if (pos === null || pos < 0 || pos > this.view.state.doc.length) return;

        // If the click-cycle also armed for this same press, mark it as a long-press
        // so the release handler doesn't also apply a cycle step on top of the menu.
        if (this.state.cycleTarget === target) {
            this.state.cycleWasLongPress = true;
        }

        // Trigger with long-press method
        this.plugin.showCheckboxMenu(this.view, target, pos, 'long-press');
    }

    /**
     * DESKTOP MOUSE INTERACTION HANDLERS
     * Handles both long-press and right-click interactions
     */

    /**
     * Handles right-click (context menu) events
     * Only triggers on valid checkboxes, preserving default behavior elsewhere
     * Checks settings dynamically to respect user preference
     */
    private handleContextMenu(event: MouseEvent) {
        const target = event.target as HTMLElement;
        
        // Check if right-click is enabled in settings
        const triggerMethod = this.plugin.settings.triggerMethod;
        if (triggerMethod !== 'right-click' && triggerMethod !== 'both') {
            return; // Right-click not enabled, let default behavior happen
        }
        
        // Only intercept right-clicks specifically on checkboxes
        if (isValidCheckboxTarget(target)) {
            event.preventDefault(); // Prevent default context menu
            event.stopPropagation(); // Prevent event bubbling
            
            // Cancel any pending long-press timer (if both methods enabled)
            this.clearTimer();
            this.state.lastTarget = null;
            
            const pos = this.view.posAtDOM(target);
            if (pos === null || pos < 0 || pos > this.view.state.doc.length) return;
            
            // Trigger with right-click method
            this.plugin.showCheckboxMenu(this.view, target, pos, 'right-click');
        }
        // If not a checkbox, let the event propagate normally for default context menu
    }

    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        
        // Check if long-press is enabled in settings
        const triggerMethod = this.plugin.settings.triggerMethod;
        if (triggerMethod !== 'long-press' && triggerMethod !== 'both') {
            return; // Long-press not enabled, ignore
        }
        
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

        // Apply the cycle step now, unless this press escalated into a long-press
        // (in which case the style menu is already showing instead)
        if (this.state.cycleTarget) {
            const target = this.state.cycleTarget;
            const wasLongPress = this.state.cycleWasLongPress;
            this.state.cycleTarget = null;
            this.state.cycleWasLongPress = false;

            if (!wasLongPress) {
                this.applyCycleStep(target);
            }
        }
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
                // A scroll, not a tap - don't apply a cycle step on touchend either
                this.state.cycleTarget = null;
                this.state.cycleWasLongPress = false;
            }
        }
    }

    private handleTouchEnd() {
        // Touch ended - cancel any pending long-press
        this.clearTimer();
        this.state.lastTarget = null;
        this.state.touchStart = undefined;

        // Apply the cycle step now, unless this press escalated into a long-press
        if (this.state.cycleTarget) {
            const target = this.state.cycleTarget;
            const wasLongPress = this.state.cycleWasLongPress;
            this.state.cycleTarget = null;
            this.state.cycleWasLongPress = false;

            if (!wasLongPress) {
                this.applyCycleStep(target);
            }
        }
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
        this.validateCompatibilitySettings(); // Check compatibility settings on load
        this.registerCompatibilityWatcher(); // Watch for plugin enable/disables
        this.updateCheckboxStyles();      // Apply loaded settings to style definitions
        this.registerEditorExtensions();  // Hook into CodeMirror
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this)); // Add settings UI
        this.registerCommands();          // Register hotkey commands
        
        console.log('Loaded Checkbox Style Menu');
    }

    onunload() {
        console.log('Unloaded Checkbox Style Menu');
    }

    /**
     * Validates compatibility settings on plugin load
     * 
     * Automatically disables Tasks integration if Tasks plugin is not available.
     * This prevents invalid states where compatibility is enabled but Tasks is missing,
     * which would cause incorrect checkbox behavior.
     * 
     * This check runs:
     * - When the plugin loads (on Obsidian startup)
     * - When settings are opened (in the settings UI)
     * 
     * This ensures compatibility is always disabled if Tasks is unavailable,
     * even if the user never opens the settings panel.
     */
    private validateCompatibilitySettings(): void {
        const { wasChanged } = validateAndFixCompatibilitySettings(
            this.settings,
            this.app
        );

        // Save if changes were made
        if (wasChanged) {
            this.saveSettings();
            // Don't show a notice on startup - only in settings UI
            // This avoids annoying users every time they start Obsidian
        }
    }

    /**
     * Watch for Obsidian layout changes to detect plugin enable/disables
     * Ensures 3rd-party compatibility settings remain valid
     */
    private registerCompatibilityWatcher() {
        const watcherCallback = createCompatibilityWatcher(
            this.app,
            this.settings,
            async () => {
                await this.saveSettings();
            }
        );

        this.registerEvent(
            this.app.workspace.on('layout-change', watcherCallback)
        );
    }

    /**
     * Register hotkey command to open menu at cursor
     * Allows users to trigger the menu via keyboard shortcut
     */
    private registerCommands() {
        this.addCommand({
            id: 'open-checkbox-style-menu',
            name: 'Open checkbox style menu',
            editorCallback: (editor, view) => {
                this.openMenuAtCursor(editor, view);
            }
        });
    }

    /**
     * Central method to show the checkbox style menu
     * Used by all trigger methods: long-press, right-click, and hotkey
     * 
     * @param view - The CodeMirror EditorView
     * @param target - The checkbox DOM element to show menu for
     * @param pos - Document position of the checkbox line
     * @param triggeredBy - How the menu was activated
     */
    public showCheckboxMenu(
        view: EditorView, 
        target: HTMLElement, 
        pos: number,
        triggeredBy: 'long-press' | 'right-click' | 'hotkey'
    ) {
        try {
            // Verify this is actually a checkbox line in the document
            const line = view.state.doc.lineAt(pos);
            if (!this.isCheckboxLine(line.text)) return;

            // Provide haptic feedback for successful activation
            if (this.settings.enableHapticFeedback) {
                triggerHapticFeedback(75);
            }

            // Hide any existing widget first
            view.dispatch({ effects: hideWidgetEffect.of(undefined) });
            
            // Create overlay to intercept clicks on the original checkbox
            const overlayManager = view.state.field(checkboxWidgetState).overlayManager;
            overlayManager.create(target);

            // Show the style menu widget
            view.dispatch({
                effects: showWidgetEffect.of({ pos, target, view, triggeredBy })
            });
        } catch (error) {
            console.error('Error showing checkbox menu:', error);
        }
    }

    /**
     * Opens the checkbox style menu at the current cursor position
     * Called when user triggers the hotkey command
     *
     * `view` is typed as the honest union Obsidian's editorCallback actually
     * provides (MarkdownView | MarkdownFileInfo), matching registerCommands()'s
     * call site - but it's unused here: `editor` alone is enough (see below),
     * and it's always present, unlike MarkdownFileInfo.editor which is optional.
     */
    private openMenuAtCursor(editor: Editor, view: MarkdownView | MarkdownFileInfo) {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        
        // Check if current line contains a checkbox
        if (!this.isCheckboxLine(line)) {
            new Notice('No checkbox found on current line');
            return;
        }
        
        // Get the CodeMirror EditorView. `editor` and `view.editor` are the same
        // instance here; `editor` is used since it's guaranteed present, sidestepping
        // MarkdownFileInfo.editor's optionality for no behavioral difference.
        const editorView = (editor as EditorWithCM).cm;
        if (!editorView) {
            new Notice('Unable to access editor view');
            return;
        }
        
        // Get the line position
        const linePos = editor.posToOffset({ line: cursor.line, ch: 0 });
        
        // Find the checkbox element
        const checkboxElement = this.findCheckboxElementAtPos(editorView, linePos);
        if (!checkboxElement) {
            new Notice('Unable to locate checkbox element');
            return;
        }
        
        // Use hotkey trigger
        this.showCheckboxMenu(editorView, checkboxElement, linePos, 'hotkey');
    }

    /**
     * Finds the checkbox DOM element at a given document position
     */
    private findCheckboxElementAtPos(view: EditorView, pos: number): HTMLElement | null {
        const domAtPos = view.domAtPos(pos);
        let container = domAtPos.node as HTMLElement;
        
        // Traverse up to find the line container
        while (container && !container.classList?.contains('cm-line')) {
            container = container.parentElement as HTMLElement;
        }
        
        if (!container) return null;
        
        // Find the checkbox within this line
        const checkbox = container.querySelector('.task-list-item-checkbox');
        return checkbox as HTMLElement | null;
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
        this.settings.cycleStates = this.sanitizeCycleStates(this.settings.cycleStates);
        
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
            triggerMethod: this.validateTriggerMethod(data?.triggerMethod),
            longPressDuration: this.validateDuration(data?.longPressDuration, 100, 1000, 350),
            touchLongPressDuration: this.validateDuration(data?.touchLongPressDuration, 200, 1500, 500),
            enableHapticFeedback: data?.enableHapticFeedback ?? true,
            enableTasksCompatibility: data?.enableTasksCompatibility ?? false,
            hasShownTasksNotice: data?.hasShownTasksNotice ?? false,
            cycleEnabled: data?.cycleEnabled ?? false,
            cycleStates: this.sanitizeCycleStates(data?.cycleStates)
        };
    }

    /**
     * Validates the click-cycle symbol list: keeps only single-character strings,
     * drops duplicates (first occurrence wins), and falls back to the default
     * two-state cycle if fewer than 2 valid, unique symbols remain.
     */
    private sanitizeCycleStates(value: unknown): string[] {
        if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.cycleStates];

        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const item of value) {
            if (typeof item !== 'string' || item.length !== 1) continue;
            if (seen.has(item)) continue;
            seen.add(item);
            cleaned.push(item);
        }

        return cleaned.length >= 2 ? cleaned : [...DEFAULT_SETTINGS.cycleStates];
    }

    /**
     * Validates the trigger method setting
     * Ensures only valid values are used
     */
    private validateTriggerMethod(value: unknown): 'long-press' | 'right-click' | 'both' {
        if (value === 'long-press' || value === 'right-click' || value === 'both') {
            return value;
        }
        return DEFAULT_SETTINGS.triggerMethod;
    }

    /**
     * Validates numeric duration settings with range checking
     * Returns default value if input is invalid or out of range
     */
    private validateDuration(value: unknown, min: number, max: number, defaultValue: number): number {
        const num = typeof value === 'number' ? value : parseInt(String(value), 10);
        return !isNaN(num) && num >= min && num <= max ? num : defaultValue;
    }

    /**
     * Validates the styles configuration object
     * Ensures all known styles have boolean values, provides defaults for missing styles
     */
    private validateStylesObject(styles: unknown): { [symbol: string]: boolean } {
        if (!styles || typeof styles !== 'object') {
            return DEFAULT_SETTINGS.styles;
        }
        
        const source = styles as Record<string, unknown>;
        const validated: { [symbol: string]: boolean } = {};
        CHECKBOX_STYLES.forEach(style => {
            validated[style.symbol] = typeof source[style.symbol] === 'boolean' ? 
                (source[style.symbol] as boolean) : DEFAULT_SETTINGS.styles[style.symbol];
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
    private isAdvancedExpanded: boolean = false;  // Track Advanced section state
    private openPickerIndex: number | null = null; // Which cycle slot's picker is currently open, if any
    private cycleContainerEl: HTMLElement | null = null; // For surgical chip updates during picker scroll

    constructor(app: App, private plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
    }

    /**
     * Finds the actual scrollable settings container by CSS (`overflow-y: auto` or
     * `scroll`), walking up from containerEl. On desktop this is Obsidian's own
     * `.vertical-tab-content` wrapper; on mobile it's the settings modal's content
     * area. containerEl itself is emptied/rebuilt on every display() call, so it's
     * never the thing actually holding scroll position - an ancestor is.
     */
    private getScrollParent(): HTMLElement {
        let el: HTMLElement | null = this.containerEl;
        while (el) {
            const overflowY = getComputedStyle(el).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') return el;
            el = el.parentElement;
        }
        return this.containerEl;
    }

    /**
     * Main entry point: builds the entire settings UI.
     *
     * Every add/remove/open-picker action re-renders by calling this wholesale -
     * containerEl.empty() destroys and rebuilds all the DOM, which resets the
     * settings panel's scroll position to the top even though nothing about the
     * change should move the viewport. Captures and restores the real scroll
     * parent's scrollTop around the rebuild so the user stays where they were.
     * (The picker's own symbol-selection deliberately skips display() entirely for
     * the same reason - see applyCyclePickerSelection's comment.)
     *
     * Restored twice, deliberately: containerEl.empty() clamps the scroll parent's
     * scrollTop to 0 the instant it shrinks the container, synchronously - before
     * anything queued in requestAnimationFrame runs. rAF is supposed to guarantee
     * no paint happens in between, but a visible one-frame flash to the top was
     * observed anyway (a known Electron/Chromium exception to that guarantee, not
     * specific to this code). Setting scrollTop back immediately, in the same tick
     * as the rebuild, closes that gap entirely in the common case; the rAF restore
     * stays as a safety net for any layout that settles later (e.g. async content).
     */
    display(): void {
        const scrollParent = this.getScrollParent();
        const scrollTop = scrollParent.scrollTop;

        this.containerEl.empty();
        this.addTriggerMethodSetting(); // Menu trigger method selection
        this.addDurationSettings();      // Long-press timing controls
        this.addMobileSettings();        // Mobile-specific options
        this.addCustomCycleSetting();    // Click-to-cycle override
        this.addStyleToggles();          // Individual style enable/disable
        this.addAdvancedSection();       // Advanced settings (collapsible)

        // Immediate restore, same tick as the rebuild - closes the gap before any
        // paint can happen at all in the common case
        scrollParent.scrollTop = scrollTop;

        // Follow-up restore once the browser has actually finished laying out the
        // new content, in case anything shifted after the immediate restore above
        requestAnimationFrame(() => {
            scrollParent.scrollTop = scrollTop;
        });
    }

    /**
     * Creates the trigger method selection dropdown
     * Allows users to choose between long-press, right-click, or both
     */
    private addTriggerMethodSetting(): void {
        new Setting(this.containerEl)
            .setName('Menu trigger method')
            .setDesc('Choose how to open the checkbox style menu.')
            .addDropdown(dropdown => dropdown
                .addOption('both', 'Both (Long-press + Right-click)')
                .addOption('long-press', 'Long-press only')
                .addOption('right-click', 'Right-click only')
                .setValue(this.plugin.settings.triggerMethod)
                .onChange(async (value: 'long-press' | 'right-click' | 'both') => {
                    this.plugin.settings.triggerMethod = value;
                    await this.plugin.saveSettings();
                    
                    // Show/hide duration settings based on selection
                    this.display();
                }));
    }

    /**
     * Creates duration slider controls for both desktop and mobile
     * Provides both slider and text input for precise control
     * Only shows these settings if long-press is enabled
     */
    private addDurationSettings(): void {
        // Only show duration settings if long-press is enabled
        if (this.plugin.settings.triggerMethod === 'right-click') {
            return; // Skip duration settings for right-click-only mode
        }

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

    /**
     * Creates the click-to-cycle override section.
     * Off by default so plain clicks keep Obsidian's native [ ] <-> [x] toggle.
     * When enabled, shows the cycle as one sequence - tap a state to reassign it
     * via a scroll-snap picker (reordering is just reassigning a slot, so there's
     * no separate drag/reorder UI), plus a "+ Add" button and delete on 3+ states.
     *
     * Editor (Live Preview / Source mode) only, matching this plugin's current scope -
     * Reading view keeps the default toggle regardless of this setting.
     */
    private addCustomCycleSetting(): void {
        new Setting(this.containerEl)
            .setName('Custom checkbox cycle')
            .setDesc('Override what clicking a checkbox cycles through, instead of the default unchecked \u2194 checked toggle.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.cycleEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.cycleEnabled = value;
                    await this.plugin.saveSettings();
                    this.display(); // Show/hide the editor below
                }));

        if (!this.plugin.settings.cycleEnabled) return;

        const cycleContainer = this.containerEl.createDiv({ cls: 'checkbox-cycle-editor' });
        this.cycleContainerEl = cycleContainer;

        new Setting(cycleContainer)
            .setName('Cycle')
            .setDesc('Tap a state to change it. Tap + to add another. A state can only appear once in the cycle.')
            .setHeading();

        this.renderCycleSequence(cycleContainer);

        // Re-open the picker if one was open before this re-render (e.g. after adding a state)
        if (this.openPickerIndex !== null && this.openPickerIndex < this.plugin.settings.cycleStates.length) {
            this.renderCyclePicker(cycleContainer, this.openPickerIndex);
        }
    }

    /** Renders the cycle as one row: state, arrow, state, arrow, ..., + Add */
    private renderCycleSequence(container: HTMLElement): void {
        const cycle = this.plugin.settings.cycleStates;
        const row = container.createDiv({ cls: 'checkbox-cycle-sequence' });

        cycle.forEach((_, index) => {
            this.createCycleSlot(row, index);
            row.createEl('span', { cls: 'checkbox-cycle-arrow', text: '\u2192' });
        });

        const addBtn = row.createEl('button', {
            cls: 'checkbox-cycle-add-button',
            text: '+ Add',
            attr: { type: 'button' }
        });
        addBtn.addEventListener('click', async () => {
            const usedSymbols = new Set(this.plugin.settings.cycleStates);
            const nextStyle = CHECKBOX_STYLES.find(s => !usedSymbols.has(s.symbol));
            if (!nextStyle) {
                new Notice('Every available style is already in this cycle');
                return;
            }

            this.plugin.settings.cycleStates.push(nextStyle.symbol);
            this.openPickerIndex = this.plugin.settings.cycleStates.length - 1;
            await this.plugin.saveSettings();
            this.display(); // Re-render, then auto-opens the picker for the new slot
        });
    }

    /**
     * One slot in the cycle sequence: a tappable chip showing the current state,
     * plus a delete button once there are 3+ states (deleting below 2 isn't allowed).
     */
    private createCycleSlot(container: HTMLElement, index: number): void {
        const cycle = this.plugin.settings.cycleStates;
        const slot = container.createDiv({ cls: 'checkbox-cycle-slot' });

        if (cycle.length >= 3) {
            const removeBtn = slot.createEl('button', {
                cls: 'checkbox-cycle-slot-remove',
                text: '\u00d7',
                attr: { type: 'button', 'aria-label': 'Remove this state' }
            });
            removeBtn.addEventListener('click', async (event) => {
                event.stopPropagation(); // Don't also trigger the chip's open/close click below

                this.plugin.settings.cycleStates.splice(index, 1);
                if (this.openPickerIndex === index) {
                    this.openPickerIndex = null;
                } else if (this.openPickerIndex !== null && this.openPickerIndex > index) {
                    this.openPickerIndex -= 1; // Keep pointing at the same logical slot after the shift
                }
                await this.plugin.saveSettings();
                this.display();
            });
        }

        const chip = slot.createDiv({ cls: 'checkbox-cycle-chip' });
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('data-cycle-index', String(index));
        chip.toggleClass('is-open', this.openPickerIndex === index);

        const toggleOpen = () => {
            this.openPickerIndex = (this.openPickerIndex === index) ? null : index;
            this.display();
        };
        chip.addEventListener('click', toggleOpen);
        chip.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleOpen();
            }
        });

        this.renderCycleChipContent(chip, cycle[index]);
    }

    /**
     * Renders (or re-renders) a slot chip's checkbox preview for the given symbol.
     *
     * The rendered <li> has no trailing <p>/text node at all - `li.innerHTML` is
     * just the bare `<input class="task-list-item-checkbox">`. So the extra space
     * to the right of the checkbox was never about hidden trailing content. The
     * actual cause: the `markdown-source-view mod-cm6 cm-s-obsidian` classes needed
     * for per-symbol theming (themes key a symbol's icon/color off data-task on the
     * <li>) were applied directly to the chip's own flex container - and those same
     * classes are exactly what a theme's own (likely !important) layout rules
     * target, which breaks the chip's own `display: flex; justify-content: center`
     * the same way it previously broke the ul/li. Fix: keep the theme classes off
     * the actual flex/centering container, and put them on an inner wrapper instead
     * - one that gets neutralized to `display: contents` via inline !important,
     * same technique already used on ul/li, so it stays in the ancestor chain for
     * theming purposes without contributing a box of its own.
     */
    private renderCycleChipContent(chip: HTMLElement, symbol: string): void {
        chip.empty();
        try {
            const themeWrapper = chip.createDiv({ cls: 'markdown-source-view mod-cm6 cm-s-obsidian' });
            const markdown = `- [${symbol}] `;
            const renderChild = new MarkdownRenderChild(themeWrapper);
            this.plugin.addChild(renderChild);
            MarkdownRenderer.render(this.app, markdown, themeWrapper, '', renderChild)
                .then(() => {
                    this.isolateChipCheckboxLayout(themeWrapper, symbol);
                })
                .catch(() => {
                    chip.empty();
                    chip.setText(`[${symbol}]`);
                });
        } catch {
            chip.setText(`[${symbol}]`);
        }
    }

    /**
     * Forces the theme-class wrapper, the rendered ul/li, and the checkbox <input>
     * itself into a centered, shrink-to-fit layout, all via inline !important (the
     * only thing that reliably beats a theme's own !important stylesheet rules
     * regardless of specificity). The <input>'s own margin reset matters as much as
     * the ul/li display changes - see the comment above that line for why.
     */
    private isolateChipCheckboxLayout(themeWrapper: HTMLElement, symbol: string): void {
        const ul = themeWrapper.querySelector('ul');
        const li = themeWrapper.querySelector('li');

        if (!ul || !li) {
            themeWrapper.empty();
            themeWrapper.setText(`[${symbol}]`);
            return;
        }

        // The wrapper itself carries the theme classes purely so data-task theming
        // resolves on the li below - those same classes are what fight our chip's
        // centering (see docstring above), so neutralize the wrapper's own box too.
        themeWrapper.style.setProperty('display', 'contents', 'important');

        // Remove the ul's own box entirely so its width/alignment can't matter -
        // the li becomes a direct flex item of the chip instead
        ul.style.setProperty('display', 'contents', 'important');

        // Shrink the li to its content (just the checkbox - the rendered markup
        // has no trailing <p>/text node to also hide)
        li.style.setProperty('display', 'inline-flex', 'important');
        li.style.setProperty('align-items', 'center', 'important');
        li.style.setProperty('justify-content', 'center', 'important');
        li.style.setProperty('width', 'auto', 'important');
        li.style.setProperty('margin', '0', 'important');
        li.style.setProperty('padding', '0', 'important');
        li.style.setProperty('pointer-events', 'none', 'important'); // Clicks land on the chip itself

        // The checkbox <input> itself carries a baked-in negative left margin from
        // the theme (e.g. margin: 0 0 0 -22.5px), meant to pull the checkbox back
        // into a normal task-list's marker/indent space. Since we've stripped that
        // marker/indent entirely (ul/li collapsed via display: contents above), the
        // same negative margin now just drags the checkbox off to the left instead.
        // Our own stylesheet already resets this margin, but as a plain
        // (non-!important) rule it loses to the theme's - same fix as ul/li: force
        // it inline with !important, which nothing else can outrank.
        const input = li.querySelector('input');
        if (input) {
            input.style.setProperty('margin', '0', 'important');
        }
    }

    /**
     * Renders the scroll-snap picker for one cycle slot, inline below the sequence
     * row. Offers every style not already used by another slot (a state can't
     * appear twice - the cycle-advance logic looks up "what's next" by the current
     * symbol's position, so a duplicate would make one occurrence unreachable).
     * Selection applies live as the list settles after scrolling, or immediately
     * on tapping an option; "Done" just collapses the picker back down.
     */
    private renderCyclePicker(container: HTMLElement, index: number): void {
        const cycle = this.plugin.settings.cycleStates;
        const usedElsewhere = new Set(cycle.filter((_, i) => i !== index));
        const options = CHECKBOX_STYLES.filter(s => !usedElsewhere.has(s.symbol));

        const picker = container.createDiv({ cls: 'checkbox-cycle-picker' });

        const header = picker.createDiv({ cls: 'checkbox-cycle-picker-header' });
        const doneBtn = header.createEl('button', {
            cls: 'checkbox-cycle-picker-done',
            text: 'Done',
            attr: { type: 'button' }
        });
        doneBtn.addEventListener('click', () => {
            this.openPickerIndex = null;
            this.display();
        });

        if (options.length === 0) {
            picker.createEl('p', {
                cls: 'setting-item-description',
                text: 'Every available style is already used elsewhere in this cycle.'
            });
            return;
        }

        const viewport = picker.createDiv({ cls: 'checkbox-cycle-picker-viewport' });
        viewport.createDiv({ cls: 'checkbox-cycle-picker-band' }); // Positioned via CSS, purely visual
        viewport.createDiv({ cls: 'checkbox-cycle-picker-spacer' });

        const items: { el: HTMLElement; symbol: string }[] = [];
        options.forEach(style => {
            const item = viewport.createDiv({ cls: 'checkbox-cycle-picker-item' });
            try {
                const markdown = `- [${style.symbol}] ${style.description}`;
                const renderChild = new MarkdownRenderChild(item);
                this.plugin.addChild(renderChild);
                MarkdownRenderer.render(this.app, markdown, item, '', renderChild)
                    .catch(() => {
                        item.empty();
                        item.setText(`[${style.symbol}] ${style.description}`);
                    });
            } catch {
                item.setText(`[${style.symbol}] ${style.description}`);
            }

            item.addEventListener('click', () => {
                this.applyCyclePickerSelection(index, style.symbol, items, item, true);
            });

            items.push({ el: item, symbol: style.symbol });
        });

        viewport.createDiv({ cls: 'checkbox-cycle-picker-spacer' });

        let settleTimer: number | undefined;
        viewport.addEventListener('scroll', () => {
            window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(() => {
                const centerY = viewport.scrollTop + viewport.clientHeight / 2;
                let closest = items[0];
                let closestDistance = Infinity;
                for (const entry of items) {
                    const mid = entry.el.offsetTop + entry.el.clientHeight / 2;
                    const distance = Math.abs(mid - centerY);
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closest = entry;
                    }
                }
                this.applyCyclePickerSelection(index, closest.symbol, items, closest.el, false);
            }, 120);
        }, { passive: true });

        // Open already centered on the slot's current value, no scroll animation
        requestAnimationFrame(() => {
            const current = items.find(entry => entry.symbol === cycle[index]) ?? items[0];
            current.el.scrollIntoView({ block: 'center' });
            this.markCenteredPickerItem(items, current.el);
        });
    }

    /**
     * Applies a picker selection: updates settings, the highlighted item, and the
     * corresponding chip in the sequence row above - without a full display()
     * re-render, so the picker stays open and scroll position isn't disturbed.
     */
    private async applyCyclePickerSelection(
        index: number,
        symbol: string,
        items: { el: HTMLElement; symbol: string }[],
        selectedEl: HTMLElement,
        smoothScroll: boolean
    ): Promise<void> {
        if (this.plugin.settings.cycleStates[index] === symbol) {
            this.markCenteredPickerItem(items, selectedEl);
            return; // No change - avoid an unnecessary save
        }

        this.plugin.settings.cycleStates[index] = symbol;
        await this.plugin.saveSettings();

        this.markCenteredPickerItem(items, selectedEl);

        const chip = this.cycleContainerEl?.querySelector(
            `.checkbox-cycle-chip[data-cycle-index="${index}"]`
        ) as HTMLElement | null;
        if (chip) this.renderCycleChipContent(chip, symbol);

        if (smoothScroll) {
            selectedEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    /** Marks exactly one picker item as the centered/selected one */
    private markCenteredPickerItem(items: { el: HTMLElement }[], selectedEl?: HTMLElement): void {
        items.forEach(entry => entry.el.toggleClass('is-centered', entry.el === selectedEl));
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
        new Setting(this.containerEl)
            .setName('Choose which styles to show in the menu:')
            .setHeading();

        const toggleContainer = this.containerEl.createDiv({ cls: 'checkbox-style-toggles' });

        // Organize styles into logical groups
        this.addStyleCategory(toggleContainer, 'Basic', CHECKBOX_STYLES.slice(0, 6));   // Common task states
        this.addStyleCategory(toggleContainer, 'Extras', CHECKBOX_STYLES.slice(6));     // Extended/specialized states

        this.addResetButton(); // Convenience function to restore defaults
    }

    /**
     * Creates the Advanced settings section (collapsible)
     * 
     * This section contains advanced/optional features that most users
     * won't need to adjust. It's collapsed by default to avoid overwhelming
     * users with too many options.
     */
    private addAdvancedSection(): void {
        // Create collapsible section using Obsidian's standard pattern
        const advancedSetting = new Setting(this.containerEl)
            .setName('Advanced')
            .setHeading()
            .setClass('checkbox-style-menu-advanced-heading');

        // Add collapsed class by default
        advancedSetting.settingEl.addClass('checkbox-style-menu-collapsible');
        
        // Create the collapsible content container
        const contentEl = this.containerEl.createDiv('checkbox-style-menu-collapsible-content');
        
        // Restore previous expanded state or default to collapsed
        contentEl.style.display = this.isAdvancedExpanded ? 'block' : 'none';

        // Toggle functionality
        advancedSetting.settingEl.addEventListener('click', () => {
            const isCollapsed = contentEl.style.display === 'none';
            contentEl.style.display = isCollapsed ? 'block' : 'none';
            advancedSetting.settingEl.toggleClass('is-collapsed', !isCollapsed);
            this.isAdvancedExpanded = isCollapsed; // Track state
        });

        // Set initial collapsed state
        advancedSetting.settingEl.toggleClass('is-collapsed', !this.isAdvancedExpanded);

        // Add the compatibility settings inside the collapsible content
        this.addCompatibilitySettings(contentEl);
    }

    /**
     * Adds Tasks plugin compatibility settings
     * Now contained within the Advanced collapsible section
     * Uses the compatibility module to get UI information
     * 
     * @param container - The container element to add settings to
     */
    private addCompatibilitySettings(container: HTMLElement): void {
        // Subheading for plugin compatibility
        new Setting(container)
            .setName('Plugin Compatibility')
            .setHeading();

        // Validate compatibility settings using the compatibility module
        const { wasChanged } = validateAndFixCompatibilitySettings(
            this.plugin.settings,
            this.app
        );

        // Show notice only in settings UI if changes were made (not on startup)
        if (wasChanged) {
            this.plugin.saveSettings();
            new Notice(
                'Tasks plugin compatibility has been disabled because Tasks plugin is not detected.'
            );
        }

        // Get UI info from compatibility module
        const uiInfo = getTasksCompatibilityUIInfo(this.app);

        // Info box with status and details
        const infoDiv = container.createDiv();
        infoDiv.style.marginBottom = '1em';
        infoDiv.style.padding = '12px';
        infoDiv.style.border = '1px solid var(--background-modifier-border)';
        infoDiv.style.borderRadius = '5px';
        infoDiv.style.backgroundColor = 'var(--background-secondary)';
        infoDiv.innerHTML = `
            <p style="margin-top: 0;"><strong>${uiInfo.statusMessage}</strong></p>
            <p style="margin-bottom: 0;">${uiInfo.detailMessage}</p>
        `;

        // Only show toggle when appropriate (determined by compatibility module)
        if (uiInfo.showToggle) {
            new Setting(container)
                .setName('Enable Tasks plugin integration')
                .setDesc('Allows Tasks to add done dates when a checkbox is marked complete via the Checkbox Style Menu.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableTasksCompatibility)
                    .onChange(async (value) => {
                        this.plugin.settings.enableTasksCompatibility = value;
                        await this.plugin.saveSettings();
                        
                        if (value) {
                            new Notice('Tasks integration enabled!');
                        } else {
                            new Notice('Tasks integration disabled.');
                        }
                    }));
        }
    }

    /**
     * Creates a visually grouped section of style toggles
     * Each category gets its own heading for better organization
     */
    private addStyleCategory(container: HTMLElement, categoryName: string, styles: typeof CHECKBOX_STYLES[number][]): void {
        new Setting(container)
            .setName(categoryName)
            .setHeading();
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
        
        let sliderComponent!: SliderComponent;
        let textComponent!: TextComponent;
        
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
        } catch {
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