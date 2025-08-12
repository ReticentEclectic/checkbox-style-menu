//Main.ts for Checkbox Style Menu

import { Plugin, MarkdownRenderer, MarkdownRenderChild, PluginSettingTab, App, Setting, setTooltip, Platform, Notice } from 'obsidian';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { createPopper, Instance as PopperInstance, Placement } from '@popperjs/core';

// Plugin settings interface for checkbox style configuration
interface CheckboxStyleSettings {
    styles: { [symbol: string]: boolean };
    longPressDuration: number;
    touchLongPressDuration: number;
    enableHapticFeedback: boolean;
}

// Widget state
interface WidgetState {
    timer: NodeJS.Timeout | null;
    lastTarget: HTMLElement | null;
    touchStart?: { x: number; y: number; time: number };
}

/**
 * CONSTANTS AND CONFIGURATION
 */

// Master list of available checkbox styles
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

// Pre-compiled regex patterns
const CHECKBOX_REGEX = /^\s*(?:-|\d+\.)\s*\[(.)\]\s*(.*)?$/;
const CHECKBOX_SYMBOL_REGEX = /(?:-|\d+\.)\s*\[(.)\]/;

// Default plugin settings
const DEFAULT_SETTINGS: CheckboxStyleSettings = {
    styles: Object.fromEntries(
        CHECKBOX_STYLES.map(style => [style.symbol, [' ', '/', 'x', '-'].includes(style.symbol)])
    ),
    longPressDuration: 350,
    touchLongPressDuration: 500,
    enableHapticFeedback: true,
};

// Gesture detection constants
const SCROLL_THRESHOLD = 10;
const TAP_TIME_THRESHOLD = 300;

/**
 * CODEMIRROR STATE EFFECTS
 */

const showWidgetEffect = StateEffect.define<{ 
    pos: number;
    target: HTMLElement;
    view: EditorView;
}>({
    map: (val, change) => ({ 
        ...val,
        pos: change.mapPos(val.pos)
    })
});

const hideWidgetEffect = StateEffect.define<void>();

/**
 * UTILITY FUNCTIONS
 */

// Consolidated haptic feedback
const triggerHapticFeedback = (duration = 50) => {
    if (Platform.isMobile && 'vibrate' in navigator) {
        navigator.vibrate(duration);
    }
};

// Consolidated checkbox validation
const isValidCheckboxTarget = (target: HTMLElement): boolean => {
    return target.matches('.task-list-item-checkbox') && !target.closest('.checkbox-style-menu-widget');
};

/**
 * OVERLAY MANAGEMENT
 */
class OverlayManager {
    private overlayElement: HTMLElement | null = null;
    private abortController: AbortController | null = null;

    create(checkbox: HTMLElement): HTMLElement {
        this.remove();
        
        const rect = checkbox.getBoundingClientRect();
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'checkbox-overlay';
        
        Object.assign(this.overlayElement.style, {
            position: 'fixed',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            zIndex: '999',
            pointerEvents: 'auto'
        });
        
        this.setupEventListeners();
        document.body.appendChild(this.overlayElement);
        return this.overlayElement;
    }

    private setupEventListeners() {
        if (!this.overlayElement) return;

        this.abortController = new AbortController();
        const { signal } = this.abortController;

        const preventEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        };
        
        // Block interaction events
        ['mouseup', 'mousedown', 'click', 'touchstart', 'touchend', 'touchcancel']
            .forEach(eventType => {
                this.overlayElement!.addEventListener(eventType, preventEvent, 
                    { signal, passive: false });
            });

