/**
 * PLUGIN COMPATIBILITY MODULE
 * 
 * Handles integration with third-party Obsidian plugins to ensure
 * Checkbox Style Menu works harmoniously with other task management tools.
 * 
 * This module encapsulates all compatibility logic, keeping the main plugin
 * code clean and focused on core functionality. To add support for a new
 * plugin, implement the relevant functions here without modifying main.ts.
 * 
 * Currently supports:
 * - Tasks Plugin: Enables done dates when marking tasks complete
 */

import { App, Notice } from 'obsidian';

/**
 * INTERFACES
 */

/** Settings related to plugin compatibility */
export interface CompatibilitySettings {
    enableTasksCompatibility: boolean;
    hasShownTasksNotice: boolean;
}

/** Result of applying a checkbox style change */
export interface StyleApplicationResult {
    shouldHideMenu: boolean;  // Whether the menu should be hidden immediately
}

/** Information for rendering compatibility UI in settings */
export interface CompatibilityUIInfo {
    isInstalled: boolean;      // Whether the compatible plugin is installed
    statusMessage: string;     // Status indicator text (e.g., "🟢 Tasks plugin detected")
    detailMessage: string;     // HTML description for the info box
    showToggle: boolean;       // Whether to show the compatibility toggle
}

/**
 * TASKS PLUGIN DETECTION
 */

/**
 * Detects if the Tasks plugin is currently installed and enabled
 * 
 * @param app - Obsidian App instance
 * @returns true if Tasks plugin is active
 */
export function isTasksPluginInstalled(app: App): boolean {
    const tasksPlugin = (app as any).plugins?.plugins?.['obsidian-tasks-plugin'];
    return tasksPlugin !== undefined;
}

/**
 * COMPATIBILITY SETTINGS VALIDATION
 */

/**
 * Validates and fixes compatibility settings based on installed plugins
 * 
 * Automatically disables Tasks integration if Tasks plugin is not available.
 * This prevents invalid states where compatibility is enabled but Tasks is missing,
 * which would cause incorrect checkbox behavior.
 * 
 * Modifies the settings object in place.
 * 
 * @param settings - Settings object containing compatibility properties (modified in place)
 * @param app - Obsidian App instance
 * @returns Object indicating whether changes were made
 */
export function validateAndFixCompatibilitySettings(
    settings: { enableTasksCompatibility: boolean; hasShownTasksNotice: boolean },
    app: App
): { wasChanged: boolean } {
    // Auto-disable compatibility if it's enabled but Tasks is not available
    if (settings.enableTasksCompatibility && !isTasksPluginInstalled(app)) {
        settings.enableTasksCompatibility = false;
        return { wasChanged: true };
    }
    
    return { wasChanged: false };
}

/**
 * COMPATIBILITY WATCHING
 */

/**
 * Creates a callback function for watching plugin enable/disable events
 * 
 * This callback ensures compatibility settings remain valid when plugins
 * are enabled or disabled during an Obsidian session. It should be registered
 * with Obsidian's layout-change event.
 * 
 * @param app - Obsidian App instance
 * @param settings - Compatibility settings object (will be modified in place if needed)
 * @param onSettingsChanged - Callback to save settings when changes are made
 * @returns Callback function to register with layout-change event
 */
export function createCompatibilityWatcher(
    app: App,
    settings: { enableTasksCompatibility: boolean; hasShownTasksNotice: boolean },
    onSettingsChanged: () => Promise<void>
): () => Promise<void> {
    return async () => {
        const { wasChanged } = validateAndFixCompatibilitySettings(settings, app);
        
        if (wasChanged) {
            await onSettingsChanged();
        }
    };
}

/**
 * COMPATIBILITY UI HELPERS
 */

/**
 * Gets UI information for displaying Tasks compatibility settings
 * 
 * Provides all necessary text and flags for rendering the compatibility
 * section in the plugin settings UI. This keeps UI-specific logic in the
 * compatibility module rather than the settings tab.
 * 
 * @param app - Obsidian App instance
 * @returns UI information object for rendering compatibility settings
 */
export function getTasksCompatibilityUIInfo(app: App): CompatibilityUIInfo {
    const isInstalled = isTasksPluginInstalled(app);
    
    if (isInstalled) {
        return {
            isInstalled: true,
            statusMessage: '🟢 Tasks plugin detected',
            detailMessage: 'Enable <a href="https://github.com/obsidian-tasks-group/obsidian-tasks">Tasks plugin</a> integration below to add done dates when marking checkboxes complete using this menu.',
            showToggle: true
        };
    } else {
        return {
            isInstalled: false,
            statusMessage: '🟡 Tasks plugin not detected',
            detailMessage: 'It looks like you don\'t have the Tasks plugin, so you can ignore this setting. If you install the <a href="https://github.com/obsidian-tasks-group/obsidian-tasks">Tasks plugin</a>, you\'ll be able to enable compatibility with Tasks\' done dates feature here.',
            showToggle: false
        };
    }
}

