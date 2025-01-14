'use strict';

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Layout, Settings } = Me.imports.src.common;
const Rect = Me.imports.src.extension.geometry.Rect;
const Util = Me.imports.src.extension.utility.Util;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

/**
 * Here are the classes to handle PopupLayouts on the shell / extension side.
 * See src/prefs/layoutsPrefs.js for more details and general info about layouts.
 * In summary, a Layout is an array of LayoutItems. A LayoutItem is a JS Object
 * and has a rect, an appId and a loopType. Only the rect is mandatory. AppId may
 * be null or a String. Same for the LoopType. If a layout is activated, we will
 * loop / step through each LayoutItem and spawn a Tiling Popup one after the
 * other for the rects and offer to tile a window to that rect. If an appId is
 * defined, instead of calling the Tiling Popup, we tile (a new Instance of)
 * the app to the rect. If a LoopType is defined, instead of going to the next
 * item / rect, we spawn a Tiling Popup on the same item / rect and all the
 * tiled windows will share that spot evenly (a la 'Master and Stack').
 *
 * Additionally, there the user can select a 'favorite' layout among the
 * PopupLayouts. That layout will then be used as an fixed alternative mode to
 * the Edge Tiling. This class only handles setting the favorite layout with a
 * keyboard shortcut.
 */

