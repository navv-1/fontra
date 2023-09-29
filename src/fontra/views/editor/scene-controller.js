import { recordChanges } from "../core/change-recorder.js";
import {
  ChangeCollector,
  applyChange,
  consolidateChanges,
  hasChange,
} from "../core/changes.js";
import { decomposeComponents } from "../core/glyph-controller.js";
import { glyphLinesFromText, textFromGlyphLines } from "../core/glyph-lines.js";
import { MouseTracker } from "../core/mouse-tracker.js";
import { ObservableController } from "../core/observable-object.js";
import { connectContours, splitPathAtPointIndices } from "../core/path-functions.js";
import { equalRect, offsetRect, rectAddMargin, rectRound } from "../core/rectangle.js";
import { isSuperset, lenientIsEqualSet, union } from "../core/set-ops.js";
import {
  arrowKeyDeltas,
  commandKeyProperty,
  enumerate,
  objectsEqual,
  parseSelection,
  reversed,
  withTimeout,
  zip,
} from "../core/utils.js";
import { packContour } from "../core/var-path.js";
import { EditBehaviorFactory } from "./edit-behavior.js";
import { SceneModel, getSelectedGlyphName } from "./scene-model.js";
import { dialog } from "/web-components/modal-dialog.js";

export class SceneController {
  constructor(fontController, canvasController, experimentalFeaturesController) {
    this.canvasController = canvasController;
    this.experimentalFeatures = experimentalFeaturesController.model;
    this.fontController = fontController;
    this.autoViewBox = true;

    this.setupSceneSettings();
    this.sceneSettings = this.sceneSettingsController.model;

    // We need to do isPointInPath without having a context, we'll pass a bound method
    const isPointInPath = canvasController.context.isPointInPath.bind(
      canvasController.context
    );

    this.sceneModel = new SceneModel(
      fontController,
      this.sceneSettingsController,
      isPointInPath
    );

    this.selectedTool = undefined;
    this._currentGlyphChangeListeners = [];

    this.setupSettingsListeners();
    this.setupEventHandling();
  }

  setupSceneSettings() {
    this.sceneSettingsController = new ObservableController({
      text: "",
      align: "center",
      glyphLines: [],
      location: {},
      selectedGlyph: null,
      selectedGlyphName: null,
      selectedSourceIndex: null,
      selectedLayerName: null,
      selection: new Set(),
      hoverSelection: new Set(),
      combinedSelection: new Set(), // dynamic: selection | hoverSelection
      viewBox: this.canvasController.getViewBox(),
      positionedLines: [],
    });
    this.sceneSettings = this.sceneSettingsController.model;

    // Set up the mutual relationship between text and glyphLines
    this.sceneSettingsController.addKeyListener("text", async (event) => {
      if (event.senderInfo?.senderID === this) {
        return;
      }
      await this.fontController.ensureInitialized;
      const glyphLines = await glyphLinesFromText(
        event.newValue,
        this.fontController.characterMap,
        this.fontController.glyphMap
      );
      this.sceneSettingsController.setItem("glyphLines", glyphLines, {
        senderID: this,
      });
    });

    this.sceneSettingsController.addKeyListener(
      "glyphLines",
      (event) => {
        if (event.senderInfo?.senderID === this) {
          return;
        }
        const text = textFromGlyphLines(event.newValue);
        this.sceneSettingsController.setItem("text", text, { senderID: this });
      },
      true
    );

    // auto view box
    this.sceneSettingsController.addKeyListener("selectedGlyph", (event) => {
      if (event.newValue?.isEditing) {
        this.autoViewBox = false;
      }
      this.canvasController.requestUpdate();
    });

    this.sceneSettingsController.addKeyListener(
      "positionedLines",
      (event) => {
        this.setAutoViewBox();
        this.canvasController.requestUpdate();
      },
      true
    );

    // Set up the mutual dependencies between location and selectedSourceIndex
    this.sceneSettingsController.addKeyListener("location", async (event) => {
      if (event.senderInfo?.senderID === this) {
        return;
      }
      const varGlyphController =
        await this.sceneModel.getSelectedVariableGlyphController();
      const sourceIndex = varGlyphController?.getSourceIndex(event.newValue);
      this.sceneSettingsController.setItem("selectedSourceIndex", sourceIndex, {
        senderID: this,
      });
    });

    this.sceneSettingsController.addKeyListener(
      "selectedSourceIndex",
      async (event) => {
        if (event.senderInfo?.senderID === this) {
          return;
        }
        const sourceIndex = event.newValue;
        if (sourceIndex == undefined) {
          return;
        }
        const varGlyphController =
          await this.sceneModel.getSelectedVariableGlyphController();
        const location = varGlyphController.mapSourceLocationToGlobal(sourceIndex);

        this.sceneSettingsController.setItem("location", location, { senderID: this });
      },
      true
    );

    // Set up convenience property "selectedGlyphName"
    this.sceneSettingsController.addKeyListener(
      ["selectedGlyph", "glyphLines"],
      (event) => {
        this.sceneSettings.selectedGlyphName = getSelectedGlyphName(
          this.sceneSettings.selectedGlyph,
          this.sceneSettings.glyphLines
        );
      },
      true
    );

    // Set up convenience property "combinedSelection", which is the union of
    // selection and hoverSelection
    this.sceneSettingsController.addKeyListener(
      ["selection", "hoverSelection"],
      (event) => {
        this.sceneSettings.combinedSelection = union(
          this.sceneSettings.selection,
          this.sceneSettings.hoverSelection
        );
      },
      true
    );

    // Set up the viewBox relationships
    this.sceneSettingsController.addKeyListener(
      "viewBox",
      (event) => {
        if (event.senderInfo?.senderID === this) {
          return;
        }
        this.canvasController.setViewBox(event.newValue);
        const actualViewBox = this.canvasController.getViewBox();
        if (!equalRect(rectRound(event.newValue), rectRound(actualViewBox))) {
          this.sceneSettingsController.setItem("viewBox", actualViewBox, {
            senderID: this,
            adjustViewBox: true,
          });
        }
      },
      true
    );

    this.canvasController.canvas.addEventListener("viewBoxChanged", (event) => {
      if (event.detail === "canvas-size") {
        this.setAutoViewBox();
      } else {
        this.autoViewBox = false;
      }
      this.sceneSettingsController.setItem(
        "viewBox",
        this.canvasController.getViewBox(),
        { senderID: this }
      );
    });
  }

