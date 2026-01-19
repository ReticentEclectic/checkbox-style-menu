
# Checkbox Style Menu

Provides an intuitive menu for quickly changing checkbox styles in [Obsidian](https://obsidian.md)

![Style Change Demo](https://github.com/user-attachments/assets/99900dee-997c-443f-a554-283395572d46)

## Features

- **Quick Style Selection**: Long-press a checkbox to open a style menu
- **22 Checkbox Styles**: Supports all 22 checkbox styles of [Minimal](https://github.com/kepano/obsidian-minimal) and [Things](https://github.com/colineckert/obsidian-things)
- **Customizable**: Choose which styles appear in your menu
- **Theme Compatible**: Matches any theme or custom CSS
- **Cross-Platform**: Works seamlessly on desktop and mobile devices
- **Touch-Optimized**: Mobile-friendly with haptic feedback and optimized touch interactions

## Available Checkbox Styles

### Basic

- `[ ]` To-do
- `[/]` Incomplete
- `[x]` Done
- `[-]` Cancelled
- `[>]` Forwarded
- `[<]` Scheduling

### Extra

- `[?]` Question
- `[!]` Important
- `[*]` Star
- `["]` Quote
- `[l]` Location
- `[b]` Bookmark
- `[i]` Information
- `[S]` Savings
- `[I]` Idea
- `[p]` Pro
- `[c]` Con
- `[f]` Fire
- `[k]` Key
- `[w]` Win
- `[u]` Up
- `[d]` Down

### Theme Adaptive

![Theme Demo](https://github.com/user-attachments/assets/8169c7c3-5337-4e59-a391-4910fbf303bd)

## Installation

### From Obsidian Community Plugins (Recommended)

1. Open **Settings → Community Plugins**
2. Click **Browse** and search for **"Checkbox Style Menu"**
3. Click **Install**, then **Enable**

### Manual Installation

1. Download the latest release from GitHub
4. Extract to `YourVaultFolder/.obsidian/plugins/checkbox-style-menu/`
5. Reload Obsidian and enable in Community Plugins

## Usage

### Triggering the Menu

Choose your preferred method in settings:
- **Long-press** (default): Hold a checkbox for a moment
- **Right-click**: Right-click a checkbox to open the menu
- **Hotkey**: Assign a custom keyboard shortcut in **Settings → Hotkeys**

### Desktop

1. **Long-press** a checkbox
2. A menu will appear showing your enabled checkbox styles
3. **Click** on any style to apply it to the checkbox

### Mobile

1. **Long-press** a checkbox
2. A scrollable horizontal menu appears above or below the checkbox
3. **Tap** any style to apply it

## Configuration

Access plugin settings through: **Settings → Community Plugins → Checkbox Style Menu**

### Available Options

- **Long Press Duration (Desktop)**: Adjust how long to hold before the menu appears (100-1000ms)
- **Long Press Duration (Mobile)**: Separate timing for mobile devices (200-1500ms)
- **Enable Haptic Feedback**: Toggle vibration feedback on mobile devices
- **Style Selection**: Choose which checkbox styles appear in your menu

### Customizing Your Menu

You can enable/disable any of the 22 available checkbox styles:

1. Go to plugin settings
2. Under "Choose which styles to show in the menu"
3. Toggle individual styles on/off
4. Only enabled styles will appear in the selection menu

## Compatibility

- **Obsidian Version**: Requires Obsidian 0.15.0 or later
- **Platforms**: Desktop and Mobile
- **Note Types**: Works with any note containing markdown checkboxes
- **Live-Preview Only**: Does not work in *Reading view* or *Source mode*
- **Requires Compatible Theme:** Any theme that adds checkbox styles (e.g. [Minimal](https://github.com/kepano/obsidian-minimal) or [Things](https://github.com/colineckert/obsidian-things))

## Third-Party Plugin Compatibility

### Tasks Plugin Integration

Optional integration with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin. When enabled, Tasks can add done dates when you mark checkboxes as *complete* using the Checkbox Style Menu.

#### Enabling Tasks Integration

1. Install and enable the Tasks plugin
2. Open **Settings → Community Plugins → Checkbox Style Menu**
3. Expand the **Advanced** section
4. Toggle on **Enable Tasks plugin integration**

#### Known Limitations

- **Cancelled → Complete**
	Changing from `[-]` (cancelled) → `[x]` (complete) will not trigger a done date. This is because this transition is not part of Tasks’ normal completion workflow. To add a done date, Tasks expects the sequence `[-]` → `[ ]` → `[x]`.

- **Complete → Custom State**
	Changing from `[x]` (completed) → `any custom checkbox style` (such as `[!]`, `[?]`, or `[>]`) will not remove the done date. This is because Tasks expects the sequence `[x]` → `[ ]` to remove it.

All other transitions (such as `[ ]` → `[x]`, `[!]` → `[x]`, or `[x]` → `[ ]`) work seamlessly with Tasks' done date feature.

**Note:** The **Set done date on every completed task** feature must be enabled in Tasks' settings for this integration to work.

## Troubleshooting

### Menu Not Working

- Check that you're long-pressing (not just clicking) a checkbox
- Ensure you have a compatible theme enabled 
- Verify the long-press duration in settings matches your preference

### Mobile Issues

- Make sure you're not scrolling while trying to long-press
- Make sure you're not missing the checkbox (they can be small on mobile)

## Contributing

If you would like to contribute, please feel free to:

- Report bugs or request features via [GitHub Issues](https://github.com/ReticentEclectic/checkbox-style-menu/issues)
- Submit pull requests with improvements

## Privacy & Data

All operations are performed locally. No user data is collected, stored, or transmitted at any point.

## License

This project is licensed under the [0BSD License](LICENSE) - you are free to use it however you'd like.

## Author

Developed by ReticentEclectic.

## Support

If this plugin made your life easier and you’d like to say thanks, consider buying me a coffee: [Ko-fi](https://ko-fi.com/ReticentEclectic).

## Disclaimer

This plugin has been primarily developed and tested on macOS and iOS. While it's designed to work across all platforms and themes, it is not thoroughly tested across all operating systems and use cases.
