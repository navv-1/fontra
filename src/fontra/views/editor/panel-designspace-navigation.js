import { registerAction } from "/core/actions.js";
import { getAxisBaseName } from "/core/glyph-controller.js";
import * as html from "/core/html-utils.js";
import { htmlToElement } from "/core/html-utils.js";
import { translate } from "/core/localization.js";
import { controllerKey, ObservableController } from "/core/observable-object.js";
import { labeledPopUpMenu, labeledTextInput } from "/core/ui-utils.js";
import {
  boolInt,
  enumerate,
  escapeHTMLCharacters,
  filterObject,
  objectsEqual,
  range,
  rgbaToCSS,
  round,
  scheduleCalls,
  throttleCalls,
} from "/core/utils.js";
import { GlyphSource, Layer } from "/core/var-glyph.js";
import {
  isLocationAtDefault,
  locationToString,
  makeSparseLocation,
  mapAxesFromUserSpaceToSourceSpace,
  piecewiseLinearMap,
} from "/core/var-model.js";
import { IconButton } from "/web-components/icon-button.js";
import { InlineSVG } from "/web-components/inline-svg.js";
import { showMenu } from "/web-components/menu-panel.js";
import { dialog, dialogSetup, message } from "/web-components/modal-dialog.js";
import { Accordion } from "/web-components/ui-accordion.js";

import Panel from "./panel.js";
import { NumberFormatter } from "/core/ui-utils.js";

const FONTRA_STATUS_KEY = "fontra.development.status";
const FONTRA_STATUS_DEFINITIONS_KEY = "fontra.sourceStatusFieldDefinitions";

export default class DesignspaceNavigationPanel extends Panel {
  identifier = "designspace-navigation";
  iconPath = "/images/sliders.svg";

  constructor(editorController) {
    super(editorController);
    this.fontController = this.editorController.fontController;
    this.sceneSettingsController = this.editorController.sceneSettingsController;
    this.sceneSettings = this.editorController.sceneSettingsController.model;
    this.sceneModel = this.editorController.sceneController.sceneModel;
    this.sceneController = this.editorController.sceneController;
    this.updateResetAllAxesButtonState = throttleCalls(
      () => this._updateResetAllAxesButtonState(),
      100
    );

    this.fontController.ensureInitialized.then(() => {
      this.setup();
    });

    this.initActions();
  }

  initActions() {
    registerAction(
      "designspace-navigation.edit-all-compatible-sources",
      {
        topic: "0050-action-topics.designspace-navigation",
        defaultShortCuts: [{ baseKey: "e", commandKey: true }],
      },
      (event) => this.onEditHeaderClick(event)
    );
  }

  getContentElement() {
    const accordion = new Accordion();
    accordion.appendStyle(`
      .interpolation-error-icon {
        display: inline-block;
        height: 1.35em;
        width: 1.35em;
        color: var(--fontra-light-red-color);
        transform: translate(0, 0.3em);
        margin-right: 0.25em;
      }
    `);
    accordion.items = [
      {
        id: "font-axes-accordion-item",
        label: translate("sidebar.designspace-navigation.font-axes"),
        open: true,
        content: html.createDomElement(
          "designspace-location",
          { id: "font-axes", style: "height: 100%;" },
          []
        ),
        auxiliaryHeaderElement: groupAccordionHeaderButtons([
          makeAccordionHeaderButton({
            icon: "menu-2",
            id: "font-axes-view-options-button",
            tooltip: "View options",
            onclick: (event) => this.showFontAxesViewOptionsMenu(event),
          }),
          makeAccordionHeaderButton({
            icon: "tool",
            tooltip: translate("sidebar.designspace-navigation.font-axes.edit"),
            onclick: (event) => {
              const url = new URL(window.location);
              url.pathname = url.pathname.replace("/editor/", "/fontinfo/");
              url.hash = "#axes-panel";
              window.open(url.toString());
            },
          }),
          makeAccordionHeaderButton({
            icon: "refresh",
            id: "reset-font-axes-button",
            tooltip: translate("sidebar.designspace-navigation.font-axes.reset"),
            onclick: (event) => this.resetFontAxesToDefault(),
          }),
        ]),
      },
      {
        id: "glyph-axes-accordion-item",
        label: translate("sidebar.designspace-navigation.glyph-axes"),
        open: true,
        content: html.createDomElement(
          "designspace-location",
          { id: "glyph-axes", style: "height: 100%;" },
          []
        ),
        auxiliaryHeaderElement: groupAccordionHeaderButtons([
          makeAccordionHeaderButton({
            icon: "tool",
            tooltip: translate("sidebar.designspace-navigation.glyph-axes.edit"),
            onclick: (event) => this.editGlyphAxes(),
          }),
          makeAccordionHeaderButton({
            icon: "refresh",
            id: "reset-glyph-axes-button",
            tooltip: translate("sidebar.designspace-navigation.glyph-axes.reset"),
            onclick: (event) => this.resetGlyphAxesToDefault(),
          }),
        ]),
      },
      {
        id: "glyph-sources-accordion-item",
        label: translate("sidebar.designspace-navigation.glyph-sources"),
        open: true,
        content: html.div(
          {
            style:
              "display: grid; grid-template-rows: 1fr auto auto; height: 100%; box-sizing: border-box;",
          },
          [
            html.createDomElement("ui-list", { id: "sources-list" }),
            html.createDomElement("add-remove-buttons", {
              style: "padding: 0.5em 0 0 0;",
              id: "sources-list-add-remove-buttons",
            }),
            html.createDomElement("div", {
              id: "interpolation-error-info",
            }),
          ]
        ),
      },
    ];

    return accordion;
  }

  get fontAxesElement() {
    return this.contentElement.querySelector("#font-axes");
  }

