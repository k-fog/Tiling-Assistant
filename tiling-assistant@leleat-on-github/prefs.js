'use strict';

const { Gdk, Gio, GLib, Gtk, GObject } = imports.gi;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const LayoutPrefs = Me.imports.src.prefs.layoutsPrefs.Prefs;
const { Changelog } = Me.imports.src.prefs.changelog;
const { ListRow } = Me.imports.src.prefs.listRow;
const { ShortcutListener } = Me.imports.src.prefs.shortcutListener;
const { Settings, Shortcuts } = Me.imports.src.common;

function init() {
    ExtensionUtils.initTranslations(Me.metadata.uuid);
}

function buildPrefsWidget() {
    // Load css file
    const provider = new Gtk.CssProvider();
    const path = GLib.build_filenamev([Me.path, 'src/stylesheet/prefs.css']);
    provider.load_from_path(path);
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    return new PrefsWidget();
}

const PrefsWidget = GObject.registerClass({
    GTypeName: 'TilingAssistantPrefs',
    Template: Gio.File.new_for_path(`${Me.path}/src/ui/prefs.ui`).get_uri(),
    InternalChildren: [
        'title_bar',
        'enable_tiling_popup',
        'tiling_popup_all_workspace',
        'enable_raise_tile_group',
        'window_gap',
        'screen_gap',
        'maximize_with_gap',
        'dynamic_keybinding_disabled_row',
        'dynamic_keybinding_window_focus_row',
        'dynamic_keybinding_tiling_state_row',
        'dynamic_keybinding_tiling_state_windows_row',
        'dynamic_keybinding_favorite_layout_row',
        'toggle_tiling_popup',
        'tile_edit_mode',
        'auto_tile',
        'tile_maximize',
        'tile_top_half',
        'tile_bottom_half',
        'tile_left_half',
        'tile_right_half',
        'tile_topleft_quarter',
        'tile_topright_quarter',
        'tile_bottomleft_quarter',
        'tile_bottomright_quarter',
        'search_popup_layout',
        'change_favorite_layout',
        'layouts_listbox',
        'add_layout_button',
        'save_layouts_button',
        'reload_layouts_button',
        'hidden_settings_page',
        'enable_advanced_experimental_features',
        'show_changelog_on_update',
        'enable_tile_animations',
        'enable_untile_animations',
        'edge_tiling_row',
        'split_tiles_row',
        'favorite_layout_row',
        'move_split_tiles_mod',
        'move_favorite_layout_mod',
        'vertical_preview_area',
        'horizontal_preview_area',
        'toggle_maximize_tophalf_timer',
        'enable_hold_maximize_inverse_landscape',
        'enable_hold_maximize_inverse_portrait',
        'restore_window_size_on',
        'debugging_show_tiled_rects',
        'debugging_free_rects'
    ]
}, class TilingAssistantPrefs extends Gtk.Stack {
    _init(params) {
        super._init(params);

        // Use a new settings object instead of the 'global' src.common.Settings
        // class, so we don't have to keep track of the signal connections, which
        // would need cleanup after the prefs window was closed.
        this._settings = ExtensionUtils.getSettings(Me.metadata['settings-schema']);
        this.connect('destroy', () => this._settings.run_dispose());

        // Bind settings to GUI
        this._bindSwitches();
        this._bindSpinbuttons();
        this._bindComboBoxes();
        this._bindRadioButtons();
        this._bindKeybindings();

        // LayoutPrefs manages everything related to layouts on the
        // prefs side (including the keyboard shortcuts)
        this._layoutsPrefs = new LayoutPrefs(this);

        // Setup titlebar and size
        this.connect('realize', () => {
            const prefsDialog = this.get_root();
            prefsDialog.set_titlebar(this._title_bar);
            prefsDialog.add_css_class('tiling-assistant');
            prefsDialog.set_default_size(575, 750);

            // Info-popup-menu actions
            const actionGroup = new Gio.SimpleActionGroup();
            prefsDialog.insert_action_group('prefs', actionGroup);

            const bugReportAction = new Gio.SimpleAction({ name: 'open-bug-report' });
            bugReportAction.connect('activate', this._openBugReport.bind(this, prefsDialog));
            actionGroup.add_action(bugReportAction);

            const userGuideAction = new Gio.SimpleAction({ name: 'open-user-guide' });
            userGuideAction.connect('activate', this._openUserGuide.bind(this, prefsDialog));
            actionGroup.add_action(userGuideAction);

            const changelogAction = new Gio.SimpleAction({ name: 'open-changelog' });
            changelogAction.connect('activate', this._openChangelog.bind(this, prefsDialog));
            actionGroup.add_action(changelogAction);

            const licenseAction = new Gio.SimpleAction({ name: 'open-license' });
            licenseAction.connect('activate', this._openLicense.bind(this, prefsDialog));
            actionGroup.add_action(licenseAction);

            const hiddenSettingsAction = new Gio.SimpleAction({ name: 'open-hidden-settings' });
            hiddenSettingsAction.connect('activate', this._openHiddenSettings.bind(this));
            actionGroup.add_action(hiddenSettingsAction);

            // Show Changelog after an update.
            const lastVersion = this._settings.get_int(Settings.CHANGELOG_VERSION);
            const firstInstall = lastVersion === -1;
            const noUpdate = lastVersion >= Me.metadata.version;

            this._settings.set_int(Settings.CHANGELOG_VERSION, Me.metadata.version);

            if (firstInstall || noUpdate)
                return;

            if (!this._settings.get_boolean(Settings.SHOW_CHANGE_ON_UPDATE))
                return;

            // TODO: solve this. Modal property doesn't seem to work
            // properly, if we immediately open the changelog...
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._openChangelog(prefsDialog);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /**
     * @param {Gtk.ListBox} listBox
     * @param {ListRow} row
     */
    _onListRowActivated(listBox, row) {
        row.activate();
    }

    _openBugReport(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/issues',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openUserGuide(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/blob/main/GUIDE.md',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openChangelog(prefsDialog) {
        const path = GLib.build_filenamev([Me.path, 'src/changelog.json']);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return;

        const [success, contents] = file.load_contents(null);
        if (!success || !contents.length)
            return;

        const changes = JSON.parse(ByteArray.toString(contents));
        const changelogDialog = new Changelog({
            transient_for: prefsDialog,
            css_classes: prefsDialog.get_css_classes()
        }, changes);
        changelogDialog.present();
    }

    _openLicense(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/blob/main/LICENSE',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openHiddenSettings() {
        const hiddenSettings = this._hidden_settings_page;
        hiddenSettings.set_visible(!hiddenSettings.get_visible());
    }

    _bindSwitches() {
        const switches = [
            Settings.ENABLE_TILING_POPUP,
            Settings.POPUP_ALL_WORKSPACES,
            Settings.RAISE_TILE_GROUPS,
            Settings.MAXIMIZE_WITH_GAPS,
            Settings.ENABLE_ADV_EXP_SETTINGS,
            Settings.SHOW_CHANGE_ON_UPDATE,
            Settings.ENABLE_TILE_ANIMATIONS,
            Settings.ENABLE_UNTILE_ANIMATIONS,
            Settings.ENABLE_HOLD_INVERSE_LANDSCAPE,
            Settings.ENABLE_HOLD_INVERSE_PORTRAIT
        ];

        switches.forEach(key => {
            const widget = this[`_${key.replaceAll('-', '_')}`];
            this._settings.bind(key, widget, 'active', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    _bindSpinbuttons() {
        const spinButtons = [
            Settings.WINDOW_GAP,
            Settings.SCREEN_GAP,
            Settings.INVERSE_TOP_MAXIMIZE_TIMER,
            Settings.VERTICAL_PREVIEW_AREA,
            Settings.HORIZONTAL_PREVIEW_AREA
        ];

        spinButtons.forEach(key => {
            const widget = this[`_${key.replaceAll('-', '_')}`];
            this._settings.bind(key, widget, 'value', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    _bindComboBoxes() {
        const comboBoxes = [
            Settings.SPLIT_TILE_MOD,
            Settings.FAVORITE_LAYOUT_MOD,
            Settings.RESTORE_SIZE_ON
        ];

        comboBoxes.forEach(key => {
            const widget = this[`_${key.replaceAll('-', '_')}`];
            widget.connect('changed', () =>
                this._settings.set_enum(key, widget.get_active()));

            widget.set_active(this._settings.get_enum(key));
        });
    }

    _bindRadioButtons() {
        // These 'radioButtons' are basically just used as a ComboBox with info
        // text. The key is a gsetting (a string) saving the current 'selection'.
        // The listRows' titles will be used for the options.
        const radioButtons = [
            {
                key: Settings.DYNAMIC_KEYBINDINGS,
                rowNames: [
                    'dynamic_keybinding_disabled_row',
                    'dynamic_keybinding_window_focus_row',
                    'dynamic_keybinding_tiling_state_row',
                    'dynamic_keybinding_tiling_state_windows_row',
                    'dynamic_keybinding_favorite_layout_row'
                ]
            },
            {
                key: Settings.DEFAULT_MOVE_MODE,
                rowNames: [
                    'edge_tiling_row',
                    'split_tiles_row',
                    'favorite_layout_row'
                ]
            }
        ];

        radioButtons.forEach(({ key, rowNames }) => {
            const currActive = this._settings.get_string(key);

            rowNames.forEach(name => {
                const row = this[`_${name}`];
                const checkButton = row.prefix;
                const title = row.title;
                checkButton.connect('toggled', () => {
                    this._settings.set_string(key, title);
                });

                // Set initial state
                if (title === currActive)
                    checkButton.activate();
            });
        });
    }

    _bindKeybindings() {
        const shortcuts = Shortcuts.getAllKeys();
        shortcuts.forEach(key => {
            const shortcut = this[`_${key.replaceAll('-', '_')}`];
            shortcut.initialize(key, this._settings);
        });
    }
});
