import * as html from "../core/html-utils.js";
import { BaseInfoPanel } from "./panel-base.js";

export class SourcesPanel extends BaseInfoPanel {
  static title = "Sources";
  static id = "sources-panel";

  setupUI() {
    this.panelElement.appendChild(
      html.div({}, [`⚠️ under construction: placeholder for ${this.constructor.id}`])
    );
  }
}