  get glyphAxesElement() {
    return this.contentElement.querySelector("#glyph-axes");
  }

  get glyphAxesAccordionItem() {
    return this.contentElement.querySelector("#glyph-axes-accordion-item");
  }

  get glyphSourcesAccordionItem() {
    return this.contentElement.querySelector("#glyph-sources-accordion-item");
  }

  setup() {
    this._setFontLocationValues();
    this.glyphAxesElement.values = this.sceneSettings.glyphLocation;

    this.fontAxesElement.addEventListener(
      "locationChanged",
      scheduleCalls(async (event) => {
        this.sceneController.scrollAdjustBehavior = "pin-glyph-center";
        this.sceneController.autoViewBox = false;

        this.sceneSettingsController.setItem(
          this.sceneSettings.fontAxesUseSourceCoordinates
            ? "fontLocationSource"
            : "fontLocationUser",
          { ...this.fontAxesElement.values },
          { senderID: this }
        );
      })
    );

    this.glyphAxesElement.addEventListener(
      "locationChanged",
      scheduleCalls(async (event) => {
        this.sceneController.scrollAdjustBehavior = "pin-glyph-center";
        this.sceneController.autoViewBox = false;
        this.sceneSettingsController.setItem(
          "glyphLocation",
          { ...this.glyphAxesElement.values },
          { senderID: this }
        );
      })
    );

    this.sceneSettingsController.addKeyListener("selectedGlyphName", (event) => {
      this._updateAxes();
      this._updateSources();
      this._updateInterpolationErrorInfo();
    });

    this.sceneSettingsController.addKeyListener(
      [
        "fontAxesUseSourceCoordinates",
        "fontAxesShowEffectiveLocation",
        "fontAxesShowHidden",
        "fontAxesSkipMapping",
      ],
      (event) => {
        this._updateAxes();
      }
    );

    this.sceneController.addCurrentGlyphChangeListener(
      scheduleCalls((event) => {
        this._updateAxes();
        this._updateSources();
        this._updateInterpolationErrorInfo();
      }, 100)
    );

    this.sceneSettingsController.addKeyListener(
      ["fontLocationSourceMapped", "glyphLocation"],
      (event) => {
        this.sceneSettings.editLayerName = null;
        this.updateResetAllAxesButtonState();
        this.updateInterpolationContributions();
        this._updateInterpolationErrorInfo();
        if (event.senderInfo?.senderID === this) {
          // Sent by us, ignore
          return;
        }
        if (event.key === "glyphLocation") {
          this.glyphAxesElement.values = event.newValue;
        } else {
          this._setFontLocationValues();
        }
      },
      true
    );

    this.sceneSettingsController.addKeyListener(
      "selectedSourceIndex",
      async (event) => {
        const varGlyphController =
          await this.sceneModel.getSelectedVariableGlyphController();
        let index = event.newValue;

        let sourceListItem = this.sourceListGetSourceItem(index);

        if (
          varGlyphController?.sources[index]?.layerName !== sourceListItem?.layerName
        ) {
          // the selectedSourceIndex event may come at a time that the
          // sourcesList hasn't been updated yet, so could be out of
          // sync. Prevent setting it to a wrong value.
          sourceListItem = undefined;
        }

        this.sourcesList.setSelectedItem(sourceListItem);

        this._updateRemoveSourceButtonState();
        this._updateEditingStatus();
      }
    );

    this.sceneController.addEventListener("glyphEditCannotEditReadOnly", () => {
      // This happens also when the user tries to change the development status
      // or the "on/off" source selector, in which case we must refresh the UI.
      this._updateAxes();
      this._updateSources();
    });

    this.sceneController.addEventListener("glyphEditCannotEditLocked", async () => {
      // See the event handler for glyphEditCannotEditReadOnly above
      this._updateAxes();
      this._updateSources();
    });

    const columnDescriptions = this._setupSourceListColumnDescriptions();

    this.sourcesList = this.contentElement.querySelector("#sources-list");
    this.sourcesList.appendStyle(`
      .clickable-icon-header {
        transition: 150ms;
      }
      .clickable-icon-header:hover {
        transform: scale(1.1);
      }
      .clickable-icon-header:active {
        transform: scale(1.2);
      }
    `);
    this.sourcesList.showHeader = true;
    this.sourcesList.columnDescriptions = columnDescriptions;

    this.addRemoveSourceButtons = this.contentElement.querySelector(
      "#sources-list-add-remove-buttons"
    );

    this.addRemoveSourceButtons.addButtonCallback = () => this.addSource();
    this.addRemoveSourceButtons.removeButtonCallback = () => this.removeSource();

    this.sourcesList.addEventListener("listSelectionChanged", async (event) => {
      this.sceneController.scrollAdjustBehavior = "pin-glyph-center";
      const selectedItem = this.sourcesList.getSelectedItem();
      const sourceIndex = selectedItem?.sourceIndex;
      this.sceneSettings.selectedSourceIndex = sourceIndex;
      if (sourceIndex != undefined) {
        const varGlyphController =
          await this.sceneModel.getSelectedVariableGlyphController();
        if (varGlyphController) {
          this.sceneSettings.editLayerName =
            varGlyphController.sources[sourceIndex]?.layerName;
        } else {
          this.sceneSettings.editLayerName = null;
        }
      } else {
        this.sceneSettings.editLayerName = null;
      }
      this._updateEditingStatus();
    });

    this.sourcesList.addEventListener("rowDoubleClicked", (event) => {
      const sourceIndex =
        this.sourcesList.items[event.detail.doubleClickedRowIndex].sourceIndex;
      this.editSourceProperties(sourceIndex);
    });

    this.fontController.addChangeListener(
      { axes: null },
      (change, isExternalChange) => {
        this._updateAxes();
        this._updateSources();
      }
    );

    this.fontController.addChangeListener(
      { customData: null },
      (change, isExternalChange) => {
        // the statusFieldDefinitions may have changed, better update the col defs, too
        this.sourcesList.columnDescriptions = this._setupSourceListColumnDescriptions();
        this._updateSources();
      }
    );

    this._updateAxes();
    this._updateSources();
  }

