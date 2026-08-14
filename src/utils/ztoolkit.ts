import {
  BasicTool,
  ClipboardHelper,
  ProgressWindowHelper,
  UITool,
  makeHelperTool,
  unregister,
} from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

/** Minimal toolkit: only the modules this plugin actually uses. */
class MyToolkit extends BasicTool {
  UI: UITool;
  ProgressWindow: typeof ProgressWindowHelper;
  Clipboard: typeof ClipboardHelper;

  constructor() {
    super();
    this.UI = new UITool(this);
    this.ProgressWindow = makeHelperTool(ProgressWindowHelper, this);
    this.Clipboard = makeHelperTool(ClipboardHelper, this);
  }

  unregisterAll() {
    unregister(this);
  }

  getDOMParser(): DOMParser {
    const ParserCtor = this.getGlobal("DOMParser");
    return new ParserCtor();
  }
}

function createZToolkit() {
  const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: MyToolkit) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  _ztoolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.png`,
  );
}
