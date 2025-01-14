/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

'use strict';

const { Gio, GLib, Meta } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Rect = Me.imports.src.extension.geometry.Rect;

let Settings;
let Util;

/**
 * 2 entry points:
 * 1. keyboard shortcuts:
 *  => keybindingHandler.js
 * 2. Grabbing a window:
 *  => moveHandler.js (when moving a window)
 *  => resizeHandler.js (when resizing a window)
 */

function init() {
    ExtensionUtils.initTranslations(Me.metadata.uuid);
}

function enable() {
    Settings = Me.imports.src.common.Settings;
    Settings.initialize();

    Util = Me.imports.src.extension.utility.Util;
    Util.initialize();

    const MoveHandler = Me.imports.src.extension.moveHandler;
    this._moveHandler = new MoveHandler.Handler();
    const ResizeHandler = Me.imports.src.extension.resizeHandler;
    this._resizeHandler = new ResizeHandler.Handler();
    const KeybindingHandler = Me.imports.src.extension.keybindingHandler;
    this._keybindingHandler = new KeybindingHandler.Handler();
    const LayoutsManager = Me.imports.src.extension.layoutsManager;
    this._layoutsManager = new LayoutsManager.LayoutManager();

    // Disable native tiling.
    this._gnomeMutterSettings = ExtensionUtils.getSettings('org.gnome.mutter');
    this._gnomeMutterSettings.set_boolean('edge-tiling', false);
    this._gnomeShellSettings = ExtensionUtils.getSettings('org.gnome.shell.overrides');
    this._gnomeShellSettings.set_boolean('edge-tiling', false);

    // Include tiled windows when dragging from the top panel.
    this._getDraggableWindowForPosition = Main.panel._getDraggableWindowForPosition;
    Main.panel._getDraggableWindowForPosition = function (stageX) {
        const workspaceManager = global.workspace_manager;
        const windows = workspaceManager.get_active_workspace().list_windows();
        const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

        return allWindowsByStacking.find(w => {
            const rect = w.get_frame_rect();
            const workArea = w.get_work_area_current_monitor();
            return w.is_on_primary_monitor() &&
                    w.showing_on_its_workspace() &&
                    w.get_window_type() !== Meta.WindowType.DESKTOP &&
                    (w.maximized_vertically || w.tiledRect?.y === workArea.y) &&
                    stageX > rect.x && stageX < rect.x + rect.width;
        });
    };

    // Restore tiled window properties after session was unlocked.
    _loadAfterSessionLock();

    // TODO: remove: new setting compatibility code
    const windowGap = Settings.getInt(Settings.WINDOW_GAP);
    const screenGap = Settings.getInt(Settings.SCREEN_GAP);
    screenGap === -1 && Settings.setInt(Settings.SCREEN_GAP, windowGap);
}

function disable() {
    // Save tiled window properties, if the session was locked to restore
    // them after the session is unlocked again.
    _saveBeforeSessionLock();

    this._moveHandler.destroy();
    this._moveHandler = null;
    this._resizeHandler.destroy();
    this._resizeHandler = null;
    this._keybindingHandler.destroy();
    this._keybindingHandler = null;
    this._layoutsManager.destroy();
    this._layoutsManager = null;

    Util.destroy();
    Util = null;
    Settings.destroy();
    Settings = null;

    // Re-enable native tiling.
    this._gnomeMutterSettings.reset('edge-tiling');
    this._gnomeShellSettings.reset('edge-tiling');

    // Restore old functions.
    Main.panel._getDraggableWindowForPosition = this._getDraggableWindowForPosition;
    this._getDraggableWindowForPosition = null;

    // Relete custom tiling properties.
    const openWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
    openWindows.forEach(w => {
        delete w.isTiled;
        delete w.tiledRect;
        delete w.untiledRect;
    });
}

/**
 * Extensions are disabled when the screen is locked. So save the custom tiling
 * properties of windows before locking the screen.
 */
function _saveBeforeSessionLock() {
    if (!Main.sessionMode.isLocked)
        return;

    this._wasLocked = true;

    const rectToJsObj = rect => rect && {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    };

    // can't just check for isTiled because maximized windows may
    // have an untiledRect as well in case window gaps are used
    const openWindows = Util.getWindows(false);
    const savedWindows = openWindows.filter(w => w.untiledRect).map(w => {
        return {
            windowId: w.get_stable_sequence(),
            isTiled: w.isTiled,
            tiledRect: rectToJsObj(w.tiledRect),
            untiledRect: rectToJsObj(w.untiledRect)
        };
    });

    const saveObj = {
        'windows': savedWindows,
        'tileGroups': Array.from(Util.getTileGroups())
    };

    const userPath = GLib.get_user_config_dir();
    const parentPath = GLib.build_filenamev([userPath, '/tiling-assistant']);
    const parent = Gio.File.new_for_path(parentPath);
    try { parent.make_directory_with_parents(null); } catch (e) {}
    const path = GLib.build_filenamev([parentPath, '/tiledSessionRestore.json']);
    const file = Gio.File.new_for_path(path);
    try { file.create(Gio.FileCreateFlags.NONE, null); } catch (e) {}
    file.replace_contents(JSON.stringify(saveObj), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/**
 * Extensions are disabled when the screen is locked. After having saved them,
 * reload them here.
 */
function _loadAfterSessionLock() {
    if (!this._wasLocked)
        return;

    this._wasLocked = false;

    const userPath = GLib.get_user_config_dir();
    const path = GLib.build_filenamev([userPath, '/tiling-assistant/tiledSessionRestore.json']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;

    try { file.create(Gio.FileCreateFlags.NONE, null); } catch (e) {}
    const [success, contents] = file.load_contents(null);
    if (!success || !contents.length)
        return;

    const openWindows = Util.getWindows(false);
    const saveObj = JSON.parse(ByteArray.toString(contents));

    const windowObjects = saveObj['windows'];
    windowObjects.forEach(wObj => {
        const { windowId, isTiled, tiledRect, untiledRect } = wObj;
        const window = openWindows.find(w => w.get_stable_sequence() === windowId);
        if (!window)
            return;

        const jsToRect = jsRect => jsRect && new Rect(
            jsRect.x, jsRect.y, jsRect.width, jsRect.height
        );

        window.isTiled = isTiled;
        window.tiledRect = jsToRect(tiledRect);
        window.untiledRect = jsToRect(untiledRect);
    });

    const tileGroups = new Map(saveObj['tileGroups']);
    Util.setTileGroups(tileGroups);
    openWindows.forEach(w => {
        if (tileGroups.has(w.get_id())) {
            const group = Util.getTileGroupFor(w);
            Util.updateTileGroup(group);
        }
    });
}