  _setupSourceListColumnDescriptions() {
    const columnDescriptions = [
      {
        title: " ",
        key: "active",
        cellFactory: makeIconCellFactory(
          ["/tabler-icons/circle-dotted.svg", "/tabler-icons/circle-dot.svg"],
          true
        ),
        width: "1.2em",
      },
      {
        title: " ",
        key: "interpolationStatus",
        cellFactory: interpolationErrorCell,
        width: "1.2em",
      },
      {
        key: "name",
        title: translate("sidebar.designspace-navigation.glyph-sources.name"),
        width: "12em",
      },
      {
        title: makeClickableIconHeader("/tabler-icons/eye.svg", (event) =>
          this.onVisibilityHeaderClick(event)
        ),
        key: "visible",
        cellFactory: makeIconCellFactory([
          "/tabler-icons/eye-closed.svg",
          "/tabler-icons/eye.svg",
        ]),
        width: "1.2em",
      },
      {
        title: makeClickableIconHeader("/tabler-icons/pencil.svg", (event) =>
          this.onEditHeaderClick(event)
        ),
        key: "editing",
        cellFactory: makeIconCellFactory(
          ["", "/tabler-icons/pencil.svg"],
          false,
          (item, key) => {
            const selectedItem = this.sourcesList.getSelectedItem();
            const discreteLocationKey =
              selectedItem?.interpolationStatus?.discreteLocationKey;
            const newValue =
              item === selectedItem ||
              (!selectedItem ||
              item?.interpolationStatus?.error ||
              selectedItem?.interpolationStatus?.error ||
              item?.interpolationStatus?.discreteLocationKey !== discreteLocationKey
                ? false
                : !item[key]);
            return { newValue, selectItem: !selectedItem };
          }
        ),
        width: "1.2em",
      },
    ];

    const statusFieldDefinitions =
      this.sceneController.sceneModel.fontController.customData[
        FONTRA_STATUS_DEFINITIONS_KEY
      ];

    if (statusFieldDefinitions) {
      this.defaultStatusValue = statusFieldDefinitions.find(
        (statusDef) => statusDef.isDefault
      )?.value;
      columnDescriptions.push({
        title: translate("sidebar.designspace-navigation.glyph-sources.status"),
        key: "status",
        cellFactory: statusListCell,
        width: "3em",
        statusFieldDefinitions: statusFieldDefinitions,
        menuItems: statusFieldDefinitions.map((statusDef) => {
          return {
            title: statusDef.label,
            statusDef: statusDef,
          };
        }),
      });
    }

    columnDescriptions.push({
      title: " ",
      key: "interpolationContribution",
      cellFactory: interpolationContributionCell,
      width: "1.2em",
    });
    return columnDescriptions;
  }

  _setFontLocationValues() {
    const locationKey = this.sceneSettings.fontAxesUseSourceCoordinates
      ? "fontLocationSource"
      : "fontLocationUser";
    this.fontAxesElement.values = this.sceneSettings[locationKey];
    this.fontAxesElement.phantomValues = this.sceneSettings.fontLocationSourceMapped;
  }

  sourceListGetSourceItem(sourceIndex) {
    if (sourceIndex == undefined) {
      return undefined;
    }
    return this.sourcesList.items.find((item) => item.sourceIndex == sourceIndex);
  }

  sourceListSetSelectedSource(sourceIndex) {
    if (sourceIndex != undefined) {
      this.sourcesList.setSelectedItem(this.sourceListGetSourceItem(sourceIndex));
    } else {
      this.sourcesList.setSelectedItemIndex(undefined);
    }
  }

  showFontAxesViewOptionsMenu(event) {
    const menuItems = [
      {
        title: "Apply single-axis mapping",
        callback: () => {
          this.sceneSettings.fontAxesUseSourceCoordinates =
            !this.sceneSettings.fontAxesUseSourceCoordinates;
        },
        checked: !this.sceneSettings.fontAxesUseSourceCoordinates,
      },
      {
        title: "Apply cross-axis mapping",
        callback: () => {
          this.sceneSettings.fontAxesSkipMapping =
            !this.sceneSettings.fontAxesSkipMapping;
        },
        checked: !this.sceneSettings.fontAxesSkipMapping,
      },
      { title: "-" },
      {
        title: "Show effective location",
        callback: () => {
          this.sceneSettings.fontAxesShowEffectiveLocation =
            !this.sceneSettings.fontAxesShowEffectiveLocation;
        },
        checked: this.sceneSettings.fontAxesShowEffectiveLocation,
      },
      {
        title: "Show hidden axes",
        callback: () => {
          this.sceneSettings.fontAxesShowHidden =
            !this.sceneSettings.fontAxesShowHidden;
        },
        checked: this.sceneSettings.fontAxesShowHidden,
      },
    ];

    const button = this.contentElement.querySelector("#font-axes-view-options-button");
    const buttonRect = button.getBoundingClientRect();
    showMenu(menuItems, { x: buttonRect.left, y: buttonRect.bottom });
  }

  resetFontAxesToDefault(event) {
    this.sceneSettings.fontLocationUser = {};
  }

  resetGlyphAxesToDefault(event) {
    this.sceneSettings.glyphLocation = {};
  }