        // Desktop: Temporarily disable pointer events during scroll
        if (!Platform.isMobile) {
            const throttledWheelHandler = this.throttle(() => {
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

            // Remove overlay on mouse leave
            this.overlayElement.addEventListener('mouseleave', () => {
                this.remove();
            }, { signal, passive: true });
        }

        // Mobile: Remove overlay when scrolling starts
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

    private throttle<T extends (...args: any[]) => void>(func: T, delay: number): T {
        let lastCall = 0;
        return ((...args: Parameters<T>) => {
            const now = Date.now();
            if (now - lastCall >= delay) {
                lastCall = now;
                return func(...args);
            }
        }) as T;
    }

    remove() {
        this.abortController?.abort();
        this.abortController = null;
        
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
    }
}

/**
 * CHECKBOX STYLE MENU WIDGET
 */
class CheckboxStyleWidget {
    private menuElement: HTMLElement | null = null;
    private popperInstance: PopperInstance | null = null;
    private menuTimeout: NodeJS.Timeout | null = null;
    private abortController: AbortController | null = null;
    private enabledStyles: Array<{ symbol: string; description: string; enabled: boolean }> | null = null;

    constructor(
        private plugin: CheckboxStyleMenuPlugin, 
        private linePos: number, 
        private targetElement: HTMLElement
    ) {}

    async show(view: EditorView) {
        await this.createMenu();
        this.setupPopper();
        this.setupEventListeners(view);
        this.startDismissTimeout(view, Platform.isMobile ? 3000 : 2000);
    }

    hide(view: EditorView) {
        this.cleanup();
        // Clean up tooltips
        document.querySelectorAll('.tooltip, [class*="tooltip"]').forEach(el => el.remove());
        view.dispatch({ effects: hideWidgetEffect.of(undefined) });
    }

    private async createMenu() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'checkbox-style-menu-widget';
        this.menuElement.setAttribute('role', 'menu');

        const enabledStyles = this.getEnabledStyles();
        if (enabledStyles.length === 0) {
            this.menuElement.textContent = 'No styles enabled';
        } else {
            await this.renderMenuContent(enabledStyles);
        }
        
        document.body.appendChild(this.menuElement);
    }

    private setupPopper() {
        if (!this.menuElement) return;

        const placement: Placement = Platform.isMobile ? 'top' : 'left-start';
        const config = {
            placement,
            modifiers: [
                { 
                    name: 'offset', 
                    options: { 
                        offset: Platform.isMobile ? [0, 8] : [-8, 8]
                    } 
                },
                { 
                    name: 'flip', 
                    options: { 
                        fallbackPlacements: Platform.isMobile ? 
                            ['bottom', 'left', 'right'] : ['right-start', 'left-end', 'right-end'] 
                    } 
                },
                { name: 'preventOverflow', options: { padding: 8 } },
            ],
        };

        this.popperInstance = createPopper(this.targetElement, this.menuElement, config);
    }

    private async renderMenuContent(enabledStyles: any[]) {
        if (!this.menuElement) return;

        const markdown = enabledStyles.map(style => `- [${style.symbol}] `).join('\n');
        const renderChild = new MarkdownRenderChild(this.menuElement);
        this.plugin.addChild(renderChild);
        
        await MarkdownRenderer.render(this.plugin.app, markdown, this.menuElement, '', renderChild);

        // Add tooltips and data attributes
        this.menuElement.querySelectorAll('li').forEach((li, index) => {
            li.setAttribute('data-style-index', index.toString());
            li.setAttribute('role', 'menuitem');
            li.setAttribute('tabindex', '0');
            setTooltip(li as HTMLElement, enabledStyles[index].description, {
                placement: Platform.isMobile ? 'top' : 'right'
            });
        });
    }

    private getEnabledStyles() {
        if (!this.enabledStyles) {
            this.enabledStyles = this.plugin.checkboxStyles.filter(style => style.enabled);
        }
        return this.enabledStyles;
    }

    private setupEventListeners(view: EditorView) {
        if (!this.menuElement) return;

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        if (Platform.isMobile) {
            this.setupTouchHandling(view, signal);
        } else {
            this.menuElement.addEventListener('mouseup', (e: MouseEvent) => {
                const li = (e.target as HTMLElement).closest('li');
                if (li) {
                    e.stopPropagation();
                    e.preventDefault();
                    this.handleStyleSelection(view, li);
                }
            }, { signal });
        }

        this.setupTimeoutHandling(view, signal);
    }

    private setupTouchHandling(view: EditorView, signal: AbortSignal) {
        if (!this.menuElement) return;

        let touchStart: { x: number; y: number; time: number } | null = null;

        this.menuElement.addEventListener('touchstart', (e: TouchEvent) => {
            const touch = e.touches[0];
            touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        }, { signal, passive: false });

        this.menuElement.addEventListener('touchend', (e: TouchEvent) => {
            const li = (e.target as HTMLElement).closest('li');
            if (!touchStart || !li) return;

            const touch = e.changedTouches[0];
            const deltaX = Math.abs(touch.clientX - touchStart.x);
            const deltaY = Math.abs(touch.clientY - touchStart.y);
            const duration = Date.now() - touchStart.time;

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

    private setupTimeoutHandling(view: EditorView, signal: AbortSignal) {
        if (!this.menuElement) return;

        const eventType = Platform.isMobile ? 'touchstart' : 'mousedown';

        // Hide menu when clicking outside
        document.addEventListener(eventType, (e: Event) => {
            if (!this.menuElement?.contains(e.target as Node) && e.target !== this.targetElement) {
                this.hide(view);
            }
        }, { signal, capture: true });

        // Platform-specific timeout management
        if (Platform.isMobile) {
            this.menuElement.addEventListener('touchstart', () => this.clearTimeout(), { signal });
            this.menuElement.addEventListener('touchend', (e) => {
                const li = (e.target as HTMLElement).closest('li');
                if (!li) {
                    setTimeout(() => this.startDismissTimeout(view, 3000), 100);
                }
            }, { signal });
        } else {
            this.menuElement.addEventListener('mouseenter', () => this.clearTimeout(), { signal });
            this.menuElement.addEventListener('mouseleave', () => this.startDismissTimeout(view, 2000), { signal });
        }
    }

    private handleStyleSelection(view: EditorView, li: HTMLElement) {
        const index = parseInt(li.getAttribute('data-style-index') || '0', 10);
        const symbol = this.getEnabledStyles()[index].symbol;
        
        if (this.plugin.settings.enableHapticFeedback) {
            triggerHapticFeedback();
        }
        
        this.applyCheckboxStyle(view, symbol);
        this.hide(view);
    }

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

    private applyCheckboxStyle(view: EditorView, symbol: string) {
        const line = view.state.doc.lineAt(this.linePos);
        
        if (!this.plugin.isCheckboxLine(line.text)) return;

        const match = line.text.match(CHECKBOX_SYMBOL_REGEX);
        if (!match) return;

        const startIndex = match.index! + match[0].indexOf('[') + 1;
        const from = line.from + startIndex;

        view.dispatch({
            changes: { from, to: from + 1, insert: symbol }
        });
    }

    private cleanup() {
        this.clearTimeout();
        this.abortController?.abort();
        this.abortController = null;
        
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
        this.enabledStyles = null;
    }
}

/**
 * CODEMIRROR STATE MANAGEMENT
 */

const checkboxWidgetState = StateField.define<{
    widget: CheckboxStyleWidget | null;
    overlayManager: OverlayManager;
}>({
    create: () => ({ widget: null, overlayManager: new OverlayManager() }),
    update(state, tr) {
        let { widget, overlayManager } = state;

        for (let effect of tr.effects) {
            if (effect.is(showWidgetEffect)) {
                const { pos, target, view } = effect.value;
                const plugin = tr.state.field(pluginInstanceField);
                if (!plugin) return state;
                
                widget?.destroy();
                widget = new CheckboxStyleWidget(plugin, pos, target);
                widget.show(view);
                
            } else if (effect.is(hideWidgetEffect)) {
                widget?.destroy();
                widget = null;
                overlayManager.remove();
            }
        }

        return { widget, overlayManager };
    }
});

const pluginInstanceField = StateField.define<CheckboxStyleMenuPlugin | null>({
    create: () => null,
    update: (value) => value
});

/**
 * INTERACTION HANDLER
 */
class InteractionHandler {
    private state: WidgetState = { timer: null, lastTarget: null };
    private abortController: AbortController | null = null;

    constructor(private view: EditorView, private plugin: CheckboxStyleMenuPlugin) {
        this.setupEventListeners();
    }

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

    destroy() {
        this.clearTimer();
        this.abortController?.abort();
        this.abortController = null;
    }

    private clearTimer() {
        if (this.state.timer) {
            clearTimeout(this.state.timer);
            this.state.timer = null;
        }
    }

    private handleLongPress(target: HTMLElement) {
        try {
            const pos = this.view.posAtDOM(target);
            if (pos === null || pos < 0 || pos > this.view.state.doc.length) return;

            const line = this.view.state.doc.lineAt(pos);
            if (!this.plugin.isCheckboxLine(line.text)) return;

            if (this.plugin.settings.enableHapticFeedback) {
                triggerHapticFeedback(75);
            }

            // Hide existing widget and create overlay
            this.view.dispatch({ effects: hideWidgetEffect.of(undefined) });
            
            const overlayManager = this.view.state.field(checkboxWidgetState).overlayManager;
            overlayManager.create(target);

            this.view.dispatch({
                effects: showWidgetEffect.of({ pos, target, view: this.view })
            });
        } catch (error) {
            console.error('Error in handleLongPress:', error);
        }
    }

    // Mouse handlers
    private handleMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;
        
        if (isValidCheckboxTarget(target)) {
            this.state.lastTarget = target;
            this.clearTimer();
            
            this.state.timer = setTimeout(() => {
                if (this.state.lastTarget === target) {
                    this.handleLongPress(target);
                    event.preventDefault();
                }
            }, this.plugin.settings.longPressDuration);
        }
    }

    private handleMouseUp() {
        this.clearTimer();
        this.state.lastTarget = null;
    }

    // Touch handlers
    private handleTouchStart(event: TouchEvent) {
        const target = event.target as HTMLElement;
        
        if (isValidCheckboxTarget(target) && event.touches.length === 1) {
            const touch = event.touches[0];
            this.state.lastTarget = target;
            this.state.touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
            this.clearTimer();
            
            this.state.timer = setTimeout(() => {
                if (this.state.lastTarget === target) {
                    this.handleLongPress(target);
                    event.preventDefault();
                }
            }, this.plugin.settings.touchLongPressDuration);
        }
    }

    private handleTouchMove(event: TouchEvent) {
        if (this.state.touchStart && event.touches.length === 1) {
            const touch = event.touches[0];
            const deltaX = Math.abs(touch.clientX - this.state.touchStart.x);
            const deltaY = Math.abs(touch.clientY - this.state.touchStart.y);
            
            if (deltaX > SCROLL_THRESHOLD || deltaY > SCROLL_THRESHOLD) {
                this.clearTimer();
                this.state.lastTarget = null;
                this.state.touchStart = undefined;
            }
        }
    }

    private handleTouchEnd() {
        this.clearTimer();
        this.state.lastTarget = null;
        this.state.touchStart = undefined;
    }
}

/**
 * CODEMIRROR VIEW PLUGIN
 */
const checkboxViewPlugin = ViewPlugin.fromClass(class {
    private interactionHandler: InteractionHandler | null = null;

    constructor(private view: EditorView) {
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
 */
export default class CheckboxStyleMenuPlugin extends Plugin {
    settings!: CheckboxStyleSettings;
    public checkboxStyles = CHECKBOX_STYLES.map(style => ({ ...style, enabled: false }));

    async onload() {
        await this.loadSettings();
        this.updateCheckboxStyles();
        this.registerEditorExtensions();
        this.addSettingTab(new CheckboxStyleSettingTab(this.app, this));
        
        console.log('Loaded Checkbox Style Menu');
    }

    onunload() {
        console.log('Unloaded Checkbox Style Menu');
    }

    private updateCheckboxStyles() {
        this.checkboxStyles.forEach(style => {
            style.enabled = this.settings.styles[style.symbol] ?? false;
        });
    }

    private registerEditorExtensions() {
        this.registerEditorExtension([
            checkboxWidgetState,
            checkboxViewPlugin,
            pluginInstanceField.init(() => this)
        ]);
    }

    async saveSettings() {
        // Clamp values to valid ranges
        this.settings.longPressDuration = Math.max(100, Math.min(1000, this.settings.longPressDuration));
        this.settings.touchLongPressDuration = Math.max(200, Math.min(1500, this.settings.touchLongPressDuration));
        
        await this.saveData(this.settings);
        this.updateCheckboxStyles();
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...data,
            styles: this.validateStylesObject(data?.styles),
            longPressDuration: this.validateDuration(data?.longPressDuration, 100, 1000, 350),
            touchLongPressDuration: this.validateDuration(data?.touchLongPressDuration, 200, 1500, 500),
            enableHapticFeedback: data?.enableHapticFeedback ?? true
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
        
        const validated: { [symbol: string]: boolean } = {};
        CHECKBOX_STYLES.forEach(style => {
            validated[style.symbol] = typeof styles[style.symbol] === 'boolean' ? 
                styles[style.symbol] : DEFAULT_SETTINGS.styles[style.symbol];
        });
        
        return validated;
    }

    public isCheckboxLine(line: string): boolean {
        return CHECKBOX_REGEX.test(line);
    }
}

/**
 * SETTINGS TAB CLASS
 */
class CheckboxStyleSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: CheckboxStyleMenuPlugin) {
        super(app, plugin);
    }

    display(): void {
        this.containerEl.empty();
        this.addDurationSettings();
        this.addMobileSettings();
        this.addStyleToggles();
    }

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

    private addStyleToggles(): void {
        this.containerEl.createEl('h2', { text: 'Choose which styles to show in the menu:' });

        const toggleContainer = this.containerEl.createDiv({ cls: 'checkbox-style-toggles' });

        // Basic styles
        this.addStyleCategory(toggleContainer, 'Basic', CHECKBOX_STYLES.slice(0, 6));
        // Extras styles  
        this.addStyleCategory(toggleContainer, 'Extras', CHECKBOX_STYLES.slice(6));

        this.addResetButton();
    }

    private addStyleCategory(container: HTMLElement, categoryName: string, styles: typeof CHECKBOX_STYLES[number][]): void {
        container.createEl('h3', { text: categoryName });
        styles.forEach(style => this.createStyleToggle(container, style));
    }

    private addResetButton(): void {
        new Setting(this.containerEl)
            .setName('Reset all checkbox style selections to default')
            .addButton(button => button
                .setButtonText('Reset')
                .onClick(async () => {
                    this.plugin.settings.styles = { ...DEFAULT_SETTINGS.styles };
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice('Checkbox styles reset to default');
                }));
    }

    private createDurationSetting(name: string, desc: string, key: keyof CheckboxStyleSettings, min: number, max: number): void {
        const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
        
        let sliderComponent: any;
        let textComponent: any;
        
        setting
            .addSlider(slider => {
                sliderComponent = slider;
                return slider
                    .setLimits(min, max, 50)
                    .setValue(this.plugin.settings[key] as number)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        (this.plugin.settings[key] as number) = value;
                        await this.plugin.saveSettings();
                        textComponent.setValue(value.toString());
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
                            sliderComponent.setValue(numValue);
                        }
                    });
            });
    }
    
    private createStyleToggle(container: HTMLElement, style: typeof CHECKBOX_STYLES[number]): void {
        try {
            const setting = new Setting(container);
            const nameContainer = container.createDiv();
            nameContainer.className = 'setting-item-name markdown-source-view mod-cm6 cm-s-obsidian';
            
            const markdown = `- [${style.symbol}] ${style.description}`;
            const renderChild = new MarkdownRenderChild(nameContainer);
            this.plugin.addChild(renderChild);
            
            MarkdownRenderer.render(this.app, markdown, nameContainer, '', renderChild)
                .then(() => {
                    const nameFragment = document.createDocumentFragment();
                    nameFragment.appendChild(nameContainer);
                    
                    setting.setName(nameFragment);
                    setting.addToggle(toggle => toggle
                        .setValue(this.plugin.settings.styles[style.symbol] ?? false)
                        .onChange(async (value) => {
                            this.plugin.settings.styles[style.symbol] = value;
                            const styleObj = this.plugin.checkboxStyles.find(s => s.symbol === style.symbol);
                            if (styleObj) styleObj.enabled = value;
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