  setupSettingsListeners() {
    this.sceneSettingsController.addKeyListener("selectedGlyph", (event) => {
      this._resetStoredGlyphPosition();
    });

    this.sceneSettingsController.addKeyListener(
      "align",
      (event) => {
        this.scrollAdjustBehavior = "text-align";
      },
      true
    );

    this.sceneSettingsController.addKeyListener("selectedGlyphName", (event) => {
      this._updateCurrentGlyphChangeListeners();
    });

    this.sceneSettingsController.addKeyListener(
      "positionedLines",
      (event) => {
        this._adjustScrollPosition();
      },
      true
    );
  }

  setupEventHandling() {
    this.mouseTracker = new MouseTracker({
      drag: async (eventStream, initialEvent) =>
        await this.handleDrag(eventStream, initialEvent),
      hover: (event) => this.handleHover(event),
      element: this.canvasController.canvas,
    });
    this._eventElement = document.createElement("div");

    this.fontController.addEditListener(
      async (...args) => await this.editListenerCallback(...args)
    );
    this.canvasController.canvas.addEventListener("keydown", (event) =>
      this.handleKeyDown(event)
    );
  }

  setAutoViewBox() {
    if (!this.autoViewBox) {
      return;
    }
    let bounds = this.getSceneBounds();
    if (!bounds) {
      return;
    }
    bounds = rectAddMargin(bounds, 0.1);
    this.sceneSettings.viewBox = bounds;
  }

  _resetStoredGlyphPosition() {
    this._previousGlyphPosition = positionedGlyphPosition(
      this.sceneModel.getSelectedPositionedGlyph()
    );
  }