  _updateResetAllAxesButtonState() {
    let button;
    const fontAxesSourceSpace = mapAxesFromUserSpaceToSourceSpace(this.fontAxes);
    button = this.contentElement.querySelector("#reset-font-axes-button");
    button.disabled = isLocationAtDefault(
      this.sceneSettings.fontLocationSourceMapped,
      fontAxesSourceSpace
    );
    button = this.contentElement.querySelector("#reset-glyph-axes-button");
    button.disabled = isLocationAtDefault(
      this.sceneSettings.glyphLocation,
      this.glyphAxesElement.axes
    );
  }

  async onVisibilityHeaderClick(event) {
    let backgroundLayers;
    if (Object.keys(this.sceneController.backgroundLayers).length) {
      backgroundLayers = {};
    } else {
      const varGlyphController =
        await this.sceneModel.getSelectedVariableGlyphController();
      backgroundLayers = {};
      for (const source of varGlyphController.sources) {
        if (!backgroundLayers[source.layerName]) {
          backgroundLayers[source.layerName] = source.name;
        }
      }
    }
    this.sceneController.backgroundLayers = backgroundLayers;
    this._updateSources();
  }

  onEditHeaderClick(event) {
    const items = this.sourcesList.items.filter(
      (item) => !item.interpolationStatus?.error
    );
    const selectedItem = this.sourcesList.getSelectedItem();
    const discreteLocationKey = selectedItem?.interpolationStatus?.discreteLocationKey;
    const onOff = selectedItem?.interpolationStatus?.error
      ? false
      : selectedItem &&
        !items.every(
          (item) =>
            item.editing ||
            item.interpolationStatus.discreteLocationKey !== discreteLocationKey
        );

    for (const item of items) {
      item.editing =
        (onOff &&
          item.interpolationStatus.discreteLocationKey === discreteLocationKey) ||
        item === selectedItem;
    }
  }

  async updateInterpolationContributions() {
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    if (!varGlyphController) {
      return;
    }
    const interpolationContributions = varGlyphController.getInterpolationContributions(
      {
        ...this.sceneSettings.fontLocationSourceMapped,
        ...this.sceneSettings.glyphLocation,
      }
    );
    for (const [index, sourceItem] of enumerate(this.sourcesList.items)) {
      sourceItem.interpolationContribution =
        interpolationContributions[sourceItem.sourceIndex];
    }
  }

  get fontAxes() {
    return this.sceneSettings.fontAxesShowHidden
      ? this.fontController.fontAxes
      : this.fontController.fontAxes.filter((axis) => !axis.hidden);
  }

  async _updateAxes() {
    const fontAxesSourceSpace = mapAxesFromUserSpaceToSourceSpace(this.fontAxes);
    const fontAxes = this.sceneSettings.fontAxesUseSourceCoordinates
      ? fontAxesSourceSpace
      : [...this.fontAxes];
    this.fontAxesElement.axes = fontAxes;
    if (this.sceneSettings.fontAxesShowEffectiveLocation) {
      this.fontAxesElement.phantomAxes = fontAxesSourceSpace;
    } else {
      this.fontAxesElement.phantomAxes = [];
    }
    this._setFontLocationValues();

    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();

    const glyphAxes = varGlyphController ? foldNLIAxes(varGlyphController.axes) : [];
    this.glyphAxesElement.axes = glyphAxes;
    this.glyphAxesAccordionItem.hidden = !varGlyphController;

    this._updateResetAllAxesButtonState();
  }

  async _updateSources() {
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    const sources = varGlyphController?.sources || [];
    const sourceInterpolationStatus =
      varGlyphController?.sourceInterpolationStatus || [];
    const interpolationContributions =
      varGlyphController?.getInterpolationContributions({
        ...this.sceneSettings.fontLocationSourceMapped,
        ...this.sceneSettings.glyphLocation,
      }) || [];
    let backgroundLayers = { ...this.sceneController.backgroundLayers };
    let editingLayers = { ...this.sceneController.editingLayers };

    const sourceItems = [];
    for (const [index, source] of enumerate(sources)) {
      const layerName = source.layerName;
      const status = source.customData[FONTRA_STATUS_KEY];
      const sourceController = new ObservableController({
        name: source.name,
        layerName: source.layerName,
        active: !source.inactive,
        visible: backgroundLayers[layerName] === source.name,
        editing: editingLayers[layerName] === source.name,
        status: status !== undefined ? status : this.defaultStatusValue,
        sourceIndex: index,
        interpolationStatus: sourceInterpolationStatus[index],
        interpolationContribution: interpolationContributions[index],
      });
      sourceController.addKeyListener("active", async (event) => {
        await this.sceneController.editGlyphAndRecordChanges((glyph) => {
          glyph.sources[index].inactive = !event.newValue;
          return `${event.newValue ? "" : "de"}activate ${source.name}`;
        });
      });
      sourceController.addKeyListener("visible", async (event) => {
        if (event.newValue) {
          backgroundLayers[layerName] = source.name;
        } else {
          delete backgroundLayers[layerName];
        }
        this.sceneController.backgroundLayers = backgroundLayers;
      });
      sourceController.addKeyListener("editing", async (event) => {
        if (event.newValue) {
          editingLayers[layerName] = source.name;
        } else {
          delete editingLayers[layerName];
        }
        this.sceneController.editingLayers = editingLayers;
        await this._pruneEditingLayers();
      });
      sourceController.addKeyListener("status", async (event) => {
        await this.sceneController.editGlyphAndRecordChanges((glyph) => {
          const editingLayerNames = new Set(this.sceneController.editingLayerNames);
          let count = 0;
          for (const [i, source] of enumerate(glyph.sources)) {
            if (editingLayerNames.has(source.layerName)) {
              source.customData[FONTRA_STATUS_KEY] = event.newValue;
              count++;
            }
          }
          return `set status ${count > 1 ? "(multiple)" : source.name}`;
        });
      });
      sourceItems.push(sourceController.model);
    }

    this.sourcesList.setItems(sourceItems, false, true);
    this.sourceListSetSelectedSource(this.sceneSettings.selectedSourceIndex);

    this.glyphSourcesAccordionItem.hidden = !varGlyphController;

    this._updateRemoveSourceButtonState();
    this._updateEditingStatus();
  }