/**
 * CHECKBOX STATE UTILITIES
 */

/**
 * Determines if a checkbox symbol represents a basic toggle state
 * Basic states are [ ] (incomplete) and [x] (complete)
 * 
 * @param symbol - The checkbox symbol character
 * @returns true if the symbol is a basic state
 */
export function isBasicToggleState(symbol: string): boolean {
    return symbol === ' ' || symbol === 'x' || symbol === 'X';
}

/**
 * Gets a human-readable name for a checkbox status symbol
 * Useful for logging and debugging
 * 
 * @param symbol - The checkbox symbol character
 * @returns Human-readable status name
 */
export function getStatusName(symbol: string): string {
    const statusNames: { [key: string]: string } = {
        ' ': 'incomplete',
        'x': 'complete',
        'X': 'complete',
        '-': 'cancelled',
        '/': 'in-progress',
        '>': 'forwarded',
        '<': 'scheduling',
        '?': 'question',
        '!': 'important',
        '*': 'star',
        '"': 'quote',
        'l': 'location',
        'b': 'bookmark',
        'i': 'information',
        'S': 'savings',
        'I': 'idea',
        'p': 'pro',
        'c': 'con',
        'f': 'fire',
        'k': 'key',
        'w': 'win',
        'u': 'up',
        'd': 'down'
    };
    
    return statusNames[symbol] || 'custom';
}

/**
 * CORE COMPATIBILITY LOGIC
 */

/**
 * Determines whether to use a native click event or direct text change
 * when transitioning between checkbox states.
 * 
 * NATIVE CLICK BEHAVIOR ANALYSIS (with Tasks plugin):
 * - [ ] → click → [x]
 * - [x] → click → [ ]
 * - [!], [>], [?], etc. → click → [x]
 * - [-] → click → [ ] (special case!)
 * 
 * When Tasks compatibility is ENABLED:
 * - Uses clicks when they'll produce the correct result AND Tasks can detect them
 * - Uses text changes when clicks would produce wrong results
 * 
 * When Tasks compatibility is DISABLED:
 * - Always uses text changes for predictable behavior
 * 
 * @param currentSymbol - Current checkbox symbol (e.g., ' ', 'x', '!')
 * @param targetSymbol - Desired checkbox symbol
 * @param tasksCompatibilityEnabled - Whether Tasks integration is enabled
 * @returns true if should dispatch click event, false if should use text change
 */
export function shouldUseClickForToggle(
    currentSymbol: string,
    targetSymbol: string,
    tasksCompatibilityEnabled: boolean
): boolean {
    // If Tasks compatibility is disabled, always use text change
    if (!tasksCompatibilityEnabled) {
        return false;
    }

    // No-op case: already at target state
    if (currentSymbol === targetSymbol) {
        return false;
    }

    // Only consider clicks when targeting basic states ([ ] or [x])
    // Custom targets always need text change for precise control
    if (!isBasicToggleState(targetSymbol)) {
        return false;
    }

    // Determine if click from current state will reach target state
    if (targetSymbol === 'x' || targetSymbol === 'X') {
        // To reach [x] via click: current must NOT be [-]
        // Because [-] clicks to [ ], not [x]
        return currentSymbol !== '-';
    } else {
        // To reach [ ] via click: current must be [x] or [-]
        // [x] → click → [ ] ✅
        // [-] → click → [ ] ✅
        // [!] or other → click → [x] ❌ (wrong result)
        return currentSymbol === 'x' || currentSymbol === 'X' || currentSymbol === '-';
    }
}

/**
 * TASKS PLUGIN INTEGRATION - NOTICE MANAGEMENT
 */

/**
 * Shows a one-time notice about Tasks plugin compatibility
 * 
 * This notice informs users that Tasks integration is available if they
 * want done dates and other Tasks features. It only shows:
 * - Once per installation (tracked by hasShownTasksNotice)
 * - When Tasks plugin is actually installed
 * - When the user is marking a task as complete
 * - When compatibility is NOT already enabled (no need to advertise if already on)
 * 
 * @param app - Obsidian App instance
 * @param targetSymbol - The symbol user is trying to apply
 * @param settings - Compatibility settings object
 * @param saveSettings - Callback to save updated settings
 */
export function maybeShowTasksNotice(
    app: App,
    targetSymbol: string,
    settings: CompatibilitySettings,
    saveSettings: () => Promise<void>
): void {
    // Only show once per installation
    if (settings.hasShownTasksNotice) {
        return;
    }

    // Only relevant when Tasks plugin is actually installed
    if (!isTasksPluginInstalled(app)) {
        return;
    }

    // Don't show if compatibility is already enabled
    // User already knows about the feature and has turned it on
    if (settings.enableTasksCompatibility) {
        return;
    }

    // Only show when user is trying to mark something complete
    // This is when Tasks features (like done dates) are most relevant
    if (targetSymbol !== 'x' && targetSymbol !== 'X') {
        return;
    }

    // Show the notice with clear, helpful information
    new Notice(
        'Tasks plugin detected! Enable integration in Checkbox Style Menu settings for compatibility with Tasks\' done dates feature.',
        10000  // Show for 10 seconds so user has time to read it
    );

    // Mark as shown so we don't annoy the user repeatedly
    settings.hasShownTasksNotice = true;
    saveSettings();
}