  _adjustScrollPosition() {
    let originXDelta = 0;

    const glyphPosition = positionedGlyphPosition(
      this.sceneModel.getSelectedPositionedGlyph()
    );

    const [minX, maxX] = this.sceneModel.getTextHorizontalExtents();

    if (this.scrollAdjustBehavior === "text-align" && this._previousTextExtents) {
      const [minXPre, maxXPre] = this._previousTextExtents;
      originXDelta = minX - minXPre;
    } else if (
      this.scrollAdjustBehavior === "pin-glyph-center" &&
      this._previousGlyphPosition &&
      glyphPosition
    ) {
      const previousGlyphCenter =
        this._previousGlyphPosition.x + this._previousGlyphPosition.xAdvance / 2;
      const glyphCenter = glyphPosition.x + glyphPosition.xAdvance / 2;
      originXDelta = glyphCenter - previousGlyphCenter;
    }

    if (originXDelta) {
      this.sceneSettings.viewBox = offsetRect(
        this.sceneSettings.viewBox,
        originXDelta,
        0
      );
    }

    this.scrollAdjustBehavior = null;
    this._previousTextExtents = [minX, maxX];
    this._previousGlyphPosition = glyphPosition;
  }

  async editListenerCallback(editMethodName, senderID, ...args) {
    // console.log(editMethodName, senderID, ...args);
    switch (editMethodName) {
      case "editBegin":
        {
          const glyphController = this.sceneModel.getSelectedPositionedGlyph().glyph;
          this.sceneModel.ghostPath = glyphController.flattenedPath2d;
        }
        break;
      case "editEnd":
        delete this.sceneModel.ghostPath;
        break;
      case "editIncremental":
      case "editFinal":
        await this.sceneModel.updateScene();
        this.canvasController.requestUpdate();
        break;
    }
  }

  _updateCurrentGlyphChangeListeners() {
    const glyphName = this.sceneSettings.selectedGlyphName;
    if (glyphName === this._currentSelectedGlyphName) {
      return;
    }
    for (const listener of this._currentGlyphChangeListeners) {
      this.fontController.removeGlyphChangeListener(
        this._currentSelectedGlyphName,
        listener
      );
      this.fontController.addGlyphChangeListener(glyphName, listener);
    }
    this._currentSelectedGlyphName = glyphName;
  }

  addCurrentGlyphChangeListener(listener) {
    this._currentGlyphChangeListeners.push(listener);
    if (this._currentSelectedGlyphName) {
      this.fontController.addGlyphChangeListener(
        this._currentSelectedGlyphName,
        listener
      );
    }
  }

  removeCurrentGlyphChangeListener(listener) {
    if (this._currentSelectedGlyphName) {
      this.fontController.removeGlyphChangeListener(
        this._currentSelectedGlyphName,
        listener
      );
    }
    this._currentGlyphChangeListeners = this._currentGlyphChangeListeners.filter(
      (item) => item !== listener
    );
  }

  setSelectedTool(tool) {
    this.selectedTool?.deactivate();
    this.selectedTool = tool;
    this.hoverSelection = new Set();
    this.updateHoverState();
  }

  updateHoverState() {
    // Do this too soon and we'll risk stale hover info
    setTimeout(() => this.selectedTool.handleHover({}), 0);
  }

  handleKeyDown(event) {
    if ((!event[commandKeyProperty] || event.shiftKey) && event.key in arrowKeyDeltas) {
      this.handleArrowKeys(event);
      event.preventDefault();
      return;
    } else {
      this.selectedTool?.handleKeyDown(event);
    }
  }