  _updateRemoveSourceButtonState() {
    this.addRemoveSourceButtons.disableRemoveButton =
      this.sourcesList.getSelectedItemIndex() === undefined;
  }

  async _updateEditingStatus() {
    const selectedItem = this.sourcesList.getSelectedItem();
    if (!selectedItem?.editing || selectedItem.interpolationStatus?.error) {
      this.sourcesList.items.forEach((item) => {
        item.editing = item === selectedItem;
      });
    }
  }

  async _pruneEditingLayers() {
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    if (!varGlyphController) {
      return;
    }
    const layers = varGlyphController.layers;
    const editingLayers = { ...this.sceneController.editingLayers };
    for (const layerName of Object.keys(editingLayers)) {
      if (!(layerName in layers)) {
        delete editingLayers[layerName];
      }
    }
    this.sceneController.editingLayers = editingLayers;
  }

  async removeSource() {
    const sourceItem = this.sourcesList.getSelectedItem();
    if (!sourceItem) {
      return;
    }
    const sourceIndex = sourceItem.sourceIndex;

    const glyphController = await this.sceneModel.getSelectedVariableGlyphController();
    const glyph = glyphController.glyph;
    const source = glyph.sources[sourceIndex];
    const dialog = await dialogSetup("Delete source", null, [
      { title: "Cancel", isCancelButton: true },
      { title: "Delete", isDefaultButton: true, result: "ok" },
    ]);

    const canDeleteLayer =
      1 ===
      glyph.sources.reduce(
        (count, src) => count + (src.layerName === source.layerName ? 1 : 0),
        0
      );
    const deleteLayerCheckBox = html.input({
      type: "checkbox",
      id: "delete-layer",
      checked: canDeleteLayer,
      disabled: !canDeleteLayer,
    });

    const dialogContent = html.div({}, [
      html.div({ class: "message" }, [
        `Are you sure you want to delete source #${sourceIndex}, “${source.name}”?`,
      ]),
      html.br(),
      deleteLayerCheckBox,
      html.label({ for: "delete-layer", style: canDeleteLayer ? "" : "color: gray;" }, [
        `Also delete associated layer “${source.layerName}”`,
      ]),
    ]);
    dialog.setContent(dialogContent);

    if (!(await dialog.run())) {
      return;
    }

    const layer = glyph.layers[source.layerName];
    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      glyph.sources.splice(sourceIndex, 1);
      let layerMessage = "";
      if (layer !== undefined && deleteLayerCheckBox.checked) {
        delete glyph.layers[source.layerName];
        layerMessage = " and layer";
      }
      return "delete source" + layerMessage;
    });
    this.sourcesList.setSelectedItemIndex(undefined, true);
  }

  async addSource() {
    const glyphController = await this.sceneModel.getSelectedVariableGlyphController();
    const glyph = glyphController.glyph;

    const location = glyphController.expandNLIAxes({
      ...this.sceneSettings.fontLocationSourceMapped,
      ...this.sceneSettings.glyphLocation,
    });

    const suggestedLocationBase = undefined; // take from font source, if any

    const {
      location: newLocation,
      sourceName,
      layerName,
      layerNames,
      locationBase,
    } = await this._sourcePropertiesRunDialog(
      "Add source",
      "Add",
      glyph,
      "",
      "",
      location,
      suggestedLocationBase
    );
    if (!newLocation) {
      return;
    }

    const getGlyphFunc = this.sceneController.sceneModel.fontController.getGlyph.bind(
      this.sceneController.sceneModel.fontController
    );

    let { instance } = await glyphController.instantiate(newLocation, getGlyphFunc);
    instance = instance.copy();
    // Round coordinates and component positions
    instance.path = instance.path.roundCoordinates();
    roundComponentOrigins(instance.components);

    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      glyph.sources.push(
        GlyphSource.fromObject({
          name: sourceName,
          layerName: layerName,
          location: newLocation,
        })
      );
      if (layerNames.indexOf(layerName) < 0) {
        // Only add layer if the name is new
        glyph.layers[layerName] = Layer.fromObject({ glyph: instance });
      }
      return "add source";
    });
    // Navigate to new source
    const selectedSourceIndex = glyph.sources.length - 1; /* the newly added source */
    this.sceneSettings.selectedSourceIndex = selectedSourceIndex;
  }

  async editSourceProperties(sourceIndex) {
    const glyphController = await this.sceneModel.getSelectedVariableGlyphController();
    const glyph = glyphController.glyph;

    const source = glyph.sources[sourceIndex];

    const {
      location: newLocation,
      sourceName,
      layerName,
      layerNames,
      locationBase,
    } = await this._sourcePropertiesRunDialog(
      "Source properties",
      "Done",
      glyph,
      source.name,
      source.layerName,
      source.location,
      source.locationBase
    );
    if (!newLocation) {
      return;
    }

    const filteredLocation = stripLocation(newLocation, locationBase, glyph);

    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      const source = glyph.sources[sourceIndex];
      if (!objectsEqual(source.location, filteredLocation)) {
        source.location = filteredLocation;
      }
      if (sourceName !== source.name) {
        source.name = sourceName;
      }

      source.locationBase = locationBase;

      const oldLayerName = source.layerName;
      if (layerName !== oldLayerName) {
        source.layerName = layerName;
        if (layerNames.indexOf(layerName) < 0) {
          // Rename the layer
          if (glyph.layers[oldLayerName]) {
            glyph.layers[layerName] = glyph.layers[oldLayerName];
            delete glyph.layers[oldLayerName];
          }
          for (const source of glyph.sources) {
            if (source.layerName === oldLayerName) {
              source.layerName = layerName;
            }
          }
        }
      }
      return "edit source properties";
    });
  }

  async _sourcePropertiesRunDialog(
    title,
    okButtonTitle,
    glyph,
    sourceName,
    layerName,
    location,
    locationBase
  ) {
    const validateInput = () => {
      const warnings = [];
      const editedSourceName =
        nameController.model.sourceName || nameController.model.suggestedSourceName;
      if (!editedSourceName.length) {
        warnings.push("⚠️ The source name must not be empty");
      } else if (
        editedSourceName !== sourceName &&
        glyph.sources.some((source) => source.name === editedSourceName)
      ) {
        warnings.push("⚠️ The source name should be unique");
      }
      const locStr = locationToString(
        makeSparseLocation(locationController.model, locationAxes)
      );
      if (sourceLocations.has(locStr)) {
        warnings.push("⚠️ The source location must be unique");
      }
      warningElement.innerText = warnings.length ? warnings.join("\n") : "";
      dialog.defaultButton.classList.toggle("disabled", warnings.length);
    };

    const locationAxes = this._sourcePropertiesLocationAxes(glyph);
    const locationController = new ObservableController({ ...location });
    const layerNames = Object.keys(glyph.layers);
    const suggestedSourceName = suggestedSourceNameFromLocation(
      makeSparseLocation(location, locationAxes)
    );

    const nameController = new ObservableController({
      sourceName: sourceName || suggestedSourceName,
      layerName: layerName === sourceName ? "" : layerName,
      suggestedSourceName: suggestedSourceName,
      suggestedLayerName: sourceName || suggestedSourceName,
      locationBase: locationBase || "",
    });

    nameController.addKeyListener("sourceName", (event) => {
      nameController.model.suggestedLayerName =
        event.newValue || nameController.model.suggestedSourceName;
      validateInput();
    });

    const glyphAxisNames = getGlyphAxisNamesSet(glyph);

    nameController.addKeyListener("locationBase", (event) => {
      if (!event.newValue) {
        return;
      }
      const fontSource = this.fontController.sources[event.newValue];
      const sourceLocation = fontSource.location;
      const fontLocation = filterObject(
        sourceLocation,
        (name, value) => !glyphAxisNames.has(name)
      );
      const glyphLocation = filterObject(locationController.model, (name, value) =>
        glyphAxisNames.has(name)
      );
      const newLocation = {
        ...this.fontController.fontSourcesInstancer.defaultLocation,
        ...sourceLocation,
        ...glyphLocation,
      };
      for (const [name, value] of Object.entries(newLocation)) {
        locationController.setItem(name, value, { sentByLocationBase: true });
      }
      nameController.model.sourceName = fontSource.name;
    });

    locationController.addListener((event) => {
      if (!event.senderInfo?.sentByLocationBase) {
        nameController.model.locationBase = "";
      }
      const suggestedSourceName = suggestedSourceNameFromLocation(
        makeSparseLocation(locationController.model, locationAxes)
      );
      if (nameController.model.sourceName == nameController.model.suggestedSourceName) {
        nameController.model.sourceName = suggestedSourceName;
      }
      if (nameController.model.layerName == nameController.model.suggestedSourceName) {
        nameController.model.layerName = suggestedSourceName;
      }
      nameController.model.suggestedSourceName = suggestedSourceName;
      nameController.model.suggestedLayerName =
        nameController.model.sourceName || suggestedSourceName;
      validateInput();
    });

    const sourceLocations = new Set(
      glyph.sources.map((source) =>
        locationToString(makeSparseLocation(source.location, locationAxes))
      )
    );
    if (sourceName.length) {
      sourceLocations.delete(
        locationToString(makeSparseLocation(location, locationAxes))
      );
    }

    const fontSourceMenuItems = [
      { identifier: "", value: "None" },
      ...Object.entries(this.fontController.sources).map(
        ([sourceIdentifier, source]) => {
          return { identifier: sourceIdentifier, value: source.name };
        }
      ),
    ];

    const { contentElement, warningElement } = this._sourcePropertiesContentElement(
      locationAxes,
      nameController,
      locationController,
      layerNames,
      sourceLocations,
      fontSourceMenuItems
    );

    const dialog = await dialogSetup(title, null, [
      { title: "Cancel", isCancelButton: true },
      { title: okButtonTitle, isDefaultButton: true, disabled: !sourceName.length },
    ]);
    dialog.setContent(contentElement);

    setTimeout(
      () => contentElement.querySelector("#source-name-text-input")?.focus(),
      0
    );

    validateInput();

    if (!(await dialog.run())) {
      // User cancelled
      return {};
    }

    const newLocation = makeSparseLocation(locationController.model, locationAxes);

    sourceName =
      nameController.model.sourceName || nameController.model.suggestedSourceName;
    layerName =
      nameController.model.layerName || nameController.model.suggestedLayerName;
    locationBase = nameController.model.locationBase || null;

    return { location: newLocation, sourceName, layerName, layerNames, locationBase };
  }

  _sourcePropertiesLocationAxes(glyph) {
    const glyphAxisNames = getGlyphAxisNamesSet(glyph);
    const fontAxes = mapAxesFromUserSpaceToSourceSpace(
      // Don't include font axes that also exist as glyph axes
      this.fontController.fontAxes.filter((axis) => !glyphAxisNames.has(axis.name))
    );
    return [
      ...fontAxes,
      ...(fontAxes.length && glyph.axes.length ? [{ isDivider: true }] : []),
      ...glyph.axes,
    ];
  }

  _sourcePropertiesContentElement(
    locationAxes,
    nameController,
    locationController,
    layerNames,
    sourceLocations,
    fontSourceMenuItems
  ) {
    const locationElement = html.createDomElement("designspace-location", {
      style: `grid-column: 1 / -1;
        min-height: 0;
        overflow: auto;
        height: 100%;
      `,
    });
    const warningElement = html.div({
      id: "warning-text",
      style: `grid-column: 1 / -1; min-height: 1.5em;`,
    });
    locationElement.axes = locationAxes;
    locationElement.controller = locationController;

    const contentElement = html.div(
      {
        style: `overflow: hidden;
          white-space: nowrap;
          display: grid;
          gap: 0.5em;
          grid-template-columns: max-content auto;
          align-items: center;
          height: 100%;
          min-height: 0;
        `,
      },
      [
        ...labeledPopUpMenu(
          "Location Base:",
          nameController,
          "locationBase",
          fontSourceMenuItems
        ),
        ...labeledTextInput("Source name:", nameController, "sourceName", {
          placeholderKey: "suggestedSourceName",
          id: "source-name-text-input",
        }),
        ...labeledTextInput("Layer:", nameController, "layerName", {
          placeholderKey: "suggestedLayerName",
          choices: layerNames,
        }),
        html.br(),
        locationElement,
        warningElement,
      ]
    );
    return { contentElement, warningElement };
  }

  async editGlyphAxes() {
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    if (!varGlyphController) {
      return;
    }
    const dialog = await dialogSetup("Edit glyph axes", null, [
      { title: "Cancel", isCancelButton: true },
      { title: "Okay", isDefaultButton: true, result: "ok" },
    ]);

    const columnDescriptions = [
      { key: "name", title: "Name", width: "8em", editable: true },
      {
        key: "minValue",
        title: "Minimum",
        width: "5em",
        align: "right",
        editable: true,
        formatter: NumberFormatter,
      },
      {
        key: "defaultValue",
        title: "Default",
        width: "5em",
        align: "right",
        editable: true,
        formatter: NumberFormatter,
      },
      {
        key: "maxValue",
        title: "Maximum",
        width: "5em",
        align: "right",
        editable: true,
        formatter: NumberFormatter,
      },
    ];

    const axisList = html.createDomElement("ui-list");
    axisList.columnDescriptions = columnDescriptions;
    axisList.showHeader = true;
    axisList.minHeight = "3em";
    const axisItems = varGlyphController.axes.map((axis) => {
      return { ...axis };
    });
    axisList.setItems(axisItems);

    const addRemoveAxisButtons = html.createDomElement("add-remove-buttons", {
      id: "axis-list-add-remove-buttons",
    });
    addRemoveAxisButtons.disableRemoveButton = true;

    addRemoveAxisButtons.addButtonCallback = (event) => {
      const index = axisItems.length;
      axisItems.push({
        name: "UntitledAxis",
        minValue: 0,
        defaultValue: 0,
        maxValue: 100,
      });
      axisList.setItems(axisItems);
      axisList.editCell(index, "name");
    };

    addRemoveAxisButtons.removeButtonCallback = (event) => {
      const index = axisList.getSelectedItemIndex();
      if (index !== undefined) {
        axisItems.splice(index, 1);
        axisList.setItems(axisItems);
      }
    };

    axisList.addEventListener("listSelectionChanged", (event) => {
      addRemoveAxisButtons.disableRemoveButton =
        axisList.getSelectedItemIndex() === undefined;
    });

    const contentElement = html.div({ style: "display: grid; grid-gap: 0.5em;" }, [
      axisList,
      addRemoveAxisButtons,
    ]);

    dialog.setContent(contentElement);
    if (!(await dialog.run())) {
      return;
    }

    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      // This doesn't work yet:
      // glyph.axes = axisItems;
      // Work around like this:
      glyph.axes.splice(0, glyph.axes.length, ...axisItems);
      return "edit axes";
    });
  }

  async _updateInterpolationErrorInfo() {
    const infoElement = this.contentElement.querySelector("#interpolation-error-info");
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    const glyphController = await this.sceneModel.getSelectedStaticGlyphController();

    const modelErrors = varGlyphController?.model.getModelErrors() || [];
    const instantiateErrors = glyphController?.errors || [];

    infoElement.innerText = "";

    if (!instantiateErrors.length && !modelErrors.length) {
      return;
    }

    const errors = instantiateErrors.length ? instantiateErrors : modelErrors;

    for (const error of errors) {
      let icon = "bug";
      switch (error.type) {
        case "model-warning":
          icon = "alert-triangle";
          break;
        case "model-error":
          icon = "alert-circle";
      }
      const nestedGlyphs =
        error.glyphs?.length > 1
          ? error.glyphs
              .slice(1)
              .map((gn) => "→\u00A0" + gn)
              .join(" ") + ": "
          : "";
      const msg = `${nestedGlyphs}${error.message}`;
      infoElement.appendChild(
        html.createDomElement("inline-svg", {
          class: "interpolation-error-icon",
          src: `/tabler-icons/${icon}.svg`,
        })
      );
      infoElement.append(msg);
      infoElement.appendChild(html.br());
    }
  }
}

