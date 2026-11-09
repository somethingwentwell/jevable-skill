// RECONSTRUCTION. The original script is not in the public repository, and no copy was found.
// It is rebuilt from tests/release-backend.spec.ts and the guide format produced by
// src/packages/release-zip.ts and src/releases/commands.ts, and may differ from the original.
//
// These helpers read an exported release app's README.txt the way an operator would, so tests can
// check that the shipped guide matches the real app: its telemetry JSON examples, its command
// reference (between "Command reference" and "End command reference"), and invocations built
// strictly from that reference.

/** Returns the OTLP configuration examples keyed by protocol ('http/protobuf' and 'grpc'). */
export function parseReleaseTelemetryExamples(guide) {
  const examples = {}
  for (const line of guide.split('\n')) {
    if (!line.startsWith('{"protocol":')) continue
    const example = JSON.parse(line)
    if (examples[example.protocol]) throw Error(`Duplicate telemetry example for ${example.protocol}`)
    examples[example.protocol] = example
  }
  for (const protocol of ['http/protobuf', 'grpc'])
    if (!examples[protocol]) throw Error(`Missing ${protocol} telemetry example`)
  return examples
}

const NAME = /^[a-z][a-z0-9-]*$/

/** Returns { command: { positional?, flags: [{ name, type: 'string'|'boolean', required }] } } in guide order. */
export function parseReleaseCommandReference(guide) {
  const start = guide.indexOf('\nCommand reference ')
  const end = guide.indexOf('\nEnd command reference')
  if (start < 0 || end < start) throw Error('Release guide has no command reference section')
  const commands = {}
  for (const line of guide.slice(start, end).split('\n')) {
    if (!line.startsWith('node app.mjs ')) continue
    const tokens = line.slice('node app.mjs '.length).match(/\[[^\]]*\]|<[^>]*>|\S+/g) ?? []
    const name = tokens.shift()
    if (!name || !NAME.test(name)) throw Error(`Invalid command name in reference: ${line}`)
    if (commands[name]) throw Error(`Duplicate command in reference: ${name}`)
    commands[name] = parseUsage(tokens, line)
  }
  if (!Object.keys(commands).length) throw Error('Release command reference lists no commands')
  return commands
}

// Tokens: optional leading <positional>, then "--flag <value>" (two tokens), "--flag",
// "[--flag <value>]" or "[--flag]". Anything else (for example ";unsafe") is refused.
function parseUsage(tokens, line) {
  const spec = { flags: [] }
  let index = 0
  if (/^<[a-z][a-z0-9.-]*>$/.test(tokens[0] ?? '')) { spec.positional = tokens[0].slice(1, -1); index = 1 }
  while (index < tokens.length) {
    const token = tokens[index]
    const optional = token.startsWith('[') && token.endsWith(']')
    const inner = optional ? token.slice(1, -1) : token
    let match = /^--([a-z][a-z0-9-]*)( <value>)?$/.exec(inner)
    if (match && !optional && !match[2] && tokens[index + 1] === '<value>') { match = [inner, match[1], ' <value>']; index++ }
    if (!match) throw Error(`Unexpected token ${JSON.stringify(token)} in reference: ${line}`)
    if (spec.flags.some(existing => existing.name === match[1])) throw Error(`Duplicate flag --${match[1]}: ${line}`)
    spec.flags.push({ name: match[1], type: match[2] ? 'string' : 'boolean', required: !optional })
    index++
  }
  return spec
}

/**
 * Builds argv for `command` from the guide's reference. `values` maps the positional name and flag names
 * to values (true for boolean flags). Unknown names and missing required values throw.
 */
export function releaseGuideInvocation(guide, command, values = {}) {
  const spec = parseReleaseCommandReference(guide)[command]
  if (!spec) throw Error(`Command not in release guide: ${command}`)
  const known = new Set([...(spec.positional ? [spec.positional] : []), ...spec.flags.map(flag => flag.name)])
  for (const name of Object.keys(values)) if (!known.has(name)) throw Error(`${command} does not accept ${name}`)
  const argv = [command]
  if (spec.positional) {
    if (values[spec.positional] === undefined) throw Error(`${command} requires <${spec.positional}>`)
    argv.push(String(values[spec.positional]))
  }
  for (const flag of spec.flags) {
    const value = values[flag.name]
    if (value === undefined || value === false) { if (flag.required) throw Error(`${command} requires --${flag.name}`); continue }
    if (flag.type === 'boolean') { if (value !== true) throw Error(`--${flag.name} is a boolean flag`); argv.push('--' + flag.name) }
    else argv.push('--' + flag.name, String(value))
  }
  return argv
}