  async handleArrowKeys(event) {
    if (!this.sceneSettings.selectedGlyph?.isEditing || !this.selection.size) {
      return;
    }
    let [dx, dy] = arrowKeyDeltas[event.key];
    if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
      dx *= 100;
      dy *= 100;
    } else if (event.shiftKey) {
      dx *= 10;
      dy *= 10;
    }
    const delta = { x: dx, y: dy };
    await this.editGlyph((sendIncrementalChange, glyph) => {
      const layerInfo = Object.entries(
        this.getEditingLayerFromGlyphLayers(glyph.layers)
      ).map(([layerName, layerGlyph]) => {
        const behaviorFactory = new EditBehaviorFactory(
          layerGlyph,
          this.selection,
          this.experimentalFeatures.scalingEditBehavior
        );
        return {
          layerName,
          layerGlyph,
          changePath: ["layers", layerName, "glyph"],
          pathPrefix: [],
          editBehavior: behaviorFactory.getBehavior(
            event.altKey ? "alternate" : "default"
          ),
        };
      });

      const editChanges = [];
      const rollbackChanges = [];
      layerInfo.forEach(({ layerGlyph, changePath, editBehavior }) => {
        const editChange = editBehavior.makeChangeForDelta(delta);
        applyChange(layerGlyph, editChange);
        editChanges.push(consolidateChanges(editChange, changePath));
        rollbackChanges.push(
          consolidateChanges(editBehavior.rollbackChange, changePath)
        );
      });

      let changes = ChangeCollector.fromChanges(
        consolidateChanges(editChanges),
        consolidateChanges(rollbackChanges)
      );

      const connectDetector = this.getPathConnectDetector();
      // if (connectDetector.shouldConnect()) {
      //   const connectChanges = recordChanges(instance, (instance) => {
      //     this.selection = connectContours(
      //       instance.path,
      //       connectDetector.connectSourcePointIndex,
      //       connectDetector.connectTargetPointIndex
      //     );
      //   });
      //   if (connectChanges.hasChange) {
      //     changes = changes.concat(connectChanges);
      //   }
      // }

      return {
        changes: changes,
        undoLabel: "nudge selection",
        broadcast: true,
      };
    });
  }

  addEventListener(eventName, handler, options) {
    this._eventElement.addEventListener(eventName, handler, options);
  }

  _dispatchEvent(eventName, detail) {
    const event = new CustomEvent(eventName, {
      bubbles: false,
      detail: detail || this,
    });
    this._eventElement.dispatchEvent(event);
  }

  updateContextMenuState(event) {
    this.contextMenuState = {};
    if (!this.sceneSettings.selectedGlyph?.isEditing) {
      return;
    }
    const { selection: clickedSelection } = this.sceneModel.selectionAtPoint(
      this.localPoint(event),
      this.mouseClickMargin
    );
    let relevantSelection;
    if (!clickedSelection.size) {
      // Clicked on nothing, ignore selection
      relevantSelection = clickedSelection;
    } else {
      if (!isSuperset(this.selection, clickedSelection)) {
        // Clicked on something that wasn't yet selected; select it
        this.selection = clickedSelection;
      } else {
        // Use the existing selection as context
      }
      relevantSelection = this.selection;
    }
    const { point: pointSelection, component: componentSelection } =
      parseSelection(relevantSelection);
    this.contextMenuState.pointSelection = pointSelection;
    this.contextMenuState.componentSelection = componentSelection;
  }

  getContextMenuItems(event) {
    const contextMenuItems = [
      {
        title: "Break Contour",
        enabled: () => this.contextMenuState.pointSelection?.length,
        callback: () => this.breakContour(),
      },
      {
        title: "Reverse Contour Direction",
        enabled: () => this.contextMenuState.pointSelection?.length,
        callback: () => this.reverseSelectedContoursDirection(),
      },
      {
        title: "Set Start Point",
        enabled: () => this.contextMenuState.pointSelection?.length,
        callback: () => this.setStartPoint(),
      },
      {
        title: () =>
          "Decompose Component" +
          (this.contextMenuState.componentSelection?.length === 1 ? "" : "s"),
        enabled: () => this.contextMenuState.componentSelection?.length,
        callback: () => this.decomposeSelectedComponents(),
      },
    ];
    return contextMenuItems;
  }

  getSelectedGlyphName() {
    return this.sceneModel.getSelectedGlyphName();
  }

  async handleDrag(eventStream, initialEvent) {
    if (this.selectedTool) {
      await this.selectedTool.handleDrag(eventStream, initialEvent);
    }
  }

  handleHover(event) {
    if (this.selectedTool) {
      this.selectedTool.handleHover(event);
    }
  }

  localPoint(event) {
    if (event.x !== undefined) {
      this._currentLocalPoint = this.canvasController.localPoint(event);
    }
    return this._currentLocalPoint || { x: 0, y: 0 };
  }

  selectedGlyphPoint(event) {
    // Return the event location in the selected-glyph coordinate system
    const canvasPoint = this.localPoint(event);
    const positionedGlyph = this.sceneModel.getSelectedPositionedGlyph();
    if (positionedGlyph === undefined) {
      return undefined;
    }
    return {
      x: canvasPoint.x - positionedGlyph.x,
      y: canvasPoint.y - positionedGlyph.y,
    };
  }

  get onePixelUnit() {
    return this.canvasController.onePixelUnit;
  }

  get mouseClickMargin() {
    return this.onePixelUnit * 12;
  }

  get selection() {
    return this.sceneModel.selection;
  }

  set selection(selection) {
    if (!lenientIsEqualSet(selection, this.selection)) {
      this.sceneModel.selection = selection || new Set();
      this.sceneModel.hoverSelection = new Set();
      this.canvasController.requestUpdate();
      // Delay the notification by a tiny amount, to work around
      // an ordering problem: sometimes the selection is set to
      // something that will be valid soon but isn't right now.
      setTimeout(() => this._dispatchEvent("selectionChanged"), 20);
    }
  }

  get hoverSelection() {
    return this.sceneModel.hoverSelection;
  }

  set hoverSelection(selection) {
    if (!lenientIsEqualSet(selection, this.hoverSelection)) {
      this.sceneModel.hoverSelection = selection;
      this.canvasController.requestUpdate();
    }
  }

  get hoveredGlyph() {
    return this.sceneModel.hoveredGlyph;
  }

  set hoveredGlyph(hoveredGlyph) {
    if (!equalGlyphSelection(this.sceneModel.hoveredGlyph, hoveredGlyph)) {
      this.sceneModel.hoveredGlyph = hoveredGlyph;
      this.canvasController.requestUpdate();
    }
  }

  get selectionRect() {
    return this.sceneModel.selectionRect;
  }

  set selectionRect(selRect) {
    this.sceneModel.selectionRect = selRect;
    this.canvasController.requestUpdate();
  }

  get backgroundLayers() {
    return this.sceneModel.backgroundLayers || [];
  }

  set backgroundLayers(layerNames) {
    this.sceneModel.backgroundLayers = layerNames;
    this.sceneModel.updateBackgroundGlyphs();
    this.canvasController.requestUpdate();
  }

  get editingLayers() {
    return this.sceneModel.editingLayers || [];
  }

  set editingLayers(layerNames) {
    this.sceneModel.editingLayers = layerNames;
    this.sceneModel.updateBackgroundGlyphs();
    this.canvasController.requestUpdate();
  }

  get editingLayerNames() {
    const primaryLayerName =
      this.sceneModel.getSelectedPositionedGlyph()?.glyph?.layerName;
    const layerNames = Object.keys(this.editingLayers);
    if (primaryLayerName) {
      // Ensure the primary editing layer name is first in the list
      const i = layerNames.indexOf(primaryLayerName);
      if (i > 0) {
        layerNames.splice(i, 1);
        layerNames.unshift(primaryLayerName);
      }
    }
    return layerNames;
  }

  getGlobalLocation() {
    return this.sceneModel.getGlobalLocation();
  }

  getLocalLocations(filterShownGlyphs = false) {
    return this.sceneModel.getLocalLocations(filterShownGlyphs);
  }

  updateLocalLocations(localLocations) {
    this.sceneModel.updateLocalLocations(localLocations);
  }

  getSceneBounds() {
    return this.sceneModel.getSceneBounds();
  }

  cancelEditing(reason) {
    if (this._glyphEditingDonePromise) {
      this._cancelGlyphEditing = reason;
    }
    return this._glyphEditingDonePromise;
  }

  async editGlyphAndRecordChanges(editFunc, senderID) {
    return await this._editGlyphOrInstanceAndRecordChanges(editFunc, senderID, false);
  }

  async editInstanceAndRecordChanges(editFunc, senderID) {
    return await this._editGlyphOrInstanceAndRecordChanges(editFunc, senderID, true);
  }

  async editLayersAndRecordChanges(editFunc, senderID) {
    return await this.editGlyphAndRecordChanges((glyph) => {
      const layerGlyphs = this.getEditingLayerFromGlyphLayers(glyph.layers);
      return editFunc(layerGlyphs);
    }, senderID);
  }

  getEditingLayerFromGlyphLayers(layers) {
    return Object.fromEntries(
      this.editingLayerNames
        .map((layerName) => [layerName, layers[layerName]?.glyph])
        .filter((layer) => layer[1])
    );
  }

  async _editGlyphOrInstanceAndRecordChanges(editFunc, senderID, doInstance) {
    await this._editGlyphOrInstance(
      (sendIncrementalChange, subject) => {
        let undoLabel;
        const changes = recordChanges(subject, (subject) => {
          undoLabel = editFunc(subject);
        });
        return {
          changes: changes,
          undoLabel: undoLabel,
          broadcast: true,
        };
      },
      senderID,
      doInstance
    );
  }

  async editGlyph(editFunc, senderID) {
    return await this._editGlyphOrInstance(editFunc, senderID, false);
  }

  async editInstance(editFunc, senderID) {
    return await this._editGlyphOrInstance(editFunc, senderID, true);
  }

  async _editGlyphOrInstance(editFunc, senderID, doInstance) {
    if (this._glyphEditingDonePromise) {
      try {
        // A previous call to _editGlyphOrInstance is still ongoing.
        // Let's wait a bit, but not forever.
        await withTimeout(this._glyphEditingDonePromise, 5000);
      } catch (error) {
        throw new Error("can't call _editGlyphOrInstance() while it's still running");
      }
    }
    let editingDone;
    this._glyphEditingDonePromise = new Promise((resolve) => {
      editingDone = resolve;
    });
    try {
      return await this._editGlyphOrInstanceUnchecked(editFunc, senderID, doInstance);
    } finally {
      // // Simulate slow response
      // console.log("...delay");
      // await new Promise((resolve) => setTimeout(resolve, 1000));
      // console.log("...done");
      editingDone();
      delete this._glyphEditingDonePromise;
      delete this._cancelGlyphEditing;
    }
  }

  async _editGlyphOrInstanceUnchecked(editFunc, senderID, doInstance) {
    const glyphName = this.sceneModel.getSelectedGlyphName();
    const varGlyph = await this.fontController.getGlyph(glyphName);
    const baseChangePath = ["glyphs", glyphName];

    let editSubject;
    if (doInstance) {
      const glyphController = this.sceneModel.getSelectedPositionedGlyph().glyph;
      if (!glyphController.canEdit) {
        this._dispatchEvent("glyphEditLocationNotAtSource");
        return;
      }

      editSubject = glyphController.instance;
      baseChangePath.push("layers", glyphController.layerName, "glyph");
    } else {
      editSubject = varGlyph.glyph;
    }

    const editContext = await this.fontController.getGlyphEditContext(
      glyphName,
      baseChangePath,
      senderID || this
    );
    const sendIncrementalChange = async (change, mayDrop = false) => {
      if (change && hasChange(change)) {
        await editContext.editIncremental(change, mayDrop);
      }
    };
    const initialSelection = this.selection;
    // editContext.editBegin();
    let result;
    try {
      result = await editFunc(sendIncrementalChange, editSubject);
    } catch (error) {
      this.selection = initialSelection;
      editContext.editCancel();
      throw error;
    }

    const {
      changes: changes,
      undoLabel: undoLabel,
      broadcast: broadcast,
    } = result || {};

    if (changes && changes.hasChange) {
      const undoInfo = {
        label: undoLabel,
        undoSelection: initialSelection,
        redoSelection: this.selection,
        location: this.sceneSettings.location,
      };
      if (!this._cancelGlyphEditing) {
        editContext.editFinal(
          changes.change,
          changes.rollbackChange,
          undoInfo,
          broadcast
        );
      } else {
        applyChange(editSubject, changes.rollbackChange);
        await editContext.editIncremental(changes.rollbackChange, false);
        editContext.editCancel();
        dialog(
          "The glyph could not be saved.",
          `The edit has been reverted.\n\n${this._cancelGlyphEditing}`,
          [{ title: "Okay", resultValue: "ok" }]
        );
      }
    } else {
      this.selection = initialSelection;
      editContext.editCancel();
    }
  }

  getSelectionBox() {
    return this.sceneModel.getSelectionBox();
  }

  getUndoRedoInfo(isRedo) {
    const glyphName = this.getSelectedGlyphName();
    if (glyphName === undefined) {
      return;
    }
    return this.fontController.getUndoRedoInfo(glyphName, isRedo);
  }

  async doUndoRedo(isRedo) {
    const glyphName = this.getSelectedGlyphName();
    if (glyphName === undefined) {
      return;
    }
    const undoInfo = await this.fontController.undoRedoGlyph(glyphName, isRedo);
    if (undoInfo !== undefined) {
      this.selection = undoInfo.undoSelection;
      if (undoInfo.location) {
        this.scrollAdjustBehavior = "pin-glyph-center";
        this.sceneSettings.location = undoInfo.location;
      }
      await this.sceneModel.updateScene();
      this.canvasController.requestUpdate();
    }
    return undoInfo !== undefined;
  }

  async reverseSelectedContoursDirection() {
    const { point: pointSelection } = parseSelection(this.selection);
    await this.editLayersAndRecordChanges((layerGlyphs) => {
      let selection;
      for (const layerGlyph of Object.values(layerGlyphs)) {
        const path = layerGlyph.path;
        const selectedContours = getSelectedContours(path, pointSelection);
        selection = reversePointSelection(path, pointSelection);

        for (const contourIndex of selectedContours) {
          const contour = path.getUnpackedContour(contourIndex);
          contour.points.reverse();
          if (contour.isClosed) {
            const [lastPoint] = contour.points.splice(-1, 1);
            contour.points.splice(0, 0, lastPoint);
          }
          const packedContour = packContour(contour);
          layerGlyph.path.deleteContour(contourIndex);
          layerGlyph.path.insertContour(contourIndex, packedContour);
        }
      }
      this.selection = selection;
      return "Reverse Contour Direction";
    });
  }

  async setStartPoint() {
    await this.editLayersAndRecordChanges((layerGlyphs) => {
      let newSelection;
      for (const layerGlyph of Object.values(layerGlyphs)) {
        const path = layerGlyph.path;
        const { point: pointSelection } = parseSelection(this.selection);
        const contourToPointMap = new Map();
        for (const pointIndex of pointSelection) {
          const contourIndex = path.getContourIndex(pointIndex);
          const contourStartPoint = path.getAbsolutePointIndex(contourIndex, 0);
          if (contourToPointMap.has(contourIndex)) {
            continue;
          }
          contourToPointMap.set(contourIndex, pointIndex - contourStartPoint);
        }
        newSelection = new Set();

        contourToPointMap.forEach((contourPointIndex, contourIndex) => {
          if (contourPointIndex === 0) {
            // Already start point
            newSelection.add(`point/${path.getAbsolutePointIndex(contourIndex, 0)}`);
            return;
          }
          if (!path.contourInfo[contourIndex].isClosed) {
            // Open path, ignore
            return;
          }
          const contour = path.getUnpackedContour(contourIndex);
          const head = contour.points.splice(0, contourPointIndex);
          contour.points.push(...head);
          layerGlyph.path.deleteContour(contourIndex);
          layerGlyph.path.insertContour(contourIndex, packContour(contour));
          newSelection.add(`point/${path.getAbsolutePointIndex(contourIndex, 0)}`);
        });
      }

      this.selection = newSelection;
      return "Set Start Point";
    });
  }

  async breakContour() {
    const { point: pointIndices } = parseSelection(this.selection);
    await this.editLayersAndRecordChanges((layerGlyphs) => {
      let numSplits;
      for (const layerGlyph of Object.values(layerGlyphs)) {
        numSplits = splitPathAtPointIndices(layerGlyph.path, pointIndices);
      }
      this.selection = new Set();
      return "Break Contour" + (numSplits > 1 ? "s" : "");
    });
  }

  async decomposeSelectedComponents() {
    const varGlyph = await this.sceneModel.getSelectedVariableGlyphController();

    // Retrieve the global location for each editing layer
    const layerLocations = {};
    for (const [sourceIndex, source] of enumerate(varGlyph.sources)) {
      if (
        this.editingLayerNames.indexOf(source.layerName) >= 0 &&
        !(source.layerName in layerLocations)
      ) {
        layerLocations[source.layerName] =
          varGlyph.mapSourceLocationToGlobal(sourceIndex);
      }
    }

    // Get the decomposed path/components for each editing layer
    const { component: componentSelection } = parseSelection(this.selection);
    componentSelection.sort((a, b) => (a > b) - (a < b));
    const getGlyphFunc = (glyphName) => this.fontController.getGlyph(glyphName);
    const decomposed = {};
    for (const layerName of this.editingLayerNames) {
      const layerGlyph = varGlyph.layers[layerName]?.glyph;
      if (!layerGlyph) {
        continue;
      }
      decomposed[layerName] = await decomposeComponents(
        layerGlyph.components,
        componentSelection,
        layerLocations[layerName],
        getGlyphFunc
      );
    }

    await this.editLayersAndRecordChanges((layerGlyphs) => {
      for (const [layerName, layerGlyph] of Object.entries(layerGlyphs)) {
        const decomposeInfo = decomposed[layerName];
        const path = layerGlyph.path;
        const components = layerGlyph.components;

        for (const contour of decomposeInfo.path.iterContours()) {
          // Hm, rounding should be optional
          // contour.coordinates = contour.coordinates.map(c => Math.round(c));
          path.appendContour(contour);
        }
        components.push(...decomposeInfo.components);

        // Next, delete the components we decomposed
        for (const componentIndex of reversed(componentSelection)) {
          components.splice(componentIndex, 1);
        }
      }
      this.selection = new Set();
      return "Decompose Component" + (componentSelection?.length === 1 ? "" : "s");
    });
  }

  getPathConnectDetector() {
    return new PathConnectDetector(this);
  }
}