function roundComponentOrigins(components) {
  components.forEach((component) => {
    component.transformation.translateX = Math.round(
      component.transformation.translateX
    );
    component.transformation.translateY = Math.round(
      component.transformation.translateY
    );
  });
}

function foldNLIAxes(axes) {
  // Fold NLI axes into single axes
  const axisInfo = {};
  for (const axis of axes || []) {
    const baseName = getAxisBaseName(axis.name);
    if (axisInfo[baseName]) {
      continue;
    }
    axisInfo[baseName] = { ...axis, name: baseName };
  }
  return Object.values(axisInfo);
}

function suggestedSourceNameFromLocation(location) {
  return (
    Object.entries(location)
      .map(([name, value]) => {
        value = round(value, 1);
        return `${name}=${value}`;
      })
      .join(",") || "default"
  );
}

function getGlyphAxisNamesSet(glyph) {
  return new Set(glyph.axes.map((axis) => axis.name));
}

function stripLocation(location, locationBase, glyph) {
  const glyphAxisNames = getGlyphAxisNamesSet(glyph);
  return locationBase
    ? filterObject(location, (name, value) => !glyphAxisNames.has(name))
    : location;
}

function makeIconCellFactory(
  iconPaths,
  triggerOnDoubleClick = false,
  switchValue = null
) {
  return (item, colDesc) => {
    const value = item[colDesc.key];
    const clickSymbol = triggerOnDoubleClick ? "ondblclick" : "onclick";
    const iconElement = html.createDomElement("inline-svg", {
      src: iconPaths[boolInt(value)],
      style: "width: 1.2em; height: 1.2em;",
      ondblclick: (event) => {
        event.stopImmediatePropagation();
      },
      [clickSymbol]: (event) => {
        const { newValue, selectItem } = switchValue
          ? switchValue(item, colDesc.key)
          : { newValue: !item[colDesc.key] };
        item[colDesc.key] = newValue;
        iconElement.src = iconPaths[boolInt(newValue)];
        if (!selectItem) {
          event.stopImmediatePropagation();
        }
      },
    });
    item[controllerKey].addKeyListener(colDesc.key, (event) => {
      iconElement.src = iconPaths[boolInt(event.newValue)];
    });
    return iconElement;
  };
}