var LayoutManager = class TilingLayoutsManager {
    constructor() {
        // this._items is an array of LayoutItems (see explanation above).
        // this._currItem is 1 LayoutItem. A LayoutItem's rect only hold ratios
        // from 0 - 1. this._currRect is a Rect scaled to the workArea.
        this._items = [];
        this._currItem = null;
        this._currRect = null;

        // Preview to show where the window will tile to, similiar
        // to the tile preview when dnding to the screen edges
        this._rectPreview = null;

        // Keep track of the windows which were already tiled with the current
        // layout and the remaining windows. Special-case windows, which were tiled
        // within a loop since they need to be re-adjusted for each new window
        // tiled to the same spot. The looped array is cleared after each 'step' /
        // LayoutItem change.
        this._tiledWithLayout = [];
        this._tiledWithLoop = [];
        this._remainingWindows = [];

        // Bind the keyboard shortcuts for each layout and the layout searchers
        this._keyBindings = [];
        this._bindKeybindings();
    }

    destroy() {
        this._finish();
        this._keyBindings.forEach(key => Main.wm.removeKeybinding(key));
    }

    /**
     * Opens a popup window so the user can activate a layout by name
     * instead of the keyboard shortcut.
     */
    openPopupSearch() {
        const layouts = Util.getLayouts();
        if (!layouts.length) {
            Main.notify('Tiling Assistant', _('No valid popup layouts defined.'));
            return;
        }

        const search = new LayoutSearch(layouts);
        search.connect('item-activated', (s, index) => this.startLayouting(index));
    }

    /**
     * Opens a popup so the user can choose a new favorite layout to use for
     * the 'Favorite Layout'.
     */
    openFavoriteSearch() {
        const layouts = Util.getLayouts();
        if (!layouts.length) {
            Main.notify('Tiling Assistant', _('No valid popup layouts defined.'));
            return;
        }

        const search = new LayoutSearch(layouts);
        search.connect('item-activated', (s, index) => {
            Settings.setInt(Settings.FAVORITE_LAYOUT, index);
        });
    }

    /**
     * Starts tiling to a Popup Layout.
     *
     * @param {number} index the index of the layout we start tiling to.
     */
    startLayouting(index) {
        const layout = Util.getLayouts()?.[index];
        if (!layout)
            return;

        const allWs = Settings.getBoolean(Settings.POPUP_ALL_WORKSPACES);
        this._remainingWindows = Util.getWindows(allWs);
        this._items = new Layout(layout).getItems();
        this._currItem = null;

        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitor);
        this._rectPreview?.destroy();
        this._rectPreview = new St.Widget({
            style_class: 'tile-preview',
            opacity: 0,
            x: workArea.x + workArea.width / 2,
            y: workArea.y + workArea.height / 2
        });
        Main.layoutManager.addChrome(this._rectPreview);

        this._step();
    }

    _finish() {
        this._items = [];
        this._currItem = null;
        this._currRect = null;

        this._rectPreview?.destroy();
        this._rectPreview = null;

        this._tiledWithLayout = [];
        this._tiledWithLoop = [];
        this._remainingWindows = [];
    }

    _step(loopType = null) {
        // If we aren't looping on the current item, we need to prepare for the
        // step by getting the next item / rect. If we are looping, we stay on
        // the current item / rect and open a new Tiling Popup for that rect.
        if (!loopType) {
            // We're at the last item and not looping, so there are no more items.
            if (this._currItem === this._items[this._items.length - 1]) {
                this._finish();
                return;
            }

            const currIdx = this._items.indexOf(this._currItem);
            this._currItem = this._items[currIdx + 1];

            // Scale the item's rect to the workArea
            const activeWs = global.workspace_manager.get_active_workspace();
            const monitor = global.display.get_current_monitor();
            const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
            const rectRatios = this._currItem.rect;
            this._currRect = new Rect(
                workArea.x + Math.floor(rectRatios.x * workArea.width),
                workArea.y + Math.floor(rectRatios.y * workArea.height),
                Math.ceil(rectRatios.width * workArea.width),
                Math.ceil(rectRatios.height * workArea.height)
            );

            // Try to compensate possible rounding errors when scaling up the
            // rect by aligning it with the rects, which were already tiled
            // using this layout and the workArea.
            this._tiledWithLayout.forEach(w => this._currRect.tryAlignWith(w.tiledRect));
            this._currRect.tryAlignWith(workArea);
        }

        const appId = this._currItem.appId;
        appId ? this._openAppTiled(appId) : this._openTilingPopup();
    }

    _openAppTiled(appId) {
        const app = Shell.AppSystem.get_default().lookup_app(appId);
        if (!app) {
            Main.notify('Tiling Assistant', _('Popup Layouts: App not found.'));
            this._finish();
            return;
        }

        if (app.can_open_new_window()) {
            Util.openAppTiled(app, this._currRect);
        } else {
            // Should we search for an open instance of the app and tile that?
            // Would we move it across workspaces and monitors?
        }

        this._step();
    }

    _openTilingPopup() {
        // There are no open windows left to tile using the Tiling Popup.
        // However there may be items with appIds, which we want to open.
        // So continue...
        if (!this._remainingWindows.length) {
            this._step();
            return;
        }

        // Animate the rect preview
        this._rectPreview.ease({
            x: this._currRect.x,
            y: this._currRect.y,
            width: this._currRect.width,
            height: this._currRect.height,
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        // Create the Tiling Popup
        const TilingPopup = Me.imports.src.extension.tilingPopup;
        const popup = new TilingPopup.TilingSwitcherPopup(
            this._remainingWindows,
            this._currRect,
            // If this._currItem is the last item and we don't loop over it,
            // allow the Tiling Popup itself to spawn another instance of
            // a Tiling Popup, if there is free screen space.
            this._currItem === this._items[this._items.length - 1] && !this._currItem.loopType
        );
        const stacked = global.display.sort_windows_by_stacking(this._tiledWithLayout);
        const tileGroup = stacked.reverse();
        if (!popup.show(tileGroup)) {
            popup.destroy();
            this._finish();
            return;
        }

        popup.connect('closed', this._onTilingPopupClosed.bind(this));
    }

    _onTilingPopupClosed(tilingPopup, canceled) {
        if (canceled) {
            if (this._currItem.loopType) {
                this._tiledWithLoop = [];
                this._step();
            } else {
                this._finish();
            }
        } else {
            const tiledWindow = tilingPopup.tiledWindow;
            this._tiledWithLayout.push(tiledWindow);
            const i = this._remainingWindows.indexOf(tiledWindow);
            this._remainingWindows.splice(i, 1);

            // Make all windows, which were tiled during the current loop,
            // share the current rect evenly -> like the 'Stack' part of a
            // 'Master and Stack'
            if (this._currItem.loopType) {
                this._tiledWithLoop.push(tiledWindow);
                this._tiledWithLoop.forEach((w, idx) => {
                    const rect = this._currRect.copy();
                    const [pos, dimension] = this._currItem.loopType === 'h'
                        ? ['y', 'height']
                        : ['x', 'width'];
                    rect[dimension] /= this._tiledWithLoop.length;
                    rect[pos] += idx * rect[dimension];
                    Util.tile(w, rect, { openTilingPopup: false, skipAnim: true });
                });
            }

            this._step(this._currItem.loopType);
        }
    }

    _bindKeybindings() {
        for (let i = 0; i < 20; i++) {
            this._keyBindings.push(`activate-layout${i}`);
            Main.wm.addKeybinding(
                `activate-layout${i}`,
                Settings.getGioObject(),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                this.startLayouting.bind(this, i)
            );
        }

        this._keyBindings.push('search-popup-layout');
        Main.wm.addKeybinding(
            'search-popup-layout',
            Settings.getGioObject(),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            this.openPopupSearch.bind(this)
        );

        this._keyBindings.push('change-favorite-layout');
        Main.wm.addKeybinding(
            'change-favorite-layout',
            Settings.getGioObject(),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            this.openFavoriteSearch.bind(this)
        );
    }
};

/**
 * The GUI class for the Layout search.
 */
const LayoutSearch = GObject.registerClass({
    Signals: { 'item-activated': { param_types: [GObject.TYPE_INT] } }
}, class TilingLayoutsSearch extends St.BoxLayout {
    _init(layouts) {
        super._init({
            width: 500,
            vertical: true,
            style_class: 'osd-window'
        });
        Main.uiGroup.add_child(this);

        if (!Main.pushModal(this)) {
            // Probably someone else has a pointer grab, try again with keyboard
            const alreadyGrabbed = Meta.ModalOptions.POINTER_ALREADY_GRABBED;
            if (!Main.pushModal(this, { options: alreadyGrabbed })) {
                this.destroy();
                return;
            }
        }

        this._haveModal = true;
        this._focused = -1;
        this._items = [];

        const fontSize = 18;
        const entry = new St.Entry({
            style: `font-size: ${fontSize}px;\
                    border-radius: 16px;`,
            // The cursor overlaps the text, so add some spaces at the beginning
            hint_text: ` ${_('Type to search...')}`
        });
        const entryClutterText = entry.get_clutter_text();
        entryClutterText.connect('key-press-event', this._onKeyPressed.bind(this));
        entryClutterText.connect('text-changed', this._onTextChanged.bind(this));
        this.add_child(entry);

        this._items = layouts.map(layout => {
            const item = new SearchItem(layout._name, fontSize);
            item.connect('button-press-event', this._onItemClicked.bind(this));
            this.add_child(item);
            return item;
        });

        if (!this._items.length) {
            this.destroy();
            return;
        }

        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitor);
        this.set_position(workArea.x + workArea.width / 2 - this.width / 2,
            workArea.y + workArea.height / 2 - this.height / 2);

        entry.grab_key_focus();
        this._focus(0);
    }

    destroy() {
        if (this._haveModal) {
            Main.popModal(this);
            this._haveModal = false;
        }

        super.destroy();
    }

    _onKeyPressed(clutterText, event) {
        const keySym = event.get_key_symbol();
        if (keySym === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Return ||
                keySym === Clutter.KEY_KP_Enter ||
                keySym === Clutter.KEY_ISO_Enter) {
            this._activate();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Down) {
            this._focusNext();
            return Clutter.EVENT_STOP;
        } else if (keySym === Clutter.KEY_Up) {
            this._focusPrev();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onTextChanged(clutterText) {
        const filterText = clutterText.get_text();
        this._items.forEach(item => {
            item.text.toLowerCase().includes(filterText.toLowerCase())
                ? item.show()
                : item.hide();
        });
        const nextVisibleIdx = this._items.findIndex(item => item.visible);
        this._focus(nextVisibleIdx);
    }

    _onItemClicked(item) {
        this._focused = this._items.indexOf(item);
        this._activate();
    }

    _focusPrev() {
        this._focus((this._focused + this._items.length - 1) % this._items.length);
    }

    _focusNext() {
        this._focus((this._focused + 1) % this._items.length);
    }

    _focus(newIdx) {
        const prevItem = this._items[this._focused];
        const newItem = this._items[newIdx];
        this._focused = newIdx;

        prevItem?.remove_style_class_name('tiling-layout-search-highlight');
        newItem?.add_style_class_name('tiling-layout-search-highlight');
    }

    _activate() {
        this._focused !== -1 && this.emit('item-activated', this._focused);
        this.destroy();
    }
});

/**
 * An Item representing a Layout within the Popup Layout search.
 */
const SearchItem = GObject.registerClass(class TilingLayoutsSearchItem extends St.Label {
    _init(text, fontSize) {
        super._init({
            // Add some spaces to the beginning to align it better
            // with the rounded corners
            text: `   ${text || _('Nameless layout...')}`,
            style: `font-size: ${fontSize}px;\
                text-align: left;\
                padding: 8px\
                margin-bottom: 2px`,
            reactive: true
        });
    }
});