class PathConnectDetector {
  constructor(sceneController) {
    this.sceneController = sceneController;
    const positionedGlyph = sceneController.sceneModel.getSelectedPositionedGlyph();
    this.path = positionedGlyph.glyph.path;
    const selection = sceneController.selection;
    if (selection.size !== 1) {
      return;
    }
    const { point: pointSelection } = parseSelection(selection);
    if (
      pointSelection?.length !== 1 ||
      !this.path.isStartOrEndPoint(pointSelection[0])
    ) {
      return;
    }
    this.connectSourcePointIndex = pointSelection[0];
  }

  shouldConnect(showConnectIndicator = false) {
    if (this.connectSourcePointIndex === undefined) {
      return false;
    }

    const sceneController = this.sceneController;
    const connectSourcePoint = this.path.getPoint(this.connectSourcePointIndex);
    const connectTargetPointIndex = this.path.pointIndexNearPoint(
      connectSourcePoint,
      sceneController.mouseClickMargin,
      this.connectSourcePointIndex
    );
    const shouldConnect =
      connectTargetPointIndex !== undefined &&
      connectTargetPointIndex !== this.connectSourcePointIndex &&
      !!this.path.isStartOrEndPoint(connectTargetPointIndex);
    if (showConnectIndicator && shouldConnect) {
      sceneController.sceneModel.pathConnectTargetPoint = this.path.getPoint(
        connectTargetPointIndex
      );
    } else {
      delete sceneController.sceneModel.pathConnectTargetPoint;
    }
    this.connectTargetPointIndex = connectTargetPointIndex;
    return shouldConnect;
  }

