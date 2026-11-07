import type { schemaInputTools } from './input-model.ts';
/** Serialized DOM controller; no network, execution, storage, dynamic markup or implicit input replacement. */
export declare function liveInputControls(schemaValue: unknown, tools: ReturnType<typeof schemaInputTools>, onEdit?: () => void): {
    read(): any;
    mode: () => "json" | "fields";
};
export declare const inputControlsHtml = "<div id=\"input-modes\" class=\"live-controls\" hidden role=\"group\" aria-label=\"Input editor mode\"><button id=\"input-use-fields\" type=\"button\" aria-pressed=\"false\">Fields</button><button id=\"input-use-json\" type=\"button\" aria-pressed=\"true\">JSON</button></div><p id=\"input-message\" aria-live=\"polite\"></p><div id=\"input-fields\" hidden></div><div id=\"input-json\"><label for=\"live-input\">Sample input (JSON)</label><textarea id=\"live-input\" spellcheck=\"false\" aria-describedby=\"input-message input-help\"></textarea></div><details class=\"input-help\"><summary>How input fields work</summary><p id=\"input-help\">The sample is a starting point; review it before running. Uncheck Include to leave a field out. Leaving a field out is different from sending false, zero, an empty string or null. Required fields must be included. The runtime checks every input before it starts a run. Editing fields or switching to JSON never runs the workflow.</p></details>";