/**
 * TASKS PLUGIN INTEGRATION - CLICK DISPATCH
 */

/**
 * Applies checkbox style by dispatching a native click event
 * 
 * This method is used when Tasks plugin compatibility is enabled and the
 * native click behavior will produce the correct result. By using actual
 * clicks, we allow the Tasks plugin (and any other plugins) to detect
 * the change and add metadata like done dates.
 * 
 * Process:
 * 1. Remove the overlay so the click can reach the real checkbox
 * 2. Wait for overlay removal to complete
 * 3. Dispatch a realistic click event
 * 4. Return indication that menu should be hidden after click
 * 
 * @param targetElement - The checkbox DOM element to click
 * @param overlayManager - Manager for the checkbox overlay
 * @returns Result indicating menu should hide after delay
 */
export function applyStyleViaClick(
    targetElement: HTMLElement,
    overlayManager: { remove: () => void }
): StyleApplicationResult {
    try {
        // CRITICAL: Remove overlay first so the click can reach the checkbox
        overlayManager.remove();

        // Small delay to ensure overlay is fully removed
        setTimeout(() => {
            // Create a realistic click event that mimics user interaction
            const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                detail: 1,
                button: 0,
                buttons: 1,
            });

            // Dispatch the click on the actual checkbox element
            targetElement.dispatchEvent(clickEvent);

            console.log('Checkbox Style Menu: Used click for Tasks compatibility');
        }, 10);

        // Menu will be hidden by caller after a short delay
        // to allow the click event to be fully processed
        return { shouldHideMenu: false };  // Caller handles hiding with delay

    } catch (error) {
        console.error('Checkbox Style Menu: Error dispatching click:', error);
        // If click fails, indicate menu should be hidden immediately
        return { shouldHideMenu: true };
    }
}

/**
 * DEBUGGING AND LOGGING
 */

/**
 * Logs compatibility decision for debugging
 * Only logs in development mode (can be enabled via plugin setting)
 * 
 * @param currentSymbol - Current checkbox symbol
 * @param targetSymbol - Target checkbox symbol
 * @param useClick - Whether click method was chosen
 * @param debugMode - Whether debug logging is enabled
 */
export function logCompatibilityDecision(
    currentSymbol: string,
    targetSymbol: string,
    useClick: boolean,
    debugMode: boolean = false
): void {
    if (!debugMode) return;

    const method = useClick ? 'CLICK' : 'TEXT CHANGE';
    const currentName = getStatusName(currentSymbol);
    const targetName = getStatusName(targetSymbol);
    
    console.log(
        `Checkbox Style Menu [Compatibility]: [${currentSymbol}] ${currentName} → [${targetSymbol}] ${targetName} via ${method}`
    );
}

/**
 * DOCUMENTATION: KNOWN LIMITATIONS
 * 
 * Even with Tasks compatibility enabled, there's one edge case that
 * can't be handled perfectly:
 * 
 * Limitation: [-] (Cancelled) → [x] (Complete)
 * - Native click behavior: [-] → [ ]
 * - We need: [-] → [x]
 * - Solution: Must use text change
 * - Consequence: Tasks won't add done date
 * 
 * This is acceptable because:
 * 1. Marking a cancelled task as complete is a rare workflow
 * 2. The alternative (using click) would give wrong result ([ ] instead of [x])
 * 3. Most common workflows work perfectly:
 *    - [ ] → [x] ✅ (Tasks adds done date)
 *    - [!] → [x] ✅ (Tasks adds done date)
 *    - [x] → [ ] ✅ (Tasks removes done date)
 * 
 * TESTING SCENARIOS:
 * 
 * ✅ WORKS WITH TASKS (click used):
 * - [ ] → [x] : Click → Tasks adds done date
 * - [!] → [x] : Click → Tasks adds done date
 * - [>] → [x] : Click → Tasks adds done date
 * - [x] → [ ] : Click → Tasks removes done date
 * - [-] → [ ] : Click → Works correctly
 * 
 * ⚠️ TEXT CHANGE NEEDED (Tasks won't detect):
 * - [-] → [x] : Text change (rare edge case)
 * - [!] → [ ] : Text change (click would give [x])
 * - Any → [!] : Text change (custom target)
 * 
 * 💡 NO-OP (just dismiss menu):
 * - [x] → [x] : No change needed
 * - [!] → [!] : No change needed
 */