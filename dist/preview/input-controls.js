/** Serialized DOM controller; no network, execution, storage, dynamic markup or implicit input replacement. */
export function liveInputControls(schemaValue, tools, onEdit) {
    const get = (id) => document.getElementById(id);
    const json = get('live-input'), fields = get('input-fields'), jsonPanel = get('input-json');
    const notice = get('input-message'), formButton = get('input-use-fields'), jsonButton = get('input-use-json');
    let schema, root, mode = 'json', sequence = 0;
    let initializing = true, staleCorrection = false;
    const error = (failure) => {
        notice.textContent = failure instanceof Error ? failure.message : 'Input editor unavailable; JSON has been retained.';
        staleCorrection = !initializing;
    };
    const edited = () => {
        if (staleCorrection)
            notice.textContent = 'Input changed. Choose Run workflow to check it; nothing was submitted.';
        staleCorrection = false;
        onEdit?.();
    };
    json.addEventListener('input', edited);
    fields.addEventListener('input', edited);
    fields.addEventListener('change', edited);
    const element = (tag, text) => { const el = document.createElement(tag); if (text !== undefined)
        el.textContent = text; return el; };
    const modes = () => {
        fields.hidden = mode !== 'fields';
        jsonPanel.hidden = mode !== 'json';
        formButton.setAttribute('aria-pressed', String(mode === 'fields'));
        jsonButton.setAttribute('aria-pressed', String(mode === 'json'));
    };
    const prepare = (value) => {
        if (!schema)
            throw Error('Use JSON for this schema.');
        const input = tools.compatible(schema, value);
        let count = 0;
        const arrayFocus = new Map();
        const build = (s, value, label, path) => {
            if (++count > tools.limits.fields)
                throw Error('Use JSON for this input; the complete editor exceeds 128 fields. No values were removed.');
            const id = `input-field-${++sequence}`, box = element('fieldset');
            box.className = 'schema-field';
            box.append(element('legend', label));
            if (s.description)
                box.append(element('p', s.description));
            const bounds = Object.entries(s).filter(([key]) => ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum'].includes(key));
            if (bounds.length) {
                const names = { minLength: 'Minimum characters', maxLength: 'Maximum characters',
                    minimum: 'Minimum', maximum: 'Maximum', minItems: 'Minimum items', maxItems: 'Maximum items' };
                box.append(element('p', bounds.map(([key, value]) => `${names[key]}: ${value}`).join(' · ')));
            }
            let read;
            let focus = () => { box.tabIndex = -1; box.focus(); };
            if (s.type === 'object') {
                const children = Object.entries(s.properties ?? {}).map(([key, child]) => {
                    const present = Object.hasOwn(value, key), include = document.createElement('input');
                    include.type = 'checkbox';
                    include.checked = present;
                    include.id = `${id}-include-${++sequence}`;
                    const label = element('label', `Include ${key}${s.required?.includes(key) ? ' (required)' : ' (optional)'}`);
                    label.setAttribute('for', include.id);
                    box.append(include);
                    box.append(label);
                    const widget = build(child, present ? value[key] : tools.seed(child), key, [...path, key]);
                    widget.element.hidden = !present;
                    box.append(widget.element);
                    include.addEventListener('change', () => { widget.element.hidden = !include.checked; });
                    return { key, include, widget };
                });
                const extra = document.createElement('textarea');
                extra.id = `${id}-extra`;
                extra.spellcheck = false;
                extra.value = JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(s.properties ?? {}, key))), null, 2);
                const label = element('label', `Additional properties · JSON${s.additionalProperties === false ? ' (schema disallows extra properties)' : ''}`);
                label.setAttribute('for', extra.id);
                const more = element('details'), summary = element('summary', 'Additional fields (JSON)');
                more.append(summary);
                more.append(label);
                more.append(extra);
                box.append(more);
                focus = () => {
                    const child = children.find(child => child.include.checked);
                    if (child)
                        child.widget.focus();
                    else {
                        box.tabIndex = -1;
                        box.focus();
                    }
                };
                read = replace => {
                    const extras = tools.parse(extra.value);
                    if (!extras || typeof extras !== 'object' || Array.isArray(extras))
                        throw Error('Additional properties must be a JSON object.');
                    if (Object.keys(extras).some(key => Object.hasOwn(s.properties ?? {}, key)))
                        throw Error('Edit declared properties in their fields, not in Additional properties.');
                    return Object.fromEntries([...children.filter(child => child.include.checked).map(child => [child.key, child.widget.read(replace)]), ...Object.entries(extras)]);
                };
            }
            else if (s.type === 'array') {
                const rows = value.map((item, index) => {
                    const child = build(s.items, item, `Item ${index + 1}`, [...path, index]);
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.textContent = `Remove item ${index + 1}`;
                    remove.addEventListener('click', () => {
                        try {
                            replaceArray(rows.filter((_, i) => i !== index).map(row => row.read()), index, document.activeElement === remove);
                        }
                        catch (failure) {
                            error(failure);
                        }
                    });
                    child.element.append(remove);
                    box.append(child.element);
                    return child;
                });
                const replaceArray = (next, index, restoreFocus) => {
                    const input = root.read({ id, value: next }), candidate = prepare(input);
                    root = candidate;
                    fields.replaceChildren(candidate.element);
                    edited();
                    notice.textContent = 'Array edited locally. Review the input before Run; nothing was submitted.';
                    // The old focused button was removed with the form. Use the schema
                    // path, not regenerated IDs or labels, to focus this exact array.
                    if (restoreFocus)
                        candidate.focusArray?.(path, index);
                };
                const add = document.createElement('button');
                add.type = 'button';
                add.textContent = 'Add item';
                add.disabled = rows.length >= Math.min(tools.limits.arrayItems, s.maxItems ?? Infinity);
                add.addEventListener('click', () => {
                    try {
                        if (add.disabled)
                            return;
                        replaceArray([...rows.map(row => row.read()), tools.seed(s.items)], rows.length, document.activeElement === add);
                    }
                    catch (failure) {
                        error(failure);
                    }
                });
                box.append(add);
                box.append(element('p', 'New items contain starter values, not accepted expectations. Use JSON for more than 32 items.'));
                const focusItem = (index) => {
                    if (rows.length)
                        rows[Math.min(index, rows.length - 1)].focus();
                    else if (!add.disabled)
                        add.focus();
                    else {
                        box.tabIndex = -1;
                        box.focus();
                    }
                };
                arrayFocus.set(JSON.stringify(path), focusItem);
                focus = () => focusItem(0);
                read = replace => rows.map(row => row.read(replace));
            }
            else {
                const choices = s.enum ? s.enum.map((option, index) => ({ text: JSON.stringify(option), value: String(index) }))
                    : s.type === 'boolean' ? [{ text: 'true', value: 'true' }, { text: 'false', value: 'false' }] : undefined;
                const control = choices ? document.createElement('select') : s.type === 'string' ? document.createElement('textarea') : document.createElement('input');
                control.id = id;
                if (choices)
                    for (const choice of choices) {
                        const option = document.createElement('option');
                        option.textContent = choice.text;
                        option.value = choice.value;
                        control.append(option);
                    }
                if (control.tagName === 'INPUT') {
                    control.type = 'text';
                    control.inputMode = 'decimal';
                }
                control.setAttribute('autocomplete', 'off');
                control.spellcheck = false;
                control.value = s.enum ? String(s.enum.findIndex(option => option === value)) : s.type === 'string' ? value : JSON.stringify(value);
                if (s.type === 'null')
                    control.disabled = true;
                const initialDisplay = control.value;
                focus = () => {
                    if (!control.disabled)
                        control.focus();
                    else {
                        box.tabIndex = -1;
                        box.focus();
                    }
                };
                const labelElement = element('label', label);
                labelElement.setAttribute('for', id);
                box.append(labelElement);
                box.append(control);
                // Textareas normalize line endings in browsers. An untouched field must retain its original JSON string.
                read = () => control.value === initialDisplay ? value : tools.scalar(s, control.value);
            }
            return { element: box, read: replace => replace?.id === id ? replace.value : read(replace), focus };
        };
        const prepared = build(schema, input, 'Input', []);
        prepared.focusArray = (path, index) => arrayFocus.get(JSON.stringify(path))?.(index);
        return prepared;
    };
    const useFields = () => {
        if (mode === 'fields')
            return;
        const candidate = prepare(tools.parse(json.value));
        root = candidate;
        fields.replaceChildren(candidate.element);
        mode = 'fields';
        modes();
        notice.textContent = 'Edit the sample below. Nothing runs until you choose Run workflow.';
    };
    formButton.addEventListener('click', () => {
        try {
            if (mode === 'fields')
                return;
            useFields();
            staleCorrection = false;
            edited();
        }
        catch (failure) {
            error(failure);
        }
    });
    jsonButton.addEventListener('click', () => {
        try {
            if (mode === 'json')
                return;
            const value = tools.snapshot(root.read());
            json.value = JSON.stringify(value, null, 2);
            mode = 'json';
            modes();
            notice.textContent = 'Edit your input as JSON. Switching editors never runs the workflow.';
            staleCorrection = false;
            edited();
        }
        catch (failure) {
            error(failure);
        }
    });
    try {
        schema = tools.schema(schemaValue);
    }
    catch (failure) {
        formButton.disabled = true;
        error(failure);
    }
    get('input-modes').hidden = false;
    modes();
    if (schema) {
        try {
            useFields();
        }
        catch (failure) {
            error(failure);
        }
    }
    initializing = false;
    return { read() {
            try {
                if (mode === 'json') {
                    const value = tools.parse(json.value);
                    // JSON is a presentation fallback, not a way to skip supported-schema
                    // corrections. Keep the user's exact text, including invalid drafts.
                    if (schema) {
                        tools.validate(schema, value);
                        notice.textContent = 'Input is valid.';
                        staleCorrection = false;
                    }
                    return value;
                }
                const value = tools.validate(schema, root.read());
                json.value = JSON.stringify(value, null, 2);
                notice.textContent = 'Input is valid.';
                staleCorrection = false;
                return value;
            }
            catch (failure) {
                error(failure);
                throw failure;
            }
        }, mode: () => mode };
}
export const inputControlsHtml = `<div id="input-modes" class="live-controls" hidden role="group" aria-label="Input editor mode"><button id="input-use-fields" type="button" aria-pressed="false">Fields</button><button id="input-use-json" type="button" aria-pressed="true">JSON</button></div><p id="input-message" aria-live="polite"></p><div id="input-fields" hidden></div><div id="input-json"><label for="live-input">Sample input (JSON)</label><textarea id="live-input" spellcheck="false" aria-describedby="input-message input-help"></textarea></div><details class="input-help"><summary>How input fields work</summary><p id="input-help">The sample is a starting point; review it before running. Uncheck Include to leave a field out. Leaving a field out is different from sending false, zero, an empty string or null. Required fields must be included. The runtime checks every input before it starts a run. Editing fields or switching to JSON never runs the workflow.</p></details>`;