function interpolationErrorCell(item, colDesc) {
  const value = item[colDesc.key];
  return value?.error
    ? html.createDomElement("inline-svg", {
        src: value.isModelError
          ? "/tabler-icons/alert-circle.svg"
          : "/tabler-icons/bug.svg",
        style: "width: 1.2em; height: 1.2em; color: var(--fontra-light-red-color);",
        onclick: (event) => {
          event.stopImmediatePropagation();
          message(
            "The source has an interpolation incompatibility",
            escapeHTMLCharacters(value.error)
          );
        },
      })
    : "";
}

const interpolationContributionIconSources = [...range(1, 6)].map(
  (index) => `/tabler-icons/antenna-bars-${index}.svg`
);

function interpolationContributionCell(item, colDesc) {
  const iconElement = html.createDomElement("inline-svg", {
    src: "",
    style: "width: 1.2em; height: 1.2em;",
  });

  function updateFromItem() {
    const rawValue = item[colDesc.key];
    if (rawValue != null) {
      let index;
      index = Math.min(Math.round(Math.sqrt(Math.abs(rawValue)) * 4), 4);
      if (index === 0 && Math.abs(rawValue) > 0.00001) {
        // Ensure non-zero has one "bar"
        index = 1;
      }
      iconElement.src = interpolationContributionIconSources[index];
      iconElement.style.color = rawValue < 0 ? "#F36" : null;
      iconElement.style.transform = rawValue < 0 ? "scale(-1, 1)" : null;
    } else {
      iconElement.src = "";
    }
  }

  const controller = item[controllerKey];
  controller.addKeyListener(colDesc.key, (event) => {
    updateFromItem();
  });

  updateFromItem();

  return iconElement;
}