  clearConnectIndicator() {
    delete this.sceneController.sceneModel.pathConnectTargetPoint;
  }
}

function reversePointSelection(path, pointSelection) {
  const newSelection = [];
  for (const pointIndex of pointSelection) {
    const contourIndex = path.getContourIndex(pointIndex);
    const contourStartPoint = path.getAbsolutePointIndex(contourIndex, 0);
    const numPoints = path.getNumPointsOfContour(contourIndex);
    let newPointIndex = pointIndex;
    if (path.contourInfo[contourIndex].isClosed) {
      if (newPointIndex != contourStartPoint) {
        newPointIndex =
          contourStartPoint + numPoints - (newPointIndex - contourStartPoint);
      }
    } else {
      newPointIndex =
        contourStartPoint + numPoints - 1 - (newPointIndex - contourStartPoint);
    }
    newSelection.push(`point/${newPointIndex}`);
  }
  newSelection.sort((a, b) => (a > b) - (a < b));
  return new Set(newSelection);
}

function getSelectedContours(path, pointSelection) {
  const selectedContours = new Set();
  for (const pointIndex of pointSelection) {
    selectedContours.add(path.getContourIndex(pointIndex));
  }
  return [...selectedContours];
}

function positionedGlyphPosition(positionedGlyph) {
  if (!positionedGlyph) {
    return undefined;
  }
  return { x: positionedGlyph.x, xAdvance: positionedGlyph.glyph.xAdvance };
}

export function equalGlyphSelection(glyphSelectionA, glyphSelectionB) {
  return (
    glyphSelectionA?.lineIndex === glyphSelectionB?.lineIndex &&
    glyphSelectionA?.glyphIndex === glyphSelectionB?.glyphIndex
  );
}