function statusListCell(item, colDesc) {
  const value = item[colDesc.key];
  let color;
  for (const statusDef of colDesc.statusFieldDefinitions) {
    if (value === statusDef.value) {
      color = statusDef.color;
    }
  }
  const onclick = (event) => {
    const cell = event.target;
    const cellRect = cell.getBoundingClientRect();
    const menuItems = colDesc.menuItems.map((menuItem) => {
      return {
        ...menuItem,
        checked: menuItem.statusDef.value === item[colDesc.key],
        callback: () => {
          item[colDesc.key] = menuItem.statusDef.value;
          cell.style = cellColorStyle(menuItem.statusDef.color);
        },
      };
    });
    showMenu(menuItems, { x: cellRect.left, y: cellRect.bottom });
  };
  const props = {
    class: "status-cell",
    onclick: onclick,
  };
  if (color) {
    props["style"] = cellColorStyle(color);
    return html.div(props);
  } else {
    props["style"] = "width: 100%;";
    return html.div(props, [value === undefined ? "" : value]);
  }
}

function cellColorStyle(color) {
  return `background-color: ${rgbaToCSS(color)}; width: 100%;`;
}

function makeClickableIconHeader(iconPath, onClick) {
  return html.div(
    {
      class: "clickable-icon-header",
      style: "height: 1.2em; width: 1.2em;",
      onclick: onClick,
    },
    [
      html.createDomElement("inline-svg", {
        src: iconPath,
      }),
    ]
  );
}

function groupAccordionHeaderButtons(buttons) {
  return html.div(
    {
      style: `display: grid;
      grid-template-columns: repeat(${buttons.length}, auto);
      gap: 0.15em;
      `,
    },
    buttons
  );
}

function makeAccordionHeaderButton(button) {
  const options = {
    style: "width: 1.4em; height: 1.4em;",
    src: `/tabler-icons/${button.icon}.svg`,
    onclick: button.onclick,
  };

  if (button.id) {
    options.id = button.id;
  }

  if (button.tooltip) {
    options["data-tooltip"] = button.tooltip;
    options["data-tooltipposition"] = "bottom";
  }

  return html.createDomElement("icon-button", options);
}

customElements.define("panel-designspace-navigation", DesignspaceNavigationPanel);